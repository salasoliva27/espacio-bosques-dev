/**
 * Provider service normalization.
 *
 * When a provider writes a free-text description of what they offer
 * ("yo construyo drones de vigilancia", "constructor de drones",
 *  "fabrico cuadrocópteros"), this module asks Claude to map it to one
 * canonical `category` key. That way the platform doesn't end up with three
 * different "categories" for the same service.
 *
 * Used by `backend/src/routes/providers.ts` whenever a provider saves a
 * service that came from the "Otro / escribe tu servicio" path.
 */
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

/**
 * Canonical categories the platform already supports. The normalizer is
 * encouraged to map free-text into one of these when possible; if nothing
 * fits cleanly, it can propose a new canonical key (snake_case, English).
 */
export const KNOWN_CATEGORIES = [
  'lawyer',           // abogado/a
  'paving',           // pavimentación
  'security_cameras', // cámaras de seguridad
  'landscaping',      // jardinería
  'lighting',         // iluminación
  'drone_builder',    // constructor/operador de drones
  'electrical',       // electricista
  'plumbing',         // plomería
  'cleaning',         // limpieza
  'signage',          // señalización
  'permits_consulting', // gestión de trámites
  'accounting',       // contador
  'architecture',     // arquitecto/diseño
  'construction',     // construcción/obra
  'other',
] as const;

export type CanonicalCategory = (typeof KNOWN_CATEGORIES)[number] | string;

export interface NormalizationResult {
  category: CanonicalCategory;
  /** True if `category` matched one of the known list; false if it's a brand-new key. */
  isKnown: boolean;
  /** 0..1 — how confident we are in the mapping. */
  confidence: number;
  /** What the user originally wrote. */
  originalText: string;
  /** A human-friendly Spanish label for the category (for the UI badge). */
  displayLabel: string;
  /** Source: `llm` (Claude call) or `heuristic` (fallback). */
  source: 'llm' | 'heuristic';
}

const SYSTEM_PROMPT = `You are normalizing free-text service descriptions for a community
crowdfunding platform's provider directory. Given the text a provider wrote about what
they offer, return one canonical category key.

Rules:
- Pick from this list when any fits: ${KNOWN_CATEGORIES.join(', ')}
- If nothing in the list fits, invent a new canonical key in snake_case English (one or two
  words, descriptive). Example: "fabrico letreros LED" -> "led_signage".
- Same underlying service must map to the same category regardless of how it's phrased.
  "Construyo drones" and "constructor de drones" both -> "drone_builder".
- Lawyers / abogados always -> "lawyer".

Respond ONLY with a single JSON object (no markdown, no prose):
{
  "category": "<canonical_key>",
  "isKnown": true|false,
  "confidence": 0..1,
  "displayLabel": "<short Spanish label for the UI badge, e.g. 'Pavimentación', 'Constructor de drones'>"
}`;

/**
 * Quick heuristic for the common cases. Used as a fallback when the LLM
 * call fails or when running in tests. Keeps the platform working even
 * without an Anthropic key.
 */
function heuristicNormalize(text: string): NormalizationResult {
  const lower = text.toLowerCase().trim();
  const checks: Array<[string, CanonicalCategory, string]> = [
    [/abogad|abogada|jur[ií]dic|legal|cédula|cedula/.toString(), 'lawyer', 'Abogado/a'],
    [/pavimenta|asfalto|bachear|rebache|repav/.toString(), 'paving', 'Pavimentación'],
    [/c[aá]mara|cctv|vigilanc/.toString(), 'security_cameras', 'Cámaras de seguridad'],
    [/jard[ií]n|paisaj|poda|árbol/.toString(), 'landscaping', 'Jardinería'],
    [/iluminaci|luminar|lámpara|alumbrad/.toString(), 'lighting', 'Iluminación'],
    [/dron|cuadricoptero|cuadricóptero|cuadracoptero/.toString(), 'drone_builder', 'Drones'],
    [/electric|el[eé]ctric/.toString(), 'electrical', 'Electricidad'],
    [/plomer|fontaner/.toString(), 'plumbing', 'Plomería'],
    [/limpieza|aseo/.toString(), 'cleaning', 'Limpieza'],
    [/señalética|señalizaci|sign/.toString(), 'signage', 'Señalización'],
    [/permis|trámit/.toString(), 'permits_consulting', 'Gestión de trámites'],
    [/contad|fiscal|impuest|sat /.toString(), 'accounting', 'Contabilidad'],
    [/arquitect|diseñ/.toString(), 'architecture', 'Arquitectura'],
    [/construcc|obra|alban[ií]l/.toString(), 'construction', 'Construcción'],
  ];
  for (const [reSrc, cat, label] of checks) {
    // reSrc looks like "/abogad|abogada|.../i" — slice off the slashes
    const body = reSrc.slice(1, reSrc.lastIndexOf('/'));
    if (new RegExp(body).test(lower)) {
      return { category: cat, isKnown: true, confidence: 0.65, originalText: text, displayLabel: label, source: 'heuristic' };
    }
  }
  return { category: 'other', isKnown: true, confidence: 0.3, originalText: text, displayLabel: 'Otro', source: 'heuristic' };
}

export async function normalizeProviderService(freeText: string): Promise<NormalizationResult> {
  const trimmed = (freeText || '').trim();
  if (!trimmed) {
    return { category: 'other', isKnown: true, confidence: 0, originalText: trimmed, displayLabel: 'Otro', source: 'heuristic' };
  }

  // Fall back to heuristic if no API key
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.info('[provider-normalize] no ANTHROPIC_API_KEY — using heuristic', { text: trimmed.slice(0, 60) });
    return heuristicNormalize(trimmed);
  }

  try {
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
    const message = await anthropic.messages.create({
      model,
      max_tokens: 256,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: trimmed }],
    });
    const block = message.content.find(b => b.type === 'text');
    if (!block || block.type !== 'text') throw new Error('no text content');
    let raw = block.text.trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(raw) as Partial<NormalizationResult>;
    if (!parsed.category) throw new Error('missing category in LLM response');
    const result: NormalizationResult = {
      category: parsed.category,
      isKnown: (KNOWN_CATEGORIES as readonly string[]).includes(parsed.category),
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.7)),
      originalText: trimmed,
      displayLabel: parsed.displayLabel?.trim() || titleCase(parsed.category),
      source: 'llm',
    };
    logger.info('[provider-normalize] LLM mapping', { text: trimmed.slice(0, 60), category: result.category, isKnown: result.isKnown });
    return result;
  } catch (err: any) {
    logger.warn('[provider-normalize] LLM call failed, falling back to heuristic', { error: err.message });
    return heuristicNormalize(trimmed);
  }
}

function titleCase(s: string): string {
  return s
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
