import { Router, Request, Response } from "express";
import { prisma } from "../index";
import { logger } from "../utils/logger";
import { SIMULATION_MODE, REALITY_CHECK_ENABLED } from "../config/mode";
import { DEMO_PROJECTS, persistData, addSimProject } from "../data/simStore";
import { createNotification, SIM_NOTIFICATIONS } from "../data/governance";
import { SIM_PROVIDERS } from "../data/providers";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

/**
 * GET /api/projects
 * Get all projects with optional filters
 */
router.get("/", async (req: Request, res: Response) => {
  const { status, category, planner } = req.query;
  try {

    const where: any = {};
    if (status) where.status = status;
    if (category) where.category = category;
    if (planner) where.plannerId = planner;

    const projects = await prisma.project.findMany({
      where,
      include: {
        planner: {
          select: {
            id: true,
            walletAddress: true,
            role: true,
          },
        },
        milestones: {
          select: {
            id: true,
            title: true,
            status: true,
            fundingPercentage: true,
          },
        },
        _count: {
          select: {
            investments: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({ projects });
  } catch (error: any) {
    if (SIMULATION_MODE()) {
      logger.warn("DB unavailable — returning demo projects (simulation mode)");
      let filtered = DEMO_PROJECTS as any[];
      if (planner) filtered = filtered.filter(p => p.planner?.id === planner);
      if (status) filtered = filtered.filter(p => p.status === status);
      if (category) filtered = filtered.filter(p => p.category === category);
      return res.json({ projects: filtered });
    }
    logger.error("Failed to fetch projects", { error: error.message });
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

/**
 * GET /api/projects/:id
 * Get project details
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        planner: {
          select: {
            id: true,
            walletAddress: true,
            role: true,
          },
        },
        milestones: {
          orderBy: { createdAt: "asc" },
        },
        investments: {
          include: {
            investor: {
              select: {
                id: true,
                walletAddress: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
        telemetry: {
          orderBy: { timestamp: "desc" },
          take: 50,
        },
        reports: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
      },
    });

    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    res.json({ project });
  } catch (error: any) {
    if (SIMULATION_MODE()) {
      const demo = DEMO_PROJECTS.find((p) => p.id === req.params.id) || DEMO_PROJECTS[0];
      logger.warn("DB unavailable — returning demo project (simulation mode)");
      return res.json({ project: demo });
    }
    logger.error("Failed to fetch project", { error: error.message, id: req.params.id });
    res.status(500).json({ error: "Failed to fetch project" });
  }
});

/**
 * POST /api/projects
 * Create a new project
 */
router.post("/", async (req: Request, res: Response) => {
  const {
    plannerId,
    title,
    summary,
    category,
    fundingGoal,
    metadataURI,
    aiGenerated,
    aiBlueprint,
    milestones,
    serviceSlots,
  } = req.body;

  // Simulation mode — skip DB entirely, return mock project
  if (SIMULATION_MODE()) {
    const ts = Date.now();
    const createdMilestones = (milestones || []).map((m: any, i: number) => ({
      id: `sim-m-${ts}-${i}`,
      title: m.title,
      description: m.description,
      fundingPercentage: m.fundingPercentage,
      durationDays: m.durationDays,
      status: "PENDING",
    }));
    // serviceSlots.milestoneId is the milestone title from the frontend select
    const resolvedRoles = (serviceSlots || []).map((s: any, i: number) => {
      const linked = createdMilestones.find((m: any) => m.title === s.milestoneId);
      return {
        id: `sim-slot-${ts}-${i}`,
        role: s.role,
        description: s.description || '',
        milestoneId: linked?.id ?? null,
      };
    });
    // When Reality Check is enabled, a freshly created project sits in
    // REALITY_CHECK_PENDING and CANNOT take investments until the
    // /api/reality-check/:projectId/run pass completes (transitioning the
    // project to PENDING or REALITY_CHECK_ADJUST). See realityCheck.ts.
    const initialStatus = REALITY_CHECK_ENABLED() ? "REALITY_CHECK_PENDING" : "PENDING";
    const mockProject = {
      id: `sim-${ts}`,
      title,
      summary,
      category: category || "community",
      status: initialStatus,
      fundingGoal: fundingGoal || "10000000000000000000000",
      fundingRaised: "0",
      createdAt: new Date(),
      updatedAt: new Date(),
      planner: { id: plannerId || "sim-user", walletAddress: "0xsimulated", role: "PLANNER" },
      milestones: createdMilestones,
      investments: [],
      telemetry: [],
      reports: [],
      requiredRoles: resolvedRoles,
      _count: { investments: 0 },
      aiGenerated: aiGenerated || false,
      aiBlueprint: aiBlueprint || null,
    };
    // Inject into in-memory demo list and persist so it survives restarts
    addSimProject(mockProject as any);
    logger.info("Simulation mode — mock project created", { title });

    // Notify providers whose services match any required role
    if (resolvedRoles?.length > 0) {
      for (const provider of SIM_PROVIDERS) {
        const providerServices = (provider as any).services ?? [];
        const matchedRole = resolvedRoles.find((role: any) =>
          providerServices.some((svc: any) =>
            svc.name?.toLowerCase().includes(role.role?.toLowerCase().split(' ')[0]) ||
            role.role?.toLowerCase().includes(svc.category?.toLowerCase())
          )
        );
        if (matchedRole && (provider as any).userId) {
          createNotification({
            userId: (provider as any).userId,
            type: 'JOB_MATCH',
            title: `New job match: ${matchedRole.role}`,
            body: `"${title}" needs a ${matchedRole.role}. ${matchedRole.description?.slice(0, 80)}`,
            projectId: mockProject.id,
          });
        }
      }
    }

    return res.status(201).json({ project: mockProject });
  }

  try {
    // Validate required fields
    if (!plannerId || !title || !summary || !fundingGoal || !metadataURI) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check if user exists and has planner role
    const user = await prisma.user.findUnique({
      where: { id: plannerId },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!user.verified) {
      return res.status(403).json({ error: "User not verified" });
    }

    // Create project
    const project = await prisma.project.create({
      data: {
        plannerId,
        title,
        summary,
        category: category || "community",
        fundingGoal,
        metadataURI,
        aiGenerated: aiGenerated || false,
        aiBlueprint: aiBlueprint || null,
        status: "PENDING",
        chainId: parseInt(process.env.CHAIN_ID || "31337"),
        contractId: 0, // Will be updated when created on-chain
      },
    });

    // Create milestones if provided
    if (milestones && Array.isArray(milestones)) {
      for (const milestone of milestones) {
        await prisma.milestone.create({
          data: {
            projectId: project.id,
            title: milestone.title,
            description: milestone.description,
            fundingPercentage: milestone.fundingPercentage,
            durationDays: milestone.durationDays,
            status: "PENDING",
          },
        });
      }
    }

    logger.info("Project created", { projectId: project.id, title: project.title });

    res.status(201).json({ project });
  } catch (error: any) {
    logger.error("Failed to create project", { error: error.message });
    res.status(500).json({ error: "Failed to create project" });
  }
});

/**
 * PATCH /api/projects/:id
 * Edit a project — only the creator (planner) may do this.
 * Accepts: title, summary, category, milestones (full replace), requiredRoles (full replace)
 */
router.patch("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;
  const { title, summary, category, milestones, requiredRoles } = req.body;

  if (SIMULATION_MODE()) {
    const project = DEMO_PROJECTS.find(p => p.id === id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (project.planner.id !== userId) return res.status(403).json({ error: "Only the project creator can edit this project" });

    if (title !== undefined) project.title = title;
    if (summary !== undefined) project.summary = summary;
    if (category !== undefined) project.category = category;
    project.updatedAt = new Date();

    if (Array.isArray(milestones)) {
      const ts = Date.now();
      project.milestones = milestones.map((m: any, i: number) => ({
        id: m.id || `sim-m-${ts}-${i}`,
        title: m.title,
        description: m.description,
        fundingPercentage: m.fundingPercentage,
        durationDays: m.durationDays,
        status: m.status || "PENDING",
      }));
    }

    if (Array.isArray(requiredRoles)) {
      const ts = Date.now();
      project.requiredRoles = requiredRoles.map((r: any, i: number) => {
        // milestoneId may be a title (from frontend select) or already an id — resolve either
        const linked = project.milestones.find((m: any) => m.title === r.milestoneId || m.id === r.milestoneId);
        return {
          id: r.id || `sim-slot-${ts}-${i}`,
          role: r.role,
          description: r.description || '',
          milestoneId: linked?.id ?? r.milestoneId ?? null,
        };
      });
    }

    persistData();
    logger.info("Simulation mode — project updated", { id, title: project.title });
    return res.json({ project });
  }

  try {
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (project.plannerId !== userId) return res.status(403).json({ error: "Only the project creator can edit this project" });

    const updated = await prisma.project.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(summary !== undefined && { summary }),
        ...(category !== undefined && { category }),
      },
    });
    res.json({ project: updated });
  } catch (error: any) {
    logger.error("Failed to update project", { error: error.message });
    res.status(500).json({ error: "Failed to update project" });
  }
});

/**
 * POST /api/projects/:id/invest
 * Record an investment (after on-chain transaction)
 */
router.post("/:id/invest", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { investorId, amount, txHash } = req.body;

    if (!investorId || !amount || !txHash) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check if project exists
    const project = await prisma.project.findUnique({
      where: { id },
    });

    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    // Check for duplicate transaction
    const existingInvestment = await prisma.investment.findUnique({
      where: { txHash },
    });

    if (existingInvestment) {
      return res.status(400).json({ error: "Investment already recorded" });
    }

    // Record investment
    const investment = await prisma.investment.create({
      data: {
        projectId: id,
        investorId,
        amount,
        txHash,
        chainId: parseInt(process.env.CHAIN_ID || "31337"),
      },
    });

    logger.info("Investment recorded", {
      projectId: id,
      investorId,
      amount,
      txHash,
    });

    res.status(201).json({ investment });
  } catch (error: any) {
    logger.error("Failed to record investment", { error: error.message });
    res.status(500).json({ error: "Failed to record investment" });
  }
});

/**
 * POST /api/projects/:id/milestone/submit
 * Submit milestone evidence
 */
router.post("/:id/milestone/submit", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { milestoneId, evidenceURI } = req.body;

    if (!milestoneId || !evidenceURI) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Update milestone
    const milestone = await prisma.milestone.update({
      where: { id: milestoneId },
      data: {
        status: "SUBMITTED",
        evidenceURI,
        submittedAt: new Date(),
      },
    });

    logger.info("Milestone submitted", { projectId: id, milestoneId, evidenceURI });

    res.json({ milestone });
  } catch (error: any) {
    logger.error("Failed to submit milestone", { error: error.message });
    res.status(500).json({ error: "Failed to submit milestone" });
  }
});

export default router;
