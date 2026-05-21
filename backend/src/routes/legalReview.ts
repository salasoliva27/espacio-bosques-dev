/**
 * /api/legal-review/*  — lawyer queue + claim/approve/decline workflow.
 *
 * Sits between Reality Check pass and OPEN_FOR_FUNDING. Every project must
 * be claimed by a verified lawyer and signed off before it reaches the public
 * funding feed. See `dump/espacio-bosques.md` § LEGAL VALIDATION.
 */
import { Router, Response } from 'express';
import { logger } from '../utils/logger';
import { SIMULATION_MODE } from '../config/mode';
import { requireAuth, AuthRequest } from '../middleware/auth';
import {
  DEMO_PROJECTS,
  persistData,
  getLegalReview,
  putLegalReview,
  listLegalReviewQueue,
  activeLegalReviewsForLawyer,
  getLawyerCredential,
  isLawyer,
  SimLegalReview,
} from '../data/simStore';
import { createNotification } from '../data/governance';
import projectConfig from '../../../config/project-config.json';

const router = Router();

const newId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const LAWYER_CAP = (projectConfig as any).ai?.legal?.lawyerActiveProjectCap ?? 3;
const CLAIM_FEE_BASE_MXN = (projectConfig as any).ai?.legal?.claimFeeBaseMxn ?? 1500;
const CLAIM_FEE_LARGE_MXN = (projectConfig as any).ai?.legal?.claimFeeLargeMxn ?? 3000;
const LARGE_THRESHOLD_MXN = (projectConfig as any).ai?.legal?.largeProjectThresholdMxn ?? 100000;

/* ── Helpers ──────────────────────────────────────────────────────── */

function approximateMxnFromWei(wei: string): number {
  const ETH_MXN = 65000;
  try {
    const eth = Number(BigInt(wei)) / 1e18;
    return Math.round(eth * ETH_MXN);
  } catch { return 0; }
}

function defaultChecklistForProject(category: string): { label: string; category: string; required: boolean }[] {
  // Simple heuristic — real version would derive from the AI blueprint.
  // Always-on items:
  const base = [
    { label: 'Permiso de obra / corte de tráfico CDMX, si aplica', category: 'permits', required: true },
    { label: 'Contrato firmado con el proveedor adjudicado', category: 'contracts', required: true },
    { label: 'Póliza de responsabilidad civil del proveedor', category: 'insurance', required: true },
    { label: 'Conformidad con el reglamento de la colonia', category: 'community', required: true },
  ];
  // Category-specific add-ons
  const lower = (category || '').toLowerCase();
  if (lower.includes('camera') || lower.includes('seguridad') || lower.includes('drone')) {
    base.push({ label: 'Aviso de privacidad INAI (grabación de espacios)', category: 'privacy', required: true });
  }
  if (lower.includes('infra') || lower.includes('pav') || lower.includes('obra') || lower.includes('construcción')) {
    base.push({ label: 'Cumplimiento Ley de Obras Públicas estatal', category: 'regulatory', required: true });
  }
  return base;
}

function feeForProject(project: any): number {
  const budgetMxn = approximateMxnFromWei(project.fundingGoal || '0');
  return budgetMxn > LARGE_THRESHOLD_MXN ? CLAIM_FEE_LARGE_MXN : CLAIM_FEE_BASE_MXN;
}

/* ── GET /api/legal-review/queue ─────────────────────────────────── */
// Lawyer-only. Returns pending cases.
router.get('/queue', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!isLawyer(req.user!.id)) {
    return res.status(403).json({ error: 'Solo abogados verificados pueden ver la cola legal.' });
  }
  const cred = getLawyerCredential(req.user!.id)!;
  const myActiveCount = activeLegalReviewsForLawyer(req.user!.id).length;
  const queue = listLegalReviewQueue().map(rev => {
    const project = DEMO_PROJECTS.find(p => p.id === rev.projectId);
    return {
      id: rev.id,
      projectId: rev.projectId,
      state: rev.state,
      queuedAt: rev.queuedAt,
      feeMxn: rev.feeMxn,
      checklistItems: rev.checklistItems,
      project: project ? {
        title: project.title,
        category: project.category,
        summary: project.summary,
        fundingGoalMxn: approximateMxnFromWei(project.fundingGoal),
        plannerId: project.planner?.id,
      } : null,
    };
  });
  res.json({
    lawyer: { name: cred.userId, specialties: cred.specialties, activeCount: myActiveCount, cap: LAWYER_CAP },
    queue,
  });
});

/* ── GET /api/legal-review/:projectId ────────────────────────────── */
router.get('/:projectId', async (req: AuthRequest, res: Response) => {
  const { projectId } = req.params;
  const rev = getLegalReview(projectId);
  const project = DEMO_PROJECTS.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: { id: project.id, status: project.status, title: project.title }, legalReview: rev });
});

/* ── POST /api/legal-review/:projectId/claim ─────────────────────── */
router.post('/:projectId/claim', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!SIMULATION_MODE()) return res.status(501).json({ error: 'Real-DB legal review path not yet implemented' });
  if (!isLawyer(req.user!.id)) {
    return res.status(403).json({ error: 'Solo abogados verificados pueden tomar casos de la cola legal.' });
  }
  const cred = getLawyerCredential(req.user!.id)!;
  if (activeLegalReviewsForLawyer(req.user!.id).length >= LAWYER_CAP) {
    return res.status(409).json({ error: `Ya tienes ${LAWYER_CAP} casos activos. Cierra alguno antes de tomar otro.` });
  }

  const { projectId } = req.params;
  const rev = getLegalReview(projectId);
  if (!rev) return res.status(404).json({ error: 'No hay caso legal abierto para este proyecto.' });
  if (rev.state !== 'queued' && rev.state !== 'declined') {
    return res.status(409).json({ error: `El caso está en estado '${rev.state}' y no se puede tomar.` });
  }

  const proBono = !!req.body?.proBono;
  rev.state = 'claimed';
  rev.claimedByUserId = req.user!.id;
  rev.claimedByName = (req.body?.displayName as string) || cred.userId;
  rev.claimedAt = new Date().toISOString();
  rev.cedulaProfesional = cred.cedulaProfesional;
  rev.proBono = proBono;
  if (proBono) rev.feeMxn = 0;
  putLegalReview(rev);

  const project = DEMO_PROJECTS.find(p => p.id === projectId);
  if (project) {
    createNotification({
      userId: project.planner.id,
      type: 'PROJECT_UPDATE' as any,
      title: 'Tu proyecto está en revisión legal',
      body: `${rev.claimedByName} (cédula ${cred.cedulaProfesional}) tomó tu caso. Tiene 7 días para decidir.`,
      projectId,
    });
  }

  res.json({ ok: true, legalReview: rev });
});

/* ── POST /api/legal-review/:projectId/approve ───────────────────── */
router.post('/:projectId/approve', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!SIMULATION_MODE()) return res.status(501).json({ error: 'Real-DB legal review path not yet implemented' });
  const { projectId } = req.params;
  const rev = getLegalReview(projectId);
  const project = DEMO_PROJECTS.find(p => p.id === projectId);
  if (!rev || !project) return res.status(404).json({ error: 'Caso legal o proyecto no encontrado.' });
  if (rev.claimedByUserId !== req.user!.id) {
    return res.status(403).json({ error: 'Sólo el abogado que tomó el caso puede aprobarlo.' });
  }
  if (rev.state !== 'claimed') {
    return res.status(409).json({ error: `El caso está en estado '${rev.state}' y no se puede aprobar.` });
  }

  const checklistResponses = req.body?.checklistResponses ?? {};
  // Sanity: every required item must be marked satisfied
  for (const item of rev.checklistItems) {
    if (item.required && !checklistResponses[item.label]?.satisfied) {
      return res.status(400).json({ error: `Falta confirmar: ${item.label}` });
    }
  }
  rev.checklistResponses = checklistResponses;
  rev.state = 'approved';
  rev.decidedAt = new Date().toISOString();
  rev.notes = (req.body?.notes as string) || '';
  putLegalReview(rev);

  // Now move the project to PENDING (= open for funding)
  project.status = 'PENDING';
  (project as any).legalLead = {
    userId: rev.claimedByUserId,
    name: rev.claimedByName,
    cedula: rev.cedulaProfesional,
    proBono: rev.proBono,
  };
  project.updatedAt = new Date();
  persistData();

  createNotification({
    userId: project.planner.id,
    type: 'PROJECT_UPDATE' as any,
    title: '¡Aprobado por el abogado! Tu proyecto ya está abierto a recaudación.',
    body: `${rev.claimedByName} firmó como abogado/a del equipo. Los vecinos ya pueden aportar.`,
    projectId,
  });

  logger.info('[legal-review] approved', { projectId, lawyer: req.user!.id });
  res.json({ ok: true, legalReview: rev, project: { id: project.id, status: project.status } });
});

/* ── POST /api/legal-review/:projectId/request-changes ───────────── */
router.post('/:projectId/request-changes', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!SIMULATION_MODE()) return res.status(501).json({ error: 'Real-DB legal review path not yet implemented' });
  const { projectId } = req.params;
  const rev = getLegalReview(projectId);
  const project = DEMO_PROJECTS.find(p => p.id === projectId);
  if (!rev || !project) return res.status(404).json({ error: 'Caso legal o proyecto no encontrado.' });
  if (rev.claimedByUserId !== req.user!.id) {
    return res.status(403).json({ error: 'Sólo el abogado que tomó el caso puede pedir cambios.' });
  }
  if (rev.state !== 'claimed') {
    return res.status(409).json({ error: `El caso está en estado '${rev.state}'.` });
  }
  const notes = (req.body?.notes as string)?.trim();
  if (!notes || notes.length < 10) {
    return res.status(400).json({ error: 'Las notas para el proponente son obligatorias (mínimo 10 caracteres).' });
  }

  rev.state = 'changes_required';
  rev.notes = notes;
  rev.decidedAt = new Date().toISOString();
  putLegalReview(rev);

  // Bounce the project back to DRAFT so the proposer can re-publish after editing.
  project.status = 'DRAFT';
  project.updatedAt = new Date();
  persistData();

  createNotification({
    userId: project.planner.id,
    type: 'PROJECT_UPDATE' as any,
    title: 'El abogado pidió cambios en tu proyecto',
    body: `${rev.claimedByName}: "${notes.slice(0, 140)}${notes.length > 140 ? '…' : ''}"`,
    projectId,
  });

  res.json({ ok: true, legalReview: rev, project: { id: project.id, status: project.status } });
});

/* ── POST /api/legal-review/:projectId/decline ───────────────────── */
// The lawyer realizes the case isn't a fit; release it back to the queue.
// No strike — declining the wrong fit is good behaviour.
router.post('/:projectId/decline', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!SIMULATION_MODE()) return res.status(501).json({ error: 'Real-DB legal review path not yet implemented' });
  const { projectId } = req.params;
  const rev = getLegalReview(projectId);
  if (!rev) return res.status(404).json({ error: 'Caso legal no encontrado.' });
  if (rev.claimedByUserId !== req.user!.id) {
    return res.status(403).json({ error: 'Sólo el abogado que tomó el caso puede declinarlo.' });
  }
  rev.state = 'declined';
  rev.claimedByUserId = null;
  rev.claimedByName = null;
  rev.claimedAt = null;
  rev.cedulaProfesional = null;
  rev.notes = (req.body?.notes as string) || rev.notes;
  rev.decidedAt = null;
  putLegalReview(rev);

  res.json({ ok: true, legalReview: rev });
});

/* ── POST /api/legal-review/credentials ──────────────────────────── */
// Sign up as a lawyer. In sim mode the DGP verification is stubbed.
router.post('/credentials', requireAuth, async (req: AuthRequest, res: Response) => {
  const cedula = (req.body?.cedulaProfesional as string)?.trim();
  if (!cedula || !/^\d{6,10}$/.test(cedula)) {
    return res.status(400).json({ error: 'Cédula profesional inválida. Debe tener 6–10 dígitos.' });
  }
  const specialties = Array.isArray(req.body?.specialties)
    ? req.body.specialties.filter((s: unknown) => typeof s === 'string')
    : ['general'];

  const { upsertLawyerCredential, getLawyerCredential } = await import('../data/simStore');
  const existing = getLawyerCredential(req.user!.id);
  const cred = upsertLawyerCredential({
    userId: req.user!.id,
    cedulaProfesional: cedula,
    dgpVerifiedAt: existing?.dgpVerifiedAt ?? new Date().toISOString(), // stubbed in sim mode
    specialties,
    availability: existing?.availability ?? 'available',
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  });
  logger.info('[legal-review] lawyer credential saved', { userId: req.user!.id, cedula });
  res.json({ ok: true, credential: cred });
});

/* ── GET /api/legal-review/credentials ──────────────────────────── */
router.get('/credentials', requireAuth, async (req: AuthRequest, res: Response) => {
  const { getLawyerCredential } = await import('../data/simStore');
  const cred = getLawyerCredential(req.user!.id);
  res.json({ isLawyer: !!cred && cred.availability !== 'suspended', credential: cred });
});

/* ── Helper exported for projects route + tests ──────────────────── */
export function queueLegalReviewForProject(project: any): SimLegalReview {
  const fee = feeForProject(project);
  const rev: SimLegalReview = {
    id: newId('legal'),
    projectId: project.id,
    state: 'queued',
    queuedAt: new Date().toISOString(),
    claimedByUserId: null,
    claimedByName: null,
    claimedAt: null,
    decidedAt: null,
    notes: '',
    checklistItems: defaultChecklistForProject(project.category || ''),
    checklistResponses: {},
    feeMxn: fee,
    proBono: false,
    cedulaProfesional: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return putLegalReview(rev);
}

export default router;
