/**
 * Invest routes — MXN → quote → confirm → fund flow.
 *
 * GET  /api/invest/quote?mxn=500   → Bitso sandbox quote
 * POST /api/invest/buy             → Simulate purchase + fund project (auth required)
 */
import { Router, Request, Response } from 'express';
import { getQuote, simulateBuy } from '../services/bitso';
import { fundProject } from '../services/wallet';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { SIMULATION_MODE } from '../config/mode';
import { addSimInvestment, getSimUserInvestments, deductSimBalance, getSimBalance, DEMO_PROJECTS } from '../data/simStore';

const router = Router();

/**
 * GET /api/invest/quote?mxn=500
 * Public — no auth required for getting a quote
 */
router.get('/quote', async (req: Request, res: Response) => {
  try {
    const mxn = parseFloat(req.query.mxn as string);
    if (!mxn || mxn <= 0 || isNaN(mxn)) {
      return res.status(400).json({ error: 'mxn must be a positive number' });
    }
    if (mxn < 100) {
      return res.status(400).json({ error: 'Minimum investment is 100 MXN' });
    }

    const quote = await getQuote(mxn);
    return res.json(quote);
  } catch (err: any) {
    logger.error('[invest] quote failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to get quote' });
  }
});

/**
 * POST /api/invest/buy
 * Auth required — creates simulated purchase and funds the project
 *
 * Body: { projectId: string, mxn: number }
 */
router.post('/buy', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { projectId, mxn } = req.body;

    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const amount = parseFloat(mxn);
    if (!amount || amount < 100 || isNaN(amount)) {
      return res.status(400).json({ error: 'mxn must be at least 100' });
    }

    // 0a. Block funding while the project is still going through a gate
    //     (Reality Check or Legal Review). Open-for-funding == PENDING.
    if (SIMULATION_MODE()) {
      const project = DEMO_PROJECTS.find((p) => p.id === projectId);
      if (project && typeof project.status === 'string') {
        if (project.status.startsWith('REALITY_CHECK_')) {
          return res.status(409).json({
            error: 'Este proyecto aún no completa su Reality Check. No se pueden recibir aportaciones hasta que pase la verificación.',
            projectStatus: project.status,
          });
        }
        if (project.status.startsWith('LEGAL_REVIEW_')) {
          return res.status(409).json({
            error: 'Este proyecto está en revisión legal por un abogado verificado. No se pueden recibir aportaciones hasta que firme.',
            projectStatus: project.status,
          });
        }
        if (project.status === 'DRAFT') {
          return res.status(409).json({
            error: 'Este proyecto está en borrador y todavía no ha sido publicado.',
            projectStatus: project.status,
          });
        }
      }
    }

    // 0b. Block funding if the user is suspended (3+ active strikes).
    if (SIMULATION_MODE()) {
      const { isSuspended } = await import('../data/simStore');
      if (isSuspended(req.user!.id)) {
        return res.status(403).json({
          error: 'Tu cuenta está suspendida por strikes acumulados en validaciones. Completa las validaciones pendientes para recuperar tu lugar.',
          suspended: true,
        });
      }
    }

    // 0c. Check simulated balance (sim mode only)
    if (SIMULATION_MODE()) {
      const balance = getSimBalance(req.user!.id);
      if (balance < amount) {
        return res.status(400).json({
          error: `Saldo insuficiente. Tienes $${balance.toLocaleString('es-MX')} MXN disponibles.`,
          balance,
        });
      }
    }

    // 1. Get Bitso quote (or simulation)
    const order = await simulateBuy(amount);

    // 2. Fund project escrow (simulation tx)
    const { txHash, simulation } = await fundProject(projectId, order.eth);

    // 3. Update in-memory funding progress + deduct balance (simulation mode)
    if (SIMULATION_MODE()) {
      addSimInvestment(projectId, order.eth, amount, req.user?.id);
      deductSimBalance(req.user!.id, amount);
    }

    logger.info('[invest] investment recorded', {
      userId: req.user?.id,
      projectId,
      mxn: amount,
      eth: order.eth,
      txHash,
      simulation,
    });

    return res.json({
      success: true,
      orderId: order.orderId,
      txHash,
      mxn: order.mxn,
      eth: order.eth,
      rate: order.rate,
      simulation: SIMULATION_MODE(),
      remainingBalance: SIMULATION_MODE() ? getSimBalance(req.user!.id) : undefined,
      message: SIMULATION_MODE()
        ? 'Inversión simulada registrada correctamente ✓'
        : 'Inversión completada',
    });
  } catch (err: any) {
    logger.error('[invest] buy failed', { error: err.message });
    return res.status(500).json({ error: 'Investment failed' });
  }
});

/**
 * GET /api/invest/me
 * Auth required — returns the current sim-user's investment history
 */
router.get('/me', requireAuth, (req: AuthRequest, res: Response) => {
  const investments = getSimUserInvestments(req.user!.id);
  return res.json({ investments });
});

export default router;
