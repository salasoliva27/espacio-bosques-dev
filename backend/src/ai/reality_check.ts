/**
 * Reality Check — pre-funding budget verification gate.
 *
 * Runs a second Claude pass on a project blueprint to compare the proposer's
 * estimated budget against typical Mexican-market reference prices, line by
 * line, and to flag scope items that a project of this type usually includes
 * but the blueprint omits (permits, insurance, maintenance, SAT withholdings,
 * contingency).
 *
 * Phase 1 (this file): uses the model's training-data knowledge to produce
 * benchmark ranges. There is no live web-search tool wired into the codebase
 * yet, so confidence scores are deliberately conservative.
 * Phase 2 (deferred): swap the LLM call for tool use with a real web-search
 * provider so benchmarks are grounded in current pricing.
 */
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../utils/logger";
import projectConfig from "../../../config/project-config.json";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });

export interface RealityCheckBlueprintInput {
  title: string;
  summary: string;
  category: string;
  estimatedBudgetMXN: number;
  budgetJustification?: string;
  monthlyMaintenanceMXN?: number | null;
  milestones: { title: string; description: string; fundingPercentage: number; durationDays: number }[];
}

export interface RealityCheckLineItem {
  lineLabel: string;
  milestoneTitle?: string;
  proposerEstimateMxn: number;
  benchmarkLowMxn: number | null;
  benchmarkHighMxn: number | null;
  confidence: number; // 0..1
  sources: { url: string; title: string; snippet: string; priceObserved: number | null }[];
  notes: string;
}

export interface RealityCheckScopeGapItem {
  category: "permits" | "insurance" | "maintenance" | "iva_retencion" | "contingency" | "other";
  label: string;
  typicalAmountMxn: number | null;
  reasoning: string;
}

export interface RealityCheckLLMResponse {
  items: RealityCheckLineItem[];
  missingItems: RealityCheckScopeGapItem[];
  overallConfidence: number; // 0..1
  notes: string;
}

const SYSTEM_PROMPT = `You are a budget reviewer for "Espacio Bosques", a community-funded
infrastructure platform for residents of Bosques de las Lomas, an upscale
residential neighbourhood in Mexico City (CDMX). Your job is to keep proposers
honest: the proposer's estimated budget must be confronted against typical
Mexican-market reference prices BEFORE the project opens for funding from
neighbours.

Given a project blueprint (title, summary, category, milestones, estimated
total budget in Mexican pesos), do the following:

1. Break the project into ATOMIC LINE ITEMS that a contractor would actually
   bill for (e.g. "12 PoE security cameras + cloud recording", "Conduit
   installation 400 m", "2-year maintenance contract"). Estimate each line
   item's proposer-implied amount in MXN by allocating their stated budget
   proportionally across line items based on what is typical for that work.

2. For each line item, return a Mexican-market BENCHMARK RANGE (low / high MXN)
   based on what comparable work typically costs in CDMX. If you don't have
   sufficient grounding to estimate a range, set both to null and a confidence
   score under 0.5 — DO NOT invent prices.

3. Return a CONFIDENCE score 0..1 per line item. Anything below 0.5 means the
   platform will escalate that line to community-expert reviewers.

4. Identify MISSING ITEMS the blueprint omits but a project of this type
   normally requires: CDMX municipal permits, INAI data-privacy registration
   (for camera/data projects), insurance, ongoing maintenance, SAT IVA
   retentions, contingency reserve. For each, include a typical Mexican peso
   amount when you can confidently give one.

5. Return ONE OVERALL CONFIDENCE score 0..1 for the whole pass.

Respond with ONE JSON object (no prose, no markdown fences) matching exactly:
{
  "items": [
    {
      "lineLabel": "string (short, contractor-billable)",
      "milestoneTitle": "string (must match one of the input milestone titles, or null)",
      "proposerEstimateMxn": number,
      "benchmarkLowMxn": number | null,
      "benchmarkHighMxn": number | null,
      "confidence": number (0..1),
      "sources": [],
      "notes": "string (one short sentence on the assumptions)"
    }
  ],
  "missingItems": [
    {
      "category": "permits" | "insurance" | "maintenance" | "iva_retencion" | "contingency" | "other",
      "label": "string",
      "typicalAmountMxn": number | null,
      "reasoning": "string (one sentence on why this matters for THIS project)"
    }
  ],
  "overallConfidence": number (0..1),
  "notes": "string (one paragraph: top-line read on whether the budget is realistic)"
}

Rules:
- All amounts are in Mexican pesos (MXN), never USD.
- Be conservative with benchmarks. If unsure, lower confidence — don't guess.
- The "sources" array is always [] in this version (no live web search yet).
- The sum of items[].proposerEstimateMxn SHOULD equal the project's
  estimatedBudgetMXN (give or take rounding). The platform validates this.`;

export async function runRealityCheck(
  blueprint: RealityCheckBlueprintInput,
  retries = 2
): Promise<{ response: RealityCheckLLMResponse; model: string; raw: string }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  if (!projectConfig.ai.realityCheck?.enabled) {
    throw new Error("Reality Check is disabled in project-config.json");
  }

  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

  const userMessage = `Project blueprint to review:

Title: ${blueprint.title}
Category: ${blueprint.category}
Proposer's estimated total budget: ${blueprint.estimatedBudgetMXN.toLocaleString("en-US")} MXN
${blueprint.budgetJustification ? `Proposer's justification: ${blueprint.budgetJustification}\n` : ""}${
  blueprint.monthlyMaintenanceMXN
    ? `Proposer's monthly maintenance estimate: ${blueprint.monthlyMaintenanceMXN.toLocaleString("en-US")} MXN/month\n`
    : ""
}
Summary:
${blueprint.summary}

Milestones:
${blueprint.milestones
  .map(
    (m, i) =>
      `  ${i + 1}. ${m.title} (${m.fundingPercentage}% · ${m.durationDays} days)\n     ${m.description}`
  )
  .join("\n")}

Return the JSON object as specified.`;

  try {
    logger.info("[reality-check] Calling Anthropic", { title: blueprint.title, model });

    const message = await anthropic.messages.create({
      model,
      max_tokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS || "4096"),
      temperature: 0.2,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Anthropic returned no text content");
    }
    let raw = textBlock.text.trim();
    if (raw.startsWith("```json")) raw = raw.replace(/```json\n?/, "").replace(/\n?```$/, "");
    else if (raw.startsWith("```")) raw = raw.replace(/```\n?/, "").replace(/\n?```$/, "");

    const parsed = JSON.parse(raw) as RealityCheckLLMResponse;
    validateLLMResponse(parsed);

    logger.info("[reality-check] response received", {
      items: parsed.items.length,
      missing: parsed.missingItems.length,
      overall: parsed.overallConfidence,
    });

    return { response: parsed, model, raw };
  } catch (error: any) {
    logger.error("[reality-check] failed", { error: error.message });
    if (retries > 0 && (error.status >= 500 || error instanceof SyntaxError)) {
      const delay = (3 - retries) * 1000;
      await new Promise((r) => setTimeout(r, delay));
      return runRealityCheck(blueprint, retries - 1);
    }
    throw new Error(`Reality Check failed: ${error.message}`);
  }
}

function validateLLMResponse(r: any): asserts r is RealityCheckLLMResponse {
  if (!r || typeof r !== "object") throw new Error("Reality Check: response is not an object");
  if (!Array.isArray(r.items)) throw new Error("Reality Check: items[] missing");
  if (!Array.isArray(r.missingItems)) throw new Error("Reality Check: missingItems[] missing");
  if (typeof r.overallConfidence !== "number" || r.overallConfidence < 0 || r.overallConfidence > 1) {
    throw new Error("Reality Check: invalid overallConfidence");
  }
  r.items.forEach((it: any, i: number) => {
    if (!it.lineLabel || typeof it.lineLabel !== "string") throw new Error(`item ${i + 1}: lineLabel`);
    if (typeof it.proposerEstimateMxn !== "number" || it.proposerEstimateMxn < 0) {
      throw new Error(`item ${i + 1}: proposerEstimateMxn`);
    }
    if (it.benchmarkLowMxn !== null && typeof it.benchmarkLowMxn !== "number") {
      throw new Error(`item ${i + 1}: benchmarkLowMxn must be number or null`);
    }
    if (it.benchmarkHighMxn !== null && typeof it.benchmarkHighMxn !== "number") {
      throw new Error(`item ${i + 1}: benchmarkHighMxn must be number or null`);
    }
    if (typeof it.confidence !== "number" || it.confidence < 0 || it.confidence > 1) {
      throw new Error(`item ${i + 1}: confidence must be 0..1`);
    }
    if (!Array.isArray(it.sources)) it.sources = [];
  });
  r.missingItems.forEach((m: any, i: number) => {
    if (!m.label || typeof m.label !== "string") throw new Error(`missingItem ${i + 1}: label`);
    if (!m.category || typeof m.category !== "string") throw new Error(`missingItem ${i + 1}: category`);
  });
}

/**
 * Pure helpers — testable without an LLM round-trip.
 */

export interface ThresholdResult {
  deltaPct: number | null;
  exceedsThreshold: boolean;
  benchmarkMidpoint: number | null;
}

export function computeDelta(
  proposerEstimateMxn: number,
  benchmarkLowMxn: number | null,
  benchmarkHighMxn: number | null,
  threshold: number = projectConfig.ai.realityCheck.deltaThreshold
): ThresholdResult {
  if (benchmarkLowMxn === null || benchmarkHighMxn === null) {
    return { deltaPct: null, exceedsThreshold: false, benchmarkMidpoint: null };
  }
  const midpoint = (benchmarkLowMxn + benchmarkHighMxn) / 2;
  if (midpoint === 0) return { deltaPct: null, exceedsThreshold: false, benchmarkMidpoint: 0 };
  const delta = (proposerEstimateMxn - midpoint) / midpoint;
  return {
    deltaPct: Math.round(delta * 10000) / 100, // two decimal places, percentage
    exceedsThreshold: Math.abs(delta) > threshold,
    benchmarkMidpoint: midpoint,
  };
}

export function aggregateOutcome(
  itemResults: ThresholdResult[],
  overallConfidence: number
): { state: "pass" | "adjust_required"; reason: string } {
  const lowConfidenceFloor = projectConfig.ai.realityCheck.lowConfidenceThreshold;
  if (overallConfidence < lowConfidenceFloor) {
    // In Phase 1 (no Layer 3 yet) we treat low confidence as "needs proposer
    // attention" so the proposer sees the warning instead of silently
    // publishing. Layer 3 (community-expert escalation) will refine this.
    return { state: "adjust_required", reason: "low_confidence" };
  }
  const hasExceeded = itemResults.some((r) => r.exceedsThreshold);
  if (hasExceeded) return { state: "adjust_required", reason: "delta_exceeded" };
  return { state: "pass", reason: "within_threshold" };
}
