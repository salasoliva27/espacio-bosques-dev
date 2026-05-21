/**
 * /api/profile — Provider profile and service definition
 *
 * GET  /api/profile/provider                           — get provider profile for current user
 * PUT  /api/profile/provider                           — upsert provider profile fields
 * POST /api/profile/provider/services                  — create a new service + start AI chat
 * POST /api/profile/provider/services/:serviceId/chat  — AI chat turn to define the service
 * PATCH /api/profile/provider/services/:serviceId      — update service fields directly
 */
import { Router, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import {
  getProviderUserProfile,
  upsertProviderUserProfile,
  addProviderService,
  updateProviderService,
  deleteProviderService,
  ProviderService,
} from '../data/simStore';

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

/** Extract the first balanced JSON object from a string (handles nested braces). */
function extractJsonObject(text: string): any | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const SERVICE_SYSTEM = `You are a service definition assistant for Espacio Bosques — a community project platform in Bosques de las Lomas, CDMX.

A provider (contractor or professional) wants to register a service they offer for community projects. Help them articulate it precisely so it can be matched to project requirements and used to create bids.

Through conversation, collect:
1. Service name — short, professional title (e.g., "LED Electrical Installation", "Landscape Architecture")
2. What they actually do — specific tasks, scope, process
3. Deliverables — what the client receives (reports, completed work, certifications, etc.)
4. Typical price range in MXN — can be per project, per unit, or hourly
5. Any relevant certifications or experience they want to highlight

Rules:
- Ask one thing at a time, conversationally
- Be concise — one or two sentences max per response
- When you have all 5 points with enough detail, say "Perfecto, I have everything I need. Ready to save this service?"
- When complete, output ONLY JSON: {"ready": true, "service": {"name": "...", "description": "...", "deliverables": ["..."], "typicalPriceMxn": "...", "highlights": "..."}}`;

// ── GET /api/profile/provider ─────────────────────────────────────────

router.get('/provider', requireAuth, (req: AuthRequest, res: Response) => {
  const profile = getProviderUserProfile(req.user!.id);
  res.json({ profile });
});

// ── PUT /api/profile/provider ─────────────────────────────────────────

router.put('/provider', requireAuth, (req: AuthRequest, res: Response) => {
  const { enabled, companyName, specialty, rfc } = req.body;
  const updates: any = {};

  // If trying to enable, require all three fields to be present and non-empty
  if (enabled === true) {
    const existing = getProviderUserProfile(req.user!.id);
    const resolvedCompany = (companyName ?? existing?.companyName ?? '').trim();
    const resolvedSpecialty = (specialty ?? existing?.specialty ?? '').trim();
    const resolvedRfc = (rfc ?? existing?.rfc ?? '').trim();

    if (!resolvedCompany || !resolvedSpecialty || !resolvedRfc) {
      return res.status(400).json({
        error: 'Company name, specialty, and RFC are required before enabling your provider profile.',
        missing: {
          companyName: !resolvedCompany,
          specialty: !resolvedSpecialty,
          rfc: !resolvedRfc,
        },
      });
    }
    updates.companyName = resolvedCompany;
    updates.specialty = resolvedSpecialty;
    updates.rfc = resolvedRfc;
  }

  if (enabled !== undefined) updates.enabled = Boolean(enabled);
  if (companyName !== undefined) updates.companyName = String(companyName).trim();
  if (specialty !== undefined) updates.specialty = String(specialty).trim();
  if (rfc !== undefined) updates.rfc = String(rfc).trim();

  const profile = upsertProviderUserProfile(req.user!.id, updates);
  logger.info('[profile] provider profile updated', { userId: req.user!.id });
  res.json({ profile });
});

// ── POST /api/profile/provider/services ──────────────────────────────

router.post('/provider/services', requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;

  // Check that provider profile exists and is enabled
  const profile = getProviderUserProfile(userId);
  if (!profile || !profile.enabled) {
    return res.status(403).json({ error: 'Enable your provider profile first' });
  }

  // Dedup: if there is already a non-finalized service, return it instead of creating another
  const existingDraft = profile.services.find(s => !s.finalized);
  if (existingDraft) {
    logger.info('[profile] returning existing draft service', { userId, serviceId: existingDraft.id });
    return res.json({ service: existingDraft, resumed: true });
  }

  const serviceId = `svc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const introMessage = { role: 'assistant' as const, content: "Hi! I'll help you define a service for your provider profile. Let's start — what's the name of the service you'd like to register? A short, professional title works best (e.g., \"LED Electrical Installation\" or \"Landscape Architecture\")." };

  const newService: ProviderService = {
    id: serviceId,
    name: '',
    description: '',
    deliverables: [],
    typicalPriceMxn: '',
    chatMessages: [introMessage],
    finalized: false,
    createdAt: new Date().toISOString(),
  };

  const updatedProfile = addProviderService(userId, newService);
  logger.info('[profile] service created', { userId, serviceId });

  res.status(201).json({ service: newService, resumed: false });
});

// ── POST /api/profile/provider/services/:serviceId/chat ──────────────

router.post('/provider/services/:serviceId/chat', requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { serviceId } = req.params;
  const { message } = req.body;

  if (!message) return res.status(400).json({ error: 'Missing message' });

  const profile = getProviderUserProfile(userId);
  if (!profile) return res.status(404).json({ error: 'Provider profile not found' });

  const service = profile.services.find(s => s.id === serviceId);
  if (!service) return res.status(404).json({ error: 'Service not found' });

  const newUserMsg = { role: 'user' as const, content: message };
  const history = [...service.chatMessages, newUserMsg];

  try {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SERVICE_SYSTEM,
      messages: history.map(m => ({ role: m.role, content: m.content })),
    });

    const text = (response.content.find(b => b.type === 'text') as any)?.text ?? '';
    const assistantMsg = { role: 'assistant' as const, content: text };
    const updatedMessages = [...history, assistantMsg];

    // Check if AI signals readiness — use brace-balanced extractor (regex fails on nested JSON)
    let ready = false;
    let serviceData: any = null;
    if (text.includes('"ready"') && text.includes('true')) {
      const parsed = extractJsonObject(text);
      if (parsed?.ready && parsed?.service) {
        ready = true;
        serviceData = parsed.service;
      }
    }

    // Save updated chat history
    updateProviderService(userId, serviceId, { chatMessages: updatedMessages });

    // If ready, auto-update the service fields
    if (ready && serviceData) {
      updateProviderService(userId, serviceId, {
        name: serviceData.name || service.name,
        description: serviceData.description || service.description,
        deliverables: Array.isArray(serviceData.deliverables) ? serviceData.deliverables : service.deliverables,
        typicalPriceMxn: serviceData.typicalPriceMxn || service.typicalPriceMxn,
        chatMessages: updatedMessages,
      });
    }

    logger.info('[profile] service chat turn', { userId, serviceId, ready });
    res.json({ message: text, ready, service: serviceData });
  } catch (err: any) {
    logger.error('[profile] service chat failed', { error: err.message });
    res.status(500).json({ error: 'AI error', details: err.message });
  }
});

// ── POST /api/profile/provider/services/:serviceId/finalize ──────────
// Called when the user clicks "I'm done" — extracts structured data from
// chat history with a strict JSON-only prompt (no conversational output).

router.post('/provider/services/:serviceId/finalize', requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { serviceId } = req.params;

  const profile = getProviderUserProfile(userId);
  if (!profile) return res.status(404).json({ error: 'Provider profile not found' });

  const service = profile.services.find(s => s.id === serviceId);
  if (!service) return res.status(404).json({ error: 'Service not found' });

  if (service.chatMessages.length < 2) {
    return res.status(400).json({ error: 'Not enough conversation to extract a service. Keep chatting.' });
  }

  try {
    // Fast path: if the chat AI already produced {"ready":true,"service":{...}}, use it directly
    for (let i = service.chatMessages.length - 1; i >= 0; i--) {
      const msg = service.chatMessages[i];
      if (msg.role === 'assistant') {
        const obj = extractJsonObject(msg.content);
        if (obj?.ready === true && obj?.service && obj.service.name) {
          const svc = obj.service;
          updateProviderService(userId, serviceId, {
            name: svc.name,
            description: svc.description || '',
            deliverables: Array.isArray(svc.deliverables) ? svc.deliverables : [],
            typicalPriceMxn: svc.typicalPriceMxn || '',
          });
          logger.info('[profile] service finalized via fast path', { userId, serviceId });
          return res.json({ service: svc });
        }
        break; // only check the last assistant message
      }
    }

    // Anthropic requires messages to start with 'user' — strip leading assistant intro if present
    const rawMessages = service.chatMessages.map(m => ({ role: m.role, content: m.content }));
    const messagesForExtraction = rawMessages[0]?.role === 'assistant' ? rawMessages.slice(1) : rawMessages;

    if (messagesForExtraction.length === 0 || messagesForExtraction[0]?.role !== 'user') {
      return res.status(400).json({ error: 'Not enough conversation to extract a service. Keep chatting.' });
    }

    const extractionResponse = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 512,
      system: `You are a data extractor. Read the conversation and output ONLY a valid JSON object — no other text, no markdown, no explanation.

Required format:
{"name":"short professional title","description":"what they do and how","deliverables":["deliverable 1","deliverable 2"],"typicalPriceMxn":"price range in MXN"}

Rules:
- name: REQUIRED — infer the best short title (max 6 words) from whatever was described, even if incomplete
- description: 1-2 sentences about what they do. Use whatever was shared.
- deliverables: list what the client receives. Use ["Service delivery"] if not specified.
- typicalPriceMxn: price range mentioned, or empty string if none given
- Output ONLY the JSON. No markdown fences. No explanation.`,
      messages: messagesForExtraction,
    });

    const raw = (extractionResponse.content.find(b => b.type === 'text') as any)?.text ?? '';
    logger.info('[profile] extraction AI raw response', { raw: raw.slice(0, 300) });

    // Strip markdown fences if present
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();

    let extracted: any;
    try {
      extracted = JSON.parse(cleaned);
    } catch {
      extracted = extractJsonObject(raw);
    }

    // Unwrap nested format: {"ready": true, "service": {...}} → {...}
    if (extracted && extracted.service && typeof extracted.service === 'object') {
      extracted = extracted.service;
    }

    // Fallback: if name is missing or empty, derive it from description or use a generic title
    if (extracted && !extracted.name) {
      extracted.name = extracted.description
        ? extracted.description.split(' ').slice(0, 5).join(' ')
        : 'Professional Service';
    }

    if (!extracted || !extracted.name) {
      logger.warn('[profile] extraction failed — no name after all fallbacks', { raw: raw.slice(0, 500) });
      return res.status(422).json({ error: 'Could not extract service data. Keep describing your service.' });
    }

    // Persist extracted fields to the service
    updateProviderService(userId, serviceId, {
      name: extracted.name,
      description: extracted.description || '',
      deliverables: Array.isArray(extracted.deliverables) ? extracted.deliverables : [],
      typicalPriceMxn: extracted.typicalPriceMxn || '',
    });

    logger.info('[profile] service finalized', { userId, serviceId });
    res.json({ service: extracted });
  } catch (err: any) {
    logger.error('[profile] service finalize failed', { error: err.message });
    res.status(500).json({ error: 'AI error', details: err.message });
  }
});

// ── PATCH /api/profile/provider/services/:serviceId ──────────────────

router.patch('/provider/services/:serviceId', requireAuth, (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { serviceId } = req.params;

  const service = updateProviderService(userId, serviceId, req.body);
  if (!service) return res.status(404).json({ error: 'Service not found' });

  logger.info('[profile] service updated', { userId, serviceId });
  res.json({ service });
});

// ── POST /api/profile/provider/services/:serviceId/categorize ────────
// Accepts either:
//   { category: "lawyer" }                      (chosen from dropdown)
//   { categoryFreeText: "constructor de drones" } (the "Otro" path; AI normalizes)
// Sets `category` and `categoryFreeText` on the service.
router.post('/provider/services/:serviceId/categorize', requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { serviceId } = req.params;
  const { category, categoryFreeText } = req.body as { category?: string; categoryFreeText?: string };

  let finalCategory: string | undefined;
  let displayLabel: string | undefined;
  let isKnown = false;

  if (category && typeof category === 'string') {
    // Dropdown path — trust the canonical key the frontend sent.
    const { KNOWN_CATEGORIES } = await import('../ai/normalize_provider_service');
    finalCategory = category.trim();
    isKnown = (KNOWN_CATEGORIES as readonly string[]).includes(finalCategory);
  } else if (categoryFreeText && typeof categoryFreeText === 'string') {
    // "Otro" path — ask the AI to normalize.
    const { normalizeProviderService } = await import('../ai/normalize_provider_service');
    const result = await normalizeProviderService(categoryFreeText);
    finalCategory = result.category;
    displayLabel = result.displayLabel;
    isKnown = result.isKnown;
    logger.info('[profile] normalized free-text service', {
      userId, serviceId, freeText: categoryFreeText.slice(0, 60), category: finalCategory, source: result.source,
    });
  } else {
    return res.status(400).json({ error: 'Either `category` (dropdown) or `categoryFreeText` (free-text) is required.' });
  }

  const service = updateProviderService(userId, serviceId, {
    category: finalCategory,
    categoryFreeText: categoryFreeText || undefined,
  });
  if (!service) return res.status(404).json({ error: 'Service not found' });

  res.json({ service, normalized: { category: finalCategory, displayLabel, isKnown } });
});

// ── DELETE /api/profile/provider/services/:serviceId ─────────────────

router.delete('/provider/services/:serviceId', requireAuth, (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { serviceId } = req.params;

  const ok = deleteProviderService(userId, serviceId);
  if (!ok) return res.status(404).json({ error: 'Service not found' });

  logger.info('[profile] service deleted', { userId, serviceId });
  res.json({ ok: true });
});

export default router;
