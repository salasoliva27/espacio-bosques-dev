/**
 * /api/test/* — Simulation-mode test harness.
 *
 * NEVER mounted in production. Only active when SIMULATION_MODE=true.
 *
 * Endpoints:
 *   GET  /api/test              → list all endpoints with usage
 *   GET  /api/test/state        → dump simStore (projects + investments)
 *   POST /api/test/invest       → create a sim investment
 *   POST /api/test/reset        → wipe all sim investments (keeps seed funding)
 */
import { Router, Request, Response } from 'express';
import { DEMO_PROJECTS, addSimInvestment, addSimProject, getSimUserInvestments, addSimBalance, getSimBalance,
         getProviderUserProfile, upsertProviderUserProfile, addProviderService, updateProviderService, deleteProviderService,
         ProviderService, resetSimFull,
         getRealityCheck, putRealityCheck, deleteRealityCheck, listRealityChecks, SimRealityCheck, RealityCheckItem } from '../data/simStore';
import { SIM_PROVIDERS, updateProviderStatus } from '../data/providers';
import { SIM_PROPOSALS, SIM_VOTES, SIM_TRANSACTIONS, addProposal, updateProposal, castVote, setVotingWindow, resetGovernance, addInvestmentEvent,
  addCostItem, addEvidenceDoc, addCompletionRequest, castEvidenceVote, getCompletionRequestsForProject, createNotification,
  SIM_NOTIFICATIONS } from '../data/governance';
import { getQuote } from '../services/bitso';

const router = Router();

const DEMO_USER_ID = 'demo-test-user';

/* ── GET /api/test ─────────────────────────────────────────────── */
router.get('/', (_req: Request, res: Response) => {
  res.json({
    note: '⚠️  Simulation mode only — never active in production',
    base: 'http://localhost:3001/api/test',
    endpoints: [
      {
        method: 'GET',
        path: '/api/test/state',
        description: 'Dump all projects with funding % and recent investments',
      },
      {
        method: 'POST',
        path: '/api/test/invest',
        description: 'Create a simulated investment',
        body: {
          projectId: 'string (optional, defaults to demo-project-001)',
          mxn: 'number (optional, defaults to 100 — minimum)',
          userId: 'string (optional, defaults to demo-test-user)',
        },
        example: `curl -s -X POST http://localhost:3001/api/test/invest \\
  -H 'Content-Type: application/json' \\
  -d '{"mxn": 100}'`,
      },
      {
        method: 'POST',
        path: '/api/test/add-balance',
        description: 'Credit MXN balance to a user',
        body: {
          userId: 'string (optional, defaults to demo-test-user)',
          mxn: 'number (positive to add, negative to subtract)',
        },
        example: `curl -s -X POST http://localhost:3001/api/test/add-balance \\
  -H 'Content-Type: application/json' \\
  -d '{"mxn": 5000}'`,
      },
      {
        method: 'POST',
        path: '/api/test/reset',
        description: 'Wipe all sim-user investments (seed funding stays)',
        example: `curl -s -X POST http://localhost:3001/api/test/reset`,
      },
      {
        method: 'GET',
        path: '/api/test/providers',
        description: 'List all sim providers with document counts and status',
        example: `curl -s http://localhost:3001/api/test/providers | jq '.'`,
      },
      {
        method: 'POST',
        path: '/api/test/providers/:id/verify',
        description: 'Mark a provider as VERIFIED',
        example: `curl -s -X POST http://localhost:3001/api/test/providers/prov-002/verify`,
      },
      {
        method: 'GET',
        path: '/api/test/governance',
        description: 'Dump governance state: proposals, votes, transactions',
        example: `curl -s http://localhost:3001/api/test/governance | jq '.'`,
      },
      {
        method: 'POST',
        path: '/api/test/governance/seed',
        description: 'Seed a sample proposal + open voting window for milestone m2',
        example: `curl -s -X POST http://localhost:3001/api/test/governance/seed | jq '.'`,
      },
      {
        method: 'POST',
        path: '/api/test/governance/vote',
        description: 'Cast a test vote',
        body: {
          milestoneId: 'string (default: m2)',
          proposalId: 'string (from seed or state)',
          investorId: 'string (default: test-investor-1)',
        },
        example: `curl -s -X POST http://localhost:3001/api/test/governance/vote \\\n  -H 'Content-Type: application/json' \\\n  -d '{"milestoneId": "m2"}'`,
      },
      {
        method: 'POST',
        path: '/api/test/governance/reset',
        description: 'Wipe all proposals, votes, and test transactions',
        example: `curl -s -X POST http://localhost:3001/api/test/governance/reset`,
      },
      {
        method: 'GET',
        path: '/api/test/profile',
        description: 'Dump provider profile and services for sim-user',
        example: `curl -s http://localhost:3001/api/test/profile | jq '.'`,
      },
      {
        method: 'POST',
        path: '/api/test/profile/service',
        description: 'Seed a finalized provider service for sim-user (skips AI chat)',
        body: { name: 'string', description: 'string', typicalPriceMxn: 'string', deliverables: 'string[]' },
        example: `curl -s -X POST http://localhost:3001/api/test/profile/service \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"LED Installation","typicalPriceMxn":"50,000 MXN"}'`,
      },
      {
        method: 'DELETE',
        path: '/api/test/profile/service/:serviceId',
        description: 'Delete a specific provider service by ID',
        example: `curl -s -X DELETE http://localhost:3001/api/test/profile/service/svc-xxx`,
      },
      {
        method: 'POST',
        path: '/api/test/profile/reset',
        description: 'Wipe all provider services for sim-user (keeps profile enabled)',
        example: `curl -s -X POST http://localhost:3001/api/test/profile/reset`,
      },
    ],
  });
});

/* ── GET /api/test/state ───────────────────────────────────────── */
router.get('/state', (_req: Request, res: Response) => {
  const ONE_ETH = BigInt('1000000000000000000');

  const projects = DEMO_PROJECTS.map((p) => {
    const goal = BigInt(p.fundingGoal);
    const raised = BigInt(p.fundingRaised);
    const pct = goal > 0n ? Number((raised * 100n) / goal) : 0;

    const simInvestments = p.investments
      .filter((inv) => inv.investor.id !== 'u1' && inv.investor.id !== 'u3') // skip pre-seed crowd
      .map((inv) => ({
        id: inv.id,
        userId: inv.investor.id,
        eth: (Number(BigInt(inv.amount)) / 1e18).toFixed(4),
        mxn: (inv as any).mxn ?? null,
        at: (inv as any).createdAt ?? null,
      }));

    return {
      id: p.id,
      title: p.title,
      category: p.category,
      status: p.status,
      fundingPct: pct,
      raisedEth: (Number(raised) / 1e18).toFixed(4),
      goalEth: (Number(goal) / 1e18).toFixed(4),
      investmentCount: p._count.investments,
      simInvestments,
    };
  });

  res.json({
    projects,
    balanceNote: 'Use POST /api/test/add-balance to credit MXN to a user. Default: $10,000 MXN per new user.',
  });
});

/* ── POST /api/test/invest ─────────────────────────────────────── */
router.post('/invest', async (req: Request, res: Response) => {
  const projectId: string = req.body.projectId ?? 'demo-project-001';
  const mxn: number = Math.max(100, Number(req.body.mxn ?? 100));
  const userId: string = req.body.userId ?? DEMO_USER_ID;

  try {
    // Get a real (simulated) Bitso quote so the rate is realistic
    const order = await getQuote(mxn);

    const ok = addSimInvestment(projectId, order.eth, mxn, userId);
    if (!ok) {
      return res.status(404).json({ error: `Project not found: ${projectId}` });
    }

    const history = getSimUserInvestments(userId);

    return res.json({
      ok: true,
      investment: {
        projectId,
        userId,
        mxn,
        eth: order.eth,
        rate: order.rate,
      },
      userHistory: history,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/test/add-balance ───────────────────────────────── */
router.post('/add-balance', (req: Request, res: Response) => {
  const userId: string = req.body.userId ?? DEMO_USER_ID;
  const mxn: number = Number(req.body.mxn ?? 5000);
  if (isNaN(mxn)) return res.status(400).json({ error: 'mxn must be a number' });

  const newBalance = addSimBalance(userId, mxn);
  return res.json({ ok: true, userId, added: mxn, balance: newBalance });
});

/* ── GET /api/test/providers ───────────────────────────────────── */
router.get('/providers', (_req: Request, res: Response) => {
  const list = SIM_PROVIDERS.map(({ documents, ...p }) => ({
    ...p,
    documentCount: documents.length,
    documents: documents.map(d => ({ id: d.id, type: d.type, filename: d.filename, uploadedAt: d.uploadedAt })),
  }));
  res.json({ providers: list, total: list.length });
});

/* ── POST /api/test/providers/:id/verify ──────────────────────── */
router.post('/providers/:id/verify', (req: Request, res: Response) => {
  const provider = updateProviderStatus(req.params.id, 'VERIFIED');
  if (!provider) return res.status(404).json({ error: `Provider not found: ${req.params.id}` });
  res.json({ ok: true, provider: { id: provider.id, name: provider.name, status: provider.status } });
});

/* ── GET /api/test/governance ─────────────────────────────────── */
router.get('/governance', (_req: Request, res: Response) => {
  res.json({
    proposals: SIM_PROPOSALS.map(p => ({
      id: p.id,
      milestoneId: p.milestoneId,
      providerName: p.providerName,
      status: p.status,
      quotedAmountMxn: p.quotedAmountMxn,
      timelineDays: p.timelineDays,
      submittedAt: p.submittedAt ?? null,
    })),
    votes: SIM_VOTES.map(v => ({ id: v.id, milestoneId: v.milestoneId, investorId: v.investorId, proposalId: v.proposalId })),
    transactions: SIM_TRANSACTIONS.map(t => ({ id: t.id, milestoneId: t.milestoneId, providerName: t.providerName, amountMxn: t.amountMxn, status: t.status })),
    totals: { proposals: SIM_PROPOSALS.length, votes: SIM_VOTES.length, transactions: SIM_TRANSACTIONS.length },
  });
});

/* ── POST /api/test/governance/seed ───────────────────────────── */
router.post('/governance/seed', (_req: Request, res: Response) => {
  // Verify prov-001 if needed
  const provider = SIM_PROVIDERS.find(p => p.id === 'prov-001');
  if (provider && provider.status !== 'VERIFIED') updateProviderStatus('prov-001', 'VERIFIED');

  // Create a submitted proposal for milestone m2 if one doesn't exist
  let proposal = SIM_PROPOSALS.find(p => p.milestoneId === 'm2' && p.status === 'SUBMITTED');
  if (!proposal) {
    const draft = addProposal({
      milestoneId: 'm2',
      projectId: 'demo-project-001',
      providerId: 'prov-001',
      providerName: provider?.name ?? 'Constructora Bosques S.A. de C.V.',
      quotedAmountMxn: 85000,
      timelineDays: 55,
      scope: 'Install 24 PoE cameras across 8 intersections, lay 400m of conduit, connect all nodes to colonia server room.',
      approach: 'Start with conduit work to avoid disruption during peak hours. Camera mounting in the final 2 weeks.',
      experience: 'Completed fiber backbone for Lomas Chapultepec colonia in 2024. References available.',
      chatMessages: [],
      documents: [],
      status: 'DRAFT',
    });
    updateProposal(draft.id, {
      status: 'SUBMITTED',
      submittedAt: new Date(),
    });
    proposal = SIM_PROPOSALS.find(p => p.id === draft.id)!;
  }

  // Open voting window for m2 (7 days)
  const deadline = setVotingWindow('m2', 7);

  res.json({
    ok: true,
    proposal: { id: proposal.id, milestoneId: proposal.milestoneId, providerName: proposal.providerName },
    votingWindow: { milestoneId: 'm2', openUntil: deadline },
    hint: `Now cast a vote: POST /api/test/governance/vote with {"proposalId": "${proposal.id}"}`,
  });
});

/* ── POST /api/test/governance/vote ───────────────────────────── */
router.post('/governance/vote', (req: Request, res: Response) => {
  const milestoneId: string = req.body.milestoneId ?? 'm2';
  const investorId: string = req.body.investorId ?? 'test-investor-1';

  // Auto-pick first submitted proposal for this milestone if proposalId not given
  let proposalId: string = req.body.proposalId;
  if (!proposalId) {
    const p = SIM_PROPOSALS.find(p => p.milestoneId === milestoneId && p.status === 'SUBMITTED');
    if (!p) return res.status(400).json({ error: 'No submitted proposals for this milestone. Run POST /api/test/governance/seed first.' });
    proposalId = p.id;
  }

  const result = castVote(milestoneId, 'demo-project-001', investorId, proposalId);
  if (!result.ok) return res.status(409).json({ error: result.error });

  const tally = SIM_VOTES.filter(v => v.milestoneId === milestoneId).length;
  res.json({ ok: true, vote: result.vote, totalVotesForMilestone: tally });
});

/* ── POST /api/test/governance/reset ──────────────────────────── */
router.post('/governance/reset', (_req: Request, res: Response) => {
  // Remove test proposals (keep seed tx)
  SIM_PROPOSALS.splice(0, SIM_PROPOSALS.length);
  SIM_VOTES.splice(0, SIM_VOTES.length);
  res.json({ ok: true, cleared: { proposals: true, votes: true }, note: 'Seed transactions in SIM_TRANSACTIONS preserved' });
});

/* ── GET /api/test/profile ────────────────────────────────────── */
router.get('/profile', (_req: Request, res: Response) => {
  const profile = getProviderUserProfile('sim-user');
  if (!profile) return res.json({ profile: null, message: 'No provider profile for sim-user yet' });
  res.json({
    profile: {
      userId: profile.userId,
      enabled: profile.enabled,
      companyName: profile.companyName,
      specialty: profile.specialty,
      rfc: profile.rfc,
      services: profile.services.map(s => ({
        id: s.id,
        name: s.name,
        finalized: s.finalized,
        typicalPriceMxn: s.typicalPriceMxn,
        messageCount: s.chatMessages.length,
      })),
    },
  });
});

/* ── POST /api/test/profile/service ───────────────────────────── */
router.post('/profile/service', (req: Request, res: Response) => {
  upsertProviderUserProfile('sim-user', { enabled: true });
  const service: ProviderService = {
    id: `svc-test-${Date.now()}`,
    name: req.body.name || 'Test Service',
    description: req.body.description || 'Seeded via test harness',
    deliverables: Array.isArray(req.body.deliverables) ? req.body.deliverables : ['Test deliverable'],
    typicalPriceMxn: req.body.typicalPriceMxn || '10,000 MXN',
    chatMessages: [],
    finalized: true,
    createdAt: new Date().toISOString(),
  };
  addProviderService('sim-user', service);
  res.json({ ok: true, service: { id: service.id, name: service.name } });
});

/* ── DELETE /api/test/profile/service/:serviceId ──────────────── */
router.delete('/profile/service/:serviceId', (req: Request, res: Response) => {
  const ok = deleteProviderService('sim-user', req.params.serviceId);
  if (!ok) return res.status(404).json({ error: `Service not found: ${req.params.serviceId}` });
  res.json({ ok: true });
});

/* ── POST /api/test/profile/reset ─────────────────────────────── */
router.post('/profile/reset', (_req: Request, res: Response) => {
  const profile = getProviderUserProfile('sim-user');
  if (!profile) return res.json({ ok: true, cleared: 0 });
  const count = profile.services.length;
  upsertProviderUserProfile('sim-user', { services: [] });
  res.json({ ok: true, cleared: count });
});

/* ── POST /api/test/profile/seed ──────────────────────────────── */
// Seeds a provider profile for a given userId. Idempotent — preserves existing services.
// Body: { userId, companyName?, specialty?, rfc?, enabled? }
router.post('/profile/seed', (req: Request, res: Response) => {
  const { userId, companyName, specialty, rfc, enabled } = req.body ?? {};
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const existing = getProviderUserProfile(userId);
  const profile = upsertProviderUserProfile(userId, {
    companyName: companyName ?? existing?.companyName ?? '',
    specialty: specialty ?? existing?.specialty ?? '',
    rfc: rfc ?? existing?.rfc ?? '',
    enabled: enabled !== undefined ? enabled : (existing?.enabled ?? true),
    services: existing?.services ?? [],
  });
  res.json({ ok: true, seeded: !existing, profile });
});

/* ── POST /api/test/project/seed ──────────────────────────────── */
// Ensures demo-project-001 exists in the store. Idempotent — safe to call multiple times.
router.post('/project/seed', (_req: Request, res: Response) => {
  const existing = DEMO_PROJECTS.find(p => p.id === 'demo-project-001');
  if (existing) return res.json({ ok: true, project: { id: existing.id, title: existing.title }, seeded: false });

  const ts = Date.now();
  addSimProject({
    id: 'demo-project-001',
    title: 'Paseo de las Palmas Security Camera Network',
    summary: 'Install 24 IP cameras at 8 key intersections along Paseo de las Palmas and Explanada de las Palmas. Live feeds monitored by colonia security team.',
    category: 'infrastructure',
    status: 'ACTIVE',
    fundingGoal: '1500000000000000000000', // ~97.5 ETH @ 65k MXN/ETH ≈ 120k MXN
    fundingRaised: '0',
    createdAt: new Date().toISOString(),
    updatedAt: new Date(),
    planner: { id: 'demo-planner', walletAddress: '0xdemo', role: 'PLANNER' },
    milestones: [
      { id: 'm1', title: 'Permits & Legal Review', description: 'Obtain CDMX municipal permits and INAI data-privacy registration.', fundingPercentage: 15, durationDays: 21, status: 'PENDING' },
      { id: 'm2', title: 'Infrastructure & Installation', description: 'Lay conduit, mount 24 PoE cameras, connect to colonia server room.', fundingPercentage: 65, durationDays: 45, status: 'PENDING' },
      { id: 'm3', title: 'Testing & Handoff', description: 'Commissioning, team training, and 30-day monitoring trial.', fundingPercentage: 20, durationDays: 30, status: 'PENDING' },
    ],
    requiredRoles: [
      { id: `slot-${ts}-0`, role: 'Legal Counsel', description: 'Handle CDMX permits, INAI data-privacy registration, and vendor contracts.', milestoneId: 'm1' },
      { id: `slot-${ts}-1`, role: 'Civil/Network Engineer', description: 'Design conduit layout, oversee camera installation and network topology.', milestoneId: 'm2' },
      { id: `slot-${ts}-2`, role: 'Security Systems Contractor', description: 'Supply and install 24 IP cameras, NVR server, and monitoring software.', milestoneId: 'm2' },
      { id: `slot-${ts}-3`, role: 'Community Coordinator', description: 'Manage resident communications, signage, and approval meetings.', milestoneId: 'm1' },
    ],
    investments: [],
    telemetry: [],
    reports: [],
    _count: { investments: 0 },
    aiGenerated: false,
    aiBlueprint: null,
  });

  const p = DEMO_PROJECTS.find(p => p.id === 'demo-project-001')!;
  res.json({ ok: true, project: { id: p.id, title: p.title }, seeded: true });
});

/* ── GET /api/test/reality-check ───────────────────────────────── */
router.get('/reality-check', (_req: Request, res: Response) => {
  res.json({
    note: 'Reality Check test helpers — simulation mode only',
    checks: listRealityChecks(),
    endpoints: [
      'GET /api/test/reality-check                              dump all stored checks',
      'POST /api/test/reality-check/seed-pass {projectId}       create a synthetic pass-state check',
      'POST /api/test/reality-check/seed-adjust {projectId}     create a synthetic adjust-required check',
      'POST /api/test/reality-check/wipe {projectId}            remove a stored check',
    ],
  });
});

/* ── POST /api/test/reality-check/seed-pass ────────────────────── */
// Bypasses the LLM call and seeds a "passed" Reality Check so the rest of
// the flow can be exercised without burning Anthropic tokens.
router.post('/reality-check/seed-pass', (req: Request, res: Response) => {
  const projectId: string = req.body.projectId ?? DEMO_PROJECTS[0]?.id;
  const project = DEMO_PROJECTS.find((p) => p.id === projectId);
  if (!project) return res.status(404).json({ error: `Project not found: ${projectId}` });

  const items: RealityCheckItem[] = [
    {
      id: `rci-${Date.now()}-a`,
      realityCheckId: `rc-${Date.now()}`,
      milestoneTitle: project.milestones[0]?.title,
      lineLabel: 'Equipment + installation',
      proposerEstimateMxn: 80000,
      benchmarkLowMxn: 75000,
      benchmarkHighMxn: 90000,
      benchmarkMidpointMxn: 82500,
      finalAmountMxn: 80000,
      deltaPct: -3.03,
      confidence: 0.85,
      sources: [],
      proposerJustification: null,
      proposerEvidenceUrls: [],
      flaggedMissing: false,
      missingCategory: null,
    },
  ];
  const check: SimRealityCheck = {
    id: `rc-${Date.now()}`,
    projectId,
    revision: 1,
    state: 'pass',
    layer1CompletedAt: new Date().toISOString(),
    layer1Confidence: 0.85,
    layer1Model: 'test-harness-seed',
    layer1RawResponse: { seeded: true },
    proposerTotalMxn: 80000,
    finalTotalMxn: 80000,
    benchmarkTotalLowMxn: 75000,
    benchmarkTotalHighMxn: 90000,
    items,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  putRealityCheck(check);

  // Route through the same exit as the real /run endpoint so legal review
  // gets queued when enabled.
  (async () => {
    const projectConfig = (await import('../../../config/project-config.json')).default as any;
    if (projectConfig.ai?.legal?.enabled !== false) {
      const { queueLegalReviewForProject } = await import('./legalReview');
      queueLegalReviewForProject(project);
      project.status = 'LEGAL_REVIEW_PENDING';
    } else {
      project.status = 'PENDING';
    }
    res.json({ ok: true, check, projectStatus: project.status });
  })();
});

/* ── POST /api/test/reality-check/seed-adjust ──────────────────── */
router.post('/reality-check/seed-adjust', (req: Request, res: Response) => {
  const projectId: string = req.body.projectId ?? DEMO_PROJECTS[0]?.id;
  const project = DEMO_PROJECTS.find((p) => p.id === projectId);
  if (!project) return res.status(404).json({ error: `Project not found: ${projectId}` });

  const items: RealityCheckItem[] = [
    {
      id: `rci-${Date.now()}-a`,
      realityCheckId: `rc-${Date.now()}`,
      milestoneTitle: project.milestones[0]?.title,
      lineLabel: '12 PoE security cameras (proposer says MXN 180k)',
      proposerEstimateMxn: 180000,
      benchmarkLowMxn: 96000,
      benchmarkHighMxn: 120000,
      benchmarkMidpointMxn: 108000,
      finalAmountMxn: 180000,
      deltaPct: 66.67,
      confidence: 0.78,
      sources: [],
      proposerJustification: null,
      proposerEvidenceUrls: [],
      flaggedMissing: false,
      missingCategory: null,
    },
  ];
  const check: SimRealityCheck = {
    id: `rc-${Date.now()}`,
    projectId,
    revision: 1,
    state: 'adjust_required',
    layer1CompletedAt: new Date().toISOString(),
    layer1Confidence: 0.78,
    layer1Model: 'test-harness-seed',
    layer1RawResponse: { seeded: true },
    proposerTotalMxn: 180000,
    finalTotalMxn: 180000,
    benchmarkTotalLowMxn: 96000,
    benchmarkTotalHighMxn: 120000,
    items,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  putRealityCheck(check);
  project.status = 'REALITY_CHECK_ADJUST';
  res.json({ ok: true, check, projectStatus: project.status });
});

/* ── POST /api/test/reality-check/wipe ─────────────────────────── */
router.post('/reality-check/wipe', (req: Request, res: Response) => {
  const projectId: string = req.body.projectId ?? DEMO_PROJECTS[0]?.id;
  if (getRealityCheck(projectId)) {
    deleteRealityCheck(projectId);
    return res.json({ ok: true, wiped: projectId });
  }
  res.json({ ok: false, error: `No check stored for ${projectId}` });
});

/* ── GET /api/test/legal ───────────────────────────────────────── */
router.get('/legal', async (_req: Request, res: Response) => {
  const { listLegalReviewQueue, listLawyers, listUserStrikes } = await import('../data/simStore');
  res.json({
    note: 'Legal + strike test helpers — simulation mode only',
    queue: listLegalReviewQueue(),
    lawyers: listLawyers(),
    endpoints: [
      'POST /api/test/legal/seed-lawyer    {userId, cedulaProfesional?, specialties?}  promote a user to lawyer',
      'POST /api/test/legal/seed-queued    {projectId}    push a project into the legal queue',
      'POST /api/test/legal/force-approve  {projectId, lawyerUserId}  skip review and approve',
      'POST /api/test/strikes/add          {userId, n?=1}  add N active strikes',
      'POST /api/test/strikes/clear        {userId}        clear ALL active strikes',
    ],
  });
});

/* ── POST /api/test/legal/seed-lawyer ──────────────────────────── */
router.post('/legal/seed-lawyer', async (req: Request, res: Response) => {
  const userId = (req.body?.userId as string) ?? 'sim-user';
  const cedula = (req.body?.cedulaProfesional as string) ?? String(Math.floor(1000000 + Math.random() * 9000000));
  const specialties = Array.isArray(req.body?.specialties) ? req.body.specialties : ['administrative', 'civil'];

  const { upsertLawyerCredential } = await import('../data/simStore');
  const cred = upsertLawyerCredential({
    userId,
    cedulaProfesional: cedula,
    dgpVerifiedAt: new Date().toISOString(),
    specialties,
    availability: 'available',
    createdAt: new Date().toISOString(),
  });
  res.json({ ok: true, credential: cred });
});

/* ── POST /api/test/legal/seed-queued ──────────────────────────── */
router.post('/legal/seed-queued', async (req: Request, res: Response) => {
  const projectId: string = req.body?.projectId ?? DEMO_PROJECTS[0]?.id;
  const project = DEMO_PROJECTS.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: `Project not found: ${projectId}` });

  const { queueLegalReviewForProject } = await import('./legalReview');
  const rev = queueLegalReviewForProject(project);
  project.status = 'LEGAL_REVIEW_PENDING';
  res.json({ ok: true, legalReview: rev, projectStatus: project.status });
});

/* ── POST /api/test/legal/force-approve ────────────────────────── */
router.post('/legal/force-approve', async (req: Request, res: Response) => {
  const projectId: string = req.body?.projectId ?? DEMO_PROJECTS[0]?.id;
  const lawyerUserId: string = req.body?.lawyerUserId ?? 'sim-lawyer';
  const project = DEMO_PROJECTS.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: `Project not found: ${projectId}` });

  const { getLegalReview, putLegalReview, getLawyerCredential, queueLegalReviewForProject } = await import('../data/simStore').then(async m => {
    const lr = await import('./legalReview');
    return { ...m, queueLegalReviewForProject: lr.queueLegalReviewForProject };
  });
  let rev = getLegalReview(projectId);
  if (!rev) rev = queueLegalReviewForProject(project);
  const cred = getLawyerCredential(lawyerUserId);
  rev.state = 'approved';
  rev.claimedByUserId = lawyerUserId;
  rev.claimedByName = lawyerUserId;
  rev.claimedAt = new Date().toISOString();
  rev.decidedAt = new Date().toISOString();
  rev.cedulaProfesional = cred?.cedulaProfesional ?? '0000000';
  rev.notes = 'Approved via test harness';
  for (const item of rev.checklistItems) rev.checklistResponses[item.label] = { satisfied: true };
  putLegalReview(rev);
  project.status = 'PENDING';
  (project as any).legalLead = { userId: lawyerUserId, name: lawyerUserId, cedula: rev.cedulaProfesional, proBono: false };
  res.json({ ok: true, legalReview: rev, projectStatus: project.status });
});

/* ── POST /api/test/strikes/add ────────────────────────────────── */
router.post('/strikes/add', async (req: Request, res: Response) => {
  const userId: string = req.body?.userId ?? 'sim-user';
  const n: number = Math.max(1, parseInt(req.body?.n ?? 1));
  const { addStrike, getActiveStrikes, isSuspended } = await import('../data/simStore');
  for (let i = 0; i < n; i++) {
    addStrike({
      id: `strike-test-${Date.now()}-${i}`,
      userId,
      reason: 'expired',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
      clearedAt: null,
      contextProjectId: null,
    });
  }
  res.json({ ok: true, userId, activeStrikes: getActiveStrikes(userId).length, suspended: isSuspended(userId) });
});

/* ── POST /api/test/strikes/clear ──────────────────────────────── */
router.post('/strikes/clear', async (req: Request, res: Response) => {
  const userId: string = req.body?.userId ?? 'sim-user';
  const { listUserStrikes, clearOldestStrike } = await import('../data/simStore');
  let cleared = 0;
  while (clearOldestStrike(userId)) cleared++;
  res.json({ ok: true, userId, cleared, remaining: listUserStrikes(userId).filter(s => !s.clearedAt).length });
});

/* ── POST /api/test/reset ──────────────────────────────────────── */
router.post('/reset', (_req: Request, res: Response) => {
  // Remove all non-seed investments from every project (seed IDs are now gone, so this clears everything)
  let removed = 0;
  for (const project of DEMO_PROJECTS) {
    removed += project.investments.length;
    project.investments = [];
    project.fundingRaised = '0';
    project._count.investments = 0;
    project.updatedAt = new Date();
  }
  res.json({ ok: true, removed });
});

/* ── POST /api/test/seed-funding ───────────────────────────────── */
// Seeds 1000 MXN split across 4 demo investors on a project.
router.post('/seed-funding', (req: Request, res: Response) => {
  const projectId = (req.body.projectId as string) || DEMO_PROJECTS[0]?.id;
  const project = DEMO_PROJECTS.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const ETH_MXN = 65000;
  const contributors = [
    { id: 'investor-001', name: 'Ana Martínez', mxn: 350 },
    { id: 'investor-002', name: 'Carlos Ruiz',  mxn: 275 },
    { id: 'investor-003', name: 'Sofia Torres', mxn: 225 },
    { id: 'investor-004', name: 'Luis García',  mxn: 150 },
  ];

  const results = [];
  for (const c of contributors) {
    addSimBalance(c.id, c.mxn);
    const eth = c.mxn / ETH_MXN;
    const ok = addSimInvestment(projectId, eth, c.mxn, c.id);
    // Patch investor name onto the investment record
    const inv = project.investments[project.investments.length - 1] as any;
    if (inv) inv.investor.name = c.name;
    // Log investment event
    const weiAmt = BigInt(Math.round(eth * 1e12)) * BigInt(1e6);
    addInvestmentEvent({
      type: 'INVEST',
      projectId,
      actorId: c.id,
      actorName: c.name,
      mxnAmount: c.mxn,
      ethAmount: eth,
      weiAmount: weiAmt.toString(),
      bitsoOrderId: `SIM-SEED-${c.id}-${Date.now()}`,
      note: 'Seeded demo investment',
      createdAt: new Date(),
    });
    results.push({ ...c, eth: parseFloat(eth.toFixed(6)), ok });
  }

  const totalMxn = contributors.reduce((s, c) => s + c.mxn, 0);
  res.json({ ok: true, projectId, totalMxn, contributors: results });
});

/* ── POST /api/test/simulate-completion ────────────────────────── */
// Seeds a realistic completion request on the first milestone of a project.
// Creates cost items + a fake CFDI XML doc + CompletionRequest ready for voting.
router.post('/simulate-completion', (req: Request, res: Response) => {
  const projectId = (req.body.projectId as string) || DEMO_PROJECTS[0]?.id;
  const project = DEMO_PROJECTS.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const milestoneIdx = (req.body.milestoneIndex as number) ?? 0;
  const milestone = project.milestones[milestoneIdx] as any;
  if (!milestone) return res.status(404).json({ error: 'Milestone not found' });
  if (milestone.status === 'COMPLETED') {
    return res.status(400).json({ error: 'Milestone already completed — use a different index' });
  }

  const providerId = req.body.providerId || 'test-provider-001';
  const providerName = req.body.providerName || 'TechWorks SAPI de CV';

  // Log cost items
  const costs = [
    { description: 'Technical consultation and regulatory research', amountMxn: 4500, category: 'services' as const },
    { description: 'Legal filing fees — drone operator certification', amountMxn: 2800, category: 'services' as const },
    { description: 'Engineer labor (5 days)', amountMxn: 8750, category: 'labor' as const },
  ];
  const costItems = costs.map(c => addCostItem({
    milestoneId: milestone.id, projectId,
    providerId, providerName,
    ...c, date: new Date(),
  }));
  const totalCostMxn = costs.reduce((s, c) => s + c.amountMxn, 0);

  // Create a fake CFDI XML as base64
  const cfdiXml = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"
  Version="4.0"
  Fecha="${new Date().toISOString().slice(0, 19)}"
  SubTotal="${totalCostMxn}"
  Total="${(totalCostMxn * 1.16).toFixed(2)}"
  Moneda="MXN"
  TipoDeComprobante="I">
  <cfdi:Emisor Rfc="TEWS820401HDF" Nombre="${providerName}" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="Comunidad Espacio Bosques" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    ${costs.map(c => `<cfdi:Concepto ClaveProdServ="81101500" Cantidad="1" Descripcion="${c.description}" ValorUnitario="${c.amountMxn}" Importe="${c.amountMxn}"/>`).join('\n    ')}
  </cfdi:Conceptos>
</cfdi:Comprobante>`;
  const cfdiBase64 = Buffer.from(cfdiXml).toString('base64');

  const doc = addEvidenceDoc({
    milestoneId: milestone.id, projectId,
    uploadedBy: providerId,
    filename: `CFDI_${milestone.title.replace(/\s+/g, '_')}_${Date.now()}.xml`,
    mimeType: 'text/xml',
    sizeBytes: cfdiXml.length,
    dataBase64: cfdiBase64,
    uploadedAt: new Date(),
    validated: false,
  });

  // Run AI analysis inline for the test (synchronous is fine for test endpoint)
  const { validateDocument } = require('../ai/document_validator');
  validateDocument(doc.filename, doc.mimeType, cfdiBase64, costItems)
    .then((analysis: any) => { doc.aiAnalysis = analysis; });

  // Count eligible voters
  const ids = new Set<string>();
  for (const inv of (project.investments ?? []) as any[]) {
    if (inv.investor?.id) ids.add(inv.investor.id);
  }
  const eligibleVoters = ids.size;
  const status = eligibleVoters < 5 ? 'OWNER_REVIEW' : 'PENDING_VOTES';

  const completionReq = addCompletionRequest({
    projectId, milestoneId: milestone.id, milestoneTitle: milestone.title,
    submittedBy: providerId, submitterName: providerName,
    totalCostMxn, status, submittedAt: new Date(),
  });

  milestone.status = 'EVIDENCE_REVIEW';

  // Notify investors
  for (const id of ids) {
    createNotification({
      userId: id,
      type: 'COMPLETION_SUBMITTED',
      title: `Review needed: ${milestone.title}`,
      body: `${providerName} submitted completion evidence for "${milestone.title}". Your vote is needed.`,
      projectId, milestoneId: milestone.id, requestId: completionReq.id,
    });
  }

  res.json({
    ok: true,
    completionRequest: completionReq,
    costItems,
    doc: { ...doc, dataBase64: '[base64 omitted]' },
    eligibleVoters,
    status,
    message: `Completion request created. ${eligibleVoters >= 5 ? `Community vote open (${eligibleVoters >= 10 ? '75%' : '66.7%'} threshold).` : 'Owner review required (fewer than 5 investors).'}`,
    voteEndpoint: `POST /api/moneyflow/${projectId}/completion-requests/${completionReq.id}/vote`,
    ownerDecisionEndpoint: `POST /api/moneyflow/${projectId}/completion-requests/${completionReq.id}/owner-decide`,
  });
});

/* ── POST /api/test/cast-completion-vote ───────────────────────── */
// Casts APPROVE or REJECT votes on a completion request from sim investor IDs.
router.post('/cast-completion-vote', (req: Request, res: Response) => {
  const { requestId, projectId, votes } = req.body;
  // votes: [{ voterId, voterName, vote: 'APPROVE'|'REJECT', reason? }]
  if (!requestId || !votes?.length) {
    return res.status(400).json({ error: 'requestId and votes[] required' });
  }

  const pid = projectId || DEMO_PROJECTS[0]?.id;
  const results = [];
  for (const v of votes) {
    const result = castEvidenceVote({
      requestId, projectId: pid,
      milestoneId: req.body.milestoneId || '',
      voterId: v.voterId, voterName: v.voterName || v.voterId,
      vote: v.vote, reason: v.reason, createdAt: new Date(),
    });
    results.push({ voterId: v.voterId, vote: v.vote, ok: result.ok, error: result.error });
  }
  res.json({ ok: true, results });
});

/* ── POST /api/test/owner-decide ────────────────────────────────── */
// Test-harness: simulate owner approving/rejecting a completion request.
// Bypasses auth — only active in simulation mode.
router.post('/owner-decide', (req: Request, res: Response) => {
  const { projectId, requestId, decision, note } = req.body;
  if (!requestId || !decision) return res.status(400).json({ error: 'requestId and decision required' });
  const { getCompletionRequest: getReq, SIM_COMPLETION_REQUESTS: CREQS, addInvestmentEvent: aie, createNotification: cn,
    getEvidenceVotesForRequest: getVotes } = require('../data/governance');
  const pid = projectId || DEMO_PROJECTS[0]?.id;
  const project = DEMO_PROJECTS.find(p => p.id === pid);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const request = CREQS.find((r: any) => r.id === requestId);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'OWNER_REVIEW' && request.status !== 'PENDING_VOTES') {
    return res.status(400).json({ error: `Already resolved: ${request.status}` });
  }
  const milestone = project.milestones.find((m: any) => m.id === request.milestoneId) as any;
  const ETH_MXN = 65000;
  request.status = decision;
  request.resolvedAt = new Date();
  request.resolutionNote = note ?? `Test harness owner decision: ${decision}`;
  if (decision === 'APPROVE') {
    milestone.status = 'COMPLETED';
    const mxn = request.totalCostMxn;
    const ethAmt = mxn / ETH_MXN;
    aie({
      type: 'DISBURSE', projectId: pid, milestoneId: milestone.id, milestoneTitle: milestone.title,
      actorId: request.submittedBy, actorName: request.submitterName,
      mxnAmount: mxn, ethAmount: ethAmt,
      weiAmount: (BigInt(Math.round(ethAmt * 1e12)) * BigInt(1e6)).toString(),
      bitsoOrderId: `DISBURSE-TEST-${Date.now()}`,
      note: `Approved by owner — "${milestone.title}"`,
      createdAt: new Date(),
    });
    cn({ userId: request.submittedBy, type: 'MILESTONE_APPROVED',
      title: 'Milestone approved — payment released',
      body: `"${milestone.title}" approved. $${mxn.toLocaleString()} MXN disbursed.`,
      projectId: pid, milestoneId: milestone.id, requestId: request.id });
  } else {
    milestone.status = 'IN_PROGRESS';
    cn({ userId: request.submittedBy, type: 'MILESTONE_REJECTED',
      title: 'Milestone completion rejected',
      body: `"${milestone.title}" was not approved. ${request.resolutionNote}`,
      projectId: pid, milestoneId: milestone.id, requestId: request.id });
  }
  res.json({ ok: true, request, milestone: { id: milestone.id, title: milestone.title, status: milestone.status },
    message: decision === 'APPROVE' ? 'Milestone approved. DISBURSE event logged.' : 'Milestone rejected.' });
});

/* ── GET /api/test/notifications ───────────────────────────────── */
// List all notifications in the system (for debugging)
router.get('/notifications', (_req: Request, res: Response) => {
  res.json({ notifications: SIM_NOTIFICATIONS.slice(0, 100), total: SIM_NOTIFICATIONS.length });
});

/* ── POST /api/test/reset/full ─────────────────────────────────── */
// Nuclear reset: wipes ALL sim state — projects, balances, governance, profiles.
// Use before a fresh demo or launch simulation.
router.post('/reset/full', (_req: Request, res: Response) => {
  resetSimFull();
  resetGovernance();
  res.json({
    ok: true,
    message: 'Full reset complete — all projects at 0% funding, all balances cleared, all governance data wiped.',
    note: 'Users will need to deposit MXN before they can invest.',
  });
});

export default router;
