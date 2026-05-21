/**
 * /api/reality-check/* — pre-funding budget verification gate.
 *
 * Flow:
 *   1. Project is created via POST /api/projects. If REALITY_CHECK_ENABLED is
 *      true, projects.ts sets the project status to REALITY_CHECK_PENDING.
 *   2. The frontend calls POST /api/reality-check/:projectId/run to fire the
 *      LLM-backed market-rate pass. The project may transition to:
 *        - PENDING (pass; open for funding), or
 *        - REALITY_CHECK_ADJUST (proposer must accept the adjustment or
 *          justify the divergence).
 *   3. The proposer interacts via POST /accept-adjustment or POST /justify
 *      until the project reaches PENDING.
 *
 * Layer 3 (community-expert escalation) is intentionally not implemented in
 * this PR — see janus-ia/dump/espacio-bosques-reality-check-spec.md.
 */
import { Router, Response } from "express";
import { logger } from "../utils/logger";
import { SIMULATION_MODE, REALITY_CHECK_ENABLED } from "../config/mode";
import { requireAuth, AuthRequest } from "../middleware/auth";
import {
  DEMO_PROJECTS,
  persistData,
  getRealityCheck,
  putRealityCheck,
  SimRealityCheck,
  RealityCheckItem,
} from "../data/simStore";
import { createNotification } from "../data/governance";
import { runRealityCheck, computeDelta, aggregateOutcome } from "../ai/reality_check";
import { queueLegalReviewForProject } from "./legalReview";
import projectConfig from "../../../config/project-config.json";

const router = Router();

/**
 * Where the project goes after Reality Check passes. If legal review is
 * enabled (default), the project moves to LEGAL_REVIEW_PENDING and a legal
 * review record is queued for lawyers. Otherwise it goes straight to
 * PENDING (open for funding).
 */
function exitRealityCheckPass(project: any): { status: string; nextStep: string } {
  const legalEnabled = (projectConfig as any).ai?.legal?.enabled !== false;
  if (legalEnabled) {
    queueLegalReviewForProject(project);
    project.status = "LEGAL_REVIEW_PENDING";
    return { status: "LEGAL_REVIEW_PENDING", nextStep: "legal_review" };
  }
  project.status = "PENDING";
  return { status: "PENDING", nextStep: "open_for_funding" };
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ── GET /api/reality-check/:projectId ───────────────────────────── */
router.get("/:projectId", async (req: AuthRequest, res: Response) => {
  const { projectId } = req.params;
  const check = getRealityCheck(projectId);
  const project = DEMO_PROJECTS.find((p) => p.id === projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });
  return res.json({
    enabled: REALITY_CHECK_ENABLED(),
    project: { id: project.id, title: project.title, status: project.status },
    check,
  });
});

/* ── POST /api/reality-check/:projectId/run ─────────────────────── */
router.post("/:projectId/run", requireAuth, async (req: AuthRequest, res: Response) => {
  const { projectId } = req.params;
  if (!REALITY_CHECK_ENABLED()) {
    return res.status(400).json({ error: "Reality Check is disabled in this environment" });
  }
  if (!SIMULATION_MODE()) {
    // Real-DB path is not yet wired — Phase 2.
    return res.status(501).json({ error: "Reality Check real-DB path not yet implemented" });
  }

  const project = DEMO_PROJECTS.find((p) => p.id === projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.planner.id !== req.user!.id) {
    return res.status(403).json({ error: "Only the project creator can run Reality Check" });
  }
  if (project.status !== "REALITY_CHECK_PENDING" && project.status !== "REALITY_CHECK_ADJUST") {
    return res.status(409).json({
      error: `Project is in state '${project.status}' — Reality Check only runs from REALITY_CHECK_PENDING or REALITY_CHECK_ADJUST`,
    });
  }

  // Build the blueprint input from the stored project.
  const aiBlueprint = (project as any).aiBlueprint as
    | undefined
    | { estimatedBudgetMXN?: number; budgetJustification?: string; monthlyMaintenanceMXN?: number };
  const totalMxnFromGoal = approximateMxnFromWei(project.fundingGoal);
  const estimatedBudgetMXN = aiBlueprint?.estimatedBudgetMXN ?? totalMxnFromGoal;

  try {
    const { response, model, raw } = await runRealityCheck({
      title: project.title,
      summary: project.summary,
      category: project.category,
      estimatedBudgetMXN,
      budgetJustification: aiBlueprint?.budgetJustification,
      monthlyMaintenanceMXN: aiBlueprint?.monthlyMaintenanceMXN ?? null,
      milestones: project.milestones.map((m) => ({
        title: m.title,
        description: m.description,
        fundingPercentage: m.fundingPercentage,
        durationDays: m.durationDays,
      })),
    });

    // Compose stored Reality Check + items.
    const existing = getRealityCheck(projectId);
    const checkId = existing?.id ?? newId("rc");
    const revision = (existing?.revision ?? 0) + 1;

    const items: RealityCheckItem[] = response.items.map((it, idx) => {
      const delta = computeDelta(it.proposerEstimateMxn, it.benchmarkLowMxn, it.benchmarkHighMxn);
      return {
        id: newId(`rci-${idx}`),
        realityCheckId: checkId,
        milestoneTitle: it.milestoneTitle,
        lineLabel: it.lineLabel,
        proposerEstimateMxn: it.proposerEstimateMxn,
        benchmarkLowMxn: it.benchmarkLowMxn,
        benchmarkHighMxn: it.benchmarkHighMxn,
        benchmarkMidpointMxn: delta.benchmarkMidpoint,
        finalAmountMxn: it.proposerEstimateMxn, // initial; updated on accept/justify
        deltaPct: delta.deltaPct,
        confidence: it.confidence,
        sources: it.sources,
        proposerJustification: null,
        proposerEvidenceUrls: [],
        flaggedMissing: false,
        missingCategory: null,
      };
    });

    // Append the LLM's missing-items list as flagged scope-gap rows.
    response.missingItems.forEach((m, idx) => {
      items.push({
        id: newId(`rci-miss-${idx}`),
        realityCheckId: checkId,
        lineLabel: m.label,
        proposerEstimateMxn: 0,
        benchmarkLowMxn: m.typicalAmountMxn,
        benchmarkHighMxn: m.typicalAmountMxn,
        benchmarkMidpointMxn: m.typicalAmountMxn,
        finalAmountMxn: 0,
        deltaPct: null,
        confidence: 1,
        sources: [],
        proposerJustification: null,
        proposerEvidenceUrls: [],
        flaggedMissing: true,
        missingCategory: (m.category as any) ?? "other",
      });
    });

    const itemThresholds = response.items.map((it) =>
      computeDelta(it.proposerEstimateMxn, it.benchmarkLowMxn, it.benchmarkHighMxn)
    );
    const outcome = aggregateOutcome(itemThresholds, response.overallConfidence);

    const proposerTotal = items.filter((i) => !i.flaggedMissing).reduce((s, i) => s + i.proposerEstimateMxn, 0);
    const benchmarkLow = items
      .filter((i) => !i.flaggedMissing && i.benchmarkLowMxn !== null)
      .reduce((s, i) => s + (i.benchmarkLowMxn ?? 0), 0);
    const benchmarkHigh = items
      .filter((i) => !i.flaggedMissing && i.benchmarkHighMxn !== null)
      .reduce((s, i) => s + (i.benchmarkHighMxn ?? 0), 0);

    const stored: SimRealityCheck = {
      id: checkId,
      projectId,
      revision,
      state: outcome.state,
      layer1CompletedAt: new Date().toISOString(),
      layer1Confidence: response.overallConfidence,
      layer1Model: model,
      layer1RawResponse: { llmText: raw, parsed: response, outcome },
      proposerTotalMxn: proposerTotal,
      finalTotalMxn: proposerTotal,
      benchmarkTotalLowMxn: benchmarkLow,
      benchmarkTotalHighMxn: benchmarkHigh,
      items,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    putRealityCheck(stored);

    // Update project status.
    if (outcome.state === "pass") {
      const exit = exitRealityCheckPass(project);
      project.updatedAt = new Date();
      persistData();
      createNotification({
        userId: project.planner.id,
        type: "REALITY_CHECK_PASSED" as any,
        title: "Reality Check aprobado",
        body: exit.nextStep === "legal_review"
          ? `Tu proyecto "${project.title}" pasa ahora a revisión legal por un abogado verificado.`
          : `Tu proyecto "${project.title}" ya está abierto a financiamiento.`,
        projectId: project.id,
      });
    } else {
      project.status = "REALITY_CHECK_ADJUST";
      project.updatedAt = new Date();
      persistData();
      createNotification({
        userId: project.planner.id,
        type: "REALITY_CHECK_REQUIRES_ADJUSTMENT" as any,
        title: "Reality Check: ajustes pendientes",
        body: `Tu proyecto "${project.title}" requiere justificar o ajustar el monto antes de salir a recaudar.`,
        projectId: project.id,
      });
    }

    return res.json({ ok: true, check: stored, project: { id: project.id, status: project.status } });
  } catch (err: any) {
    logger.error("[reality-check] run failed", { error: err.message, projectId });
    return res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/reality-check/:projectId/accept-adjustment ─────── */
router.post("/:projectId/accept-adjustment", requireAuth, async (req: AuthRequest, res: Response) => {
  const { projectId } = req.params;
  const check = getRealityCheck(projectId);
  const project = DEMO_PROJECTS.find((p) => p.id === projectId);
  if (!project || !check) return res.status(404).json({ error: "Project or check not found" });
  if (project.planner.id !== req.user!.id) {
    return res.status(403).json({ error: "Only the project creator can accept" });
  }
  if (check.state !== "adjust_required") {
    return res.status(409).json({ error: `Check is in state '${check.state}'` });
  }

  // For each item that has a benchmark midpoint, snap the final amount to it.
  for (const item of check.items) {
    if (item.flaggedMissing) continue;
    if (item.benchmarkMidpointMxn !== null) {
      item.finalAmountMxn = item.benchmarkMidpointMxn;
    }
  }
  check.state = "pass";
  check.finalTotalMxn = check.items
    .filter((i) => !i.flaggedMissing)
    .reduce((s, i) => s + i.finalAmountMxn, 0);
  putRealityCheck(check);

  const exit = exitRealityCheckPass(project);
  project.updatedAt = new Date();
  persistData();
  createNotification({
    userId: project.planner.id,
    type: "REALITY_CHECK_PASSED" as any,
    title: "Reality Check aprobado",
    body: exit.nextStep === "legal_review"
      ? `Aceptaste el ajuste de mercado. "${project.title}" pasa ahora a revisión legal.`
      : `Aceptaste el ajuste de mercado. "${project.title}" está abierto a financiamiento.`,
    projectId: project.id,
  });

  return res.json({ ok: true, check, project: { id: project.id, status: project.status } });
});

/* ── POST /api/reality-check/:projectId/justify ────────────────── */
// Body: { items: [{ id, finalAmountMxn?, justification, evidenceUrls? }] }
router.post("/:projectId/justify", requireAuth, async (req: AuthRequest, res: Response) => {
  const { projectId } = req.params;
  const check = getRealityCheck(projectId);
  const project = DEMO_PROJECTS.find((p) => p.id === projectId);
  if (!project || !check) return res.status(404).json({ error: "Project or check not found" });
  if (project.planner.id !== req.user!.id) {
    return res.status(403).json({ error: "Only the project creator can justify" });
  }
  if (check.state !== "adjust_required") {
    return res.status(409).json({ error: `Check is in state '${check.state}'` });
  }
  const updates = Array.isArray(req.body.items) ? req.body.items : [];
  if (updates.length === 0) {
    return res.status(400).json({ error: "items[] required" });
  }

  for (const u of updates) {
    const item = check.items.find((i) => i.id === u.id);
    if (!item) continue;
    if (typeof u.finalAmountMxn === "number" && u.finalAmountMxn >= 0) {
      item.finalAmountMxn = u.finalAmountMxn;
    }
    if (typeof u.justification === "string") {
      item.proposerJustification = u.justification.trim() || null;
    }
    if (Array.isArray(u.evidenceUrls)) {
      item.proposerEvidenceUrls = u.evidenceUrls.filter((v: unknown) => typeof v === "string");
    }
  }

  // For each line that still exceeds threshold, require BOTH a justification
  // AND a finalAmount (the proposer can keep their number, but they have to
  // own it on the record).
  const stillUnresolved = check.items
    .filter((i) => !i.flaggedMissing)
    .filter((i) => {
      if (i.benchmarkMidpointMxn === null) return false;
      const delta = computeDelta(i.finalAmountMxn, i.benchmarkLowMxn, i.benchmarkHighMxn);
      if (!delta.exceedsThreshold) return false;
      return !i.proposerJustification || i.proposerJustification.length < 10;
    });

  if (stillUnresolved.length > 0) {
    check.finalTotalMxn = check.items
      .filter((i) => !i.flaggedMissing)
      .reduce((s, i) => s + i.finalAmountMxn, 0);
    putRealityCheck(check);
    return res.status(400).json({
      error: "Some items still exceed the threshold without a justification",
      unresolved: stillUnresolved.map((i) => ({ id: i.id, lineLabel: i.lineLabel })),
      check,
    });
  }

  check.state = "pass";
  check.finalTotalMxn = check.items
    .filter((i) => !i.flaggedMissing)
    .reduce((s, i) => s + i.finalAmountMxn, 0);
  putRealityCheck(check);

  const exit2 = exitRealityCheckPass(project);
  project.updatedAt = new Date();
  persistData();
  createNotification({
    userId: project.planner.id,
    type: "REALITY_CHECK_PASSED" as any,
    title: "Reality Check aprobado",
    body: exit2.nextStep === "legal_review"
      ? `Tus justificaciones fueron registradas. "${project.title}" pasa ahora a revisión legal.`
      : `Tus justificaciones fueron registradas. "${project.title}" está abierto a financiamiento.`,
    projectId: project.id,
  });

  return res.json({ ok: true, check, project: { id: project.id, status: project.status } });
});

/** Approximate MXN value from a wei-string. The sim store stores fundingGoal
 *  in wei; we keep one MXN-per-ETH rate aligned with simStore.ts. */
function approximateMxnFromWei(wei: string): number {
  const ETH_MXN = 65000;
  const eth = Number(BigInt(wei)) / 1e18;
  return Math.round(eth * ETH_MXN);
}

export default router;
