/**
 * RealityCheckPanel — renders the pre-funding budget verification gate
 * on the project detail page (and as a final step in CreateProject).
 *
 * Surfaces:
 *   - The Reality Check state (pending / pass / adjust_required)
 *   - Per-item benchmark range vs. proposer estimate
 *   - Scope gaps the AI noticed
 *   - Actions for the proposer (run / accept / justify)
 *
 * The proposer's original estimate, the market benchmark, and any
 * justification stay visible to everyone once the project is open for
 * funding — that's the whole point.
 */
import { useEffect, useState } from 'react';
import axios from 'axios';
import { translate, getLang, type Lang } from '../lib/i18n';

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001';

export interface RealityCheckItem {
  id: string;
  lineLabel: string;
  milestoneTitle?: string;
  proposerEstimateMxn: number;
  benchmarkLowMxn: number | null;
  benchmarkHighMxn: number | null;
  benchmarkMidpointMxn: number | null;
  finalAmountMxn: number;
  deltaPct: number | null;
  confidence: number;
  proposerJustification: string | null;
  flaggedMissing: boolean;
  missingCategory: string | null;
}

export interface RealityCheck {
  id: string;
  projectId: string;
  state: 'pending' | 'pass' | 'adjust_required';
  layer1Confidence: number | null;
  proposerTotalMxn: number;
  finalTotalMxn: number;
  benchmarkTotalLowMxn: number;
  benchmarkTotalHighMxn: number;
  items: RealityCheckItem[];
  updatedAt: string;
}

interface RealityCheckPanelProps {
  projectId: string;
  isProposer: boolean;
  authToken?: string;
  /** Called after a state-changing action so the parent can refresh the project. */
  onChange?: () => void;
}

const fmtMxn = (n: number | null): string =>
  n === null ? '—' : `$${Math.round(n).toLocaleString('es-MX')}`;

export default function RealityCheckPanel({ projectId, isProposer, authToken, onChange }: RealityCheckPanelProps) {
  const lang: Lang = getLang();
  const t = (k: any, vars?: Record<string, string>) => translate(k, lang, vars);

  const [check, setCheck] = useState<RealityCheck | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [justifications, setJustifications] = useState<Record<string, string>>({});

  async function load() {
    setLoading(true);
    try {
      const { data } = await axios.get(`${API_URL}/api/reality-check/${projectId}`);
      setEnabled(Boolean(data.enabled));
      setCheck(data.check ?? null);
    } catch {
      setCheck(null);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectId]);

  async function run() {
    if (!authToken) return;
    setRunning(true);
    try {
      await axios.post(
        `${API_URL}/api/reality-check/${projectId}/run`,
        {},
        { headers: { Authorization: `Bearer ${authToken}` } }
      );
      await load();
      onChange?.();
    } catch (err: any) {
      // eslint-disable-next-line no-alert
      alert(err?.response?.data?.error ?? 'Reality Check failed');
    } finally {
      setRunning(false);
    }
  }

  async function acceptAdjustment() {
    if (!authToken) return;
    await axios.post(
      `${API_URL}/api/reality-check/${projectId}/accept-adjustment`,
      {},
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    await load();
    onChange?.();
  }

  async function submitJustifications() {
    if (!authToken || !check) return;
    const items = Object.entries(justifications)
      .filter(([, j]) => j && j.trim().length >= 10)
      .map(([id, justification]) => ({ id, justification }));
    if (items.length === 0) return;
    try {
      await axios.post(
        `${API_URL}/api/reality-check/${projectId}/justify`,
        { items },
        { headers: { Authorization: `Bearer ${authToken}` } }
      );
      setJustifications({});
      await load();
      onChange?.();
    } catch (err: any) {
      // eslint-disable-next-line no-alert
      alert(err?.response?.data?.error ?? 'Could not save justification');
    }
  }

  if (!enabled) return null;
  if (loading) return <div className="rc-panel">…</div>;

  return (
    <section className="rc-panel rounded-xl border border-emerald-700/40 bg-emerald-950/30 p-5 my-6">
      <header className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-emerald-200">{t('rc.title')}</h3>
        {check?.state === 'pass' && (
          <span className="text-xs uppercase tracking-wider text-emerald-400">{t('rc.passed_banner')}</span>
        )}
        {check?.state === 'adjust_required' && (
          <span className="text-xs uppercase tracking-wider text-amber-400">{t('rc.subtitle_adjust')}</span>
        )}
      </header>

      {!check && (
        <>
          <p className="text-sm text-emerald-100/80 mb-3">{t('rc.no_data')}</p>
          {isProposer && (
            <button
              type="button"
              onClick={run}
              disabled={running}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-400 disabled:opacity-50"
            >
              {running ? t('rc.running') : t('rc.run_btn')}
            </button>
          )}
        </>
      )}

      {check && (
        <>
          <p className="text-sm text-emerald-100/80 mb-4">
            {check.state === 'pass' && t('rc.subtitle_pass')}
            {check.state === 'adjust_required' && t('rc.subtitle_adjust')}
            {check.state === 'pending' && t('rc.subtitle_pending')}
          </p>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4 text-sm">
            <Stat label={t('rc.proposer_estimate')} value={fmtMxn(check.proposerTotalMxn)} />
            <Stat
              label={t('rc.market_range')}
              value={`${fmtMxn(check.benchmarkTotalLowMxn)} – ${fmtMxn(check.benchmarkTotalHighMxn)}`}
            />
            <Stat label={t('rc.final')} value={fmtMxn(check.finalTotalMxn)} />
            <Stat
              label={t('rc.confidence')}
              value={check.layer1Confidence !== null ? `${Math.round(check.layer1Confidence * 100)}%` : '—'}
            />
          </div>

          <ul className="space-y-3">
            {check.items.filter((i) => !i.flaggedMissing).map((item) => (
              <li key={item.id} className="rounded-lg bg-black/30 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-medium text-emerald-100">{item.lineLabel}</span>
                  <span className={`text-xs ${item.deltaPct !== null && Math.abs(item.deltaPct) > 25 ? 'text-amber-400' : 'text-emerald-300/70'}`}>
                    {item.deltaPct === null ? '—' : `${item.deltaPct > 0 ? '+' : ''}${item.deltaPct.toFixed(1)}%`}
                  </span>
                </div>
                <div className="mt-1 grid grid-cols-3 text-xs text-emerald-100/70">
                  <span>{t('rc.proposer_estimate')}: {fmtMxn(item.proposerEstimateMxn)}</span>
                  <span>{t('rc.market_range')}: {fmtMxn(item.benchmarkLowMxn)} – {fmtMxn(item.benchmarkHighMxn)}</span>
                  <span>{t('rc.final')}: {fmtMxn(item.finalAmountMxn)}</span>
                </div>
                {item.proposerJustification && (
                  <p className="mt-2 text-xs italic text-emerald-200/80">"{item.proposerJustification}"</p>
                )}
                {isProposer && check.state === 'adjust_required' && item.deltaPct !== null && Math.abs(item.deltaPct) > 25 && (
                  <textarea
                    className="mt-2 w-full rounded bg-black/40 p-2 text-xs text-emerald-50 placeholder-emerald-100/40"
                    placeholder={t('rc.justify_placeholder')}
                    value={justifications[item.id] ?? ''}
                    onChange={(e) => setJustifications((s) => ({ ...s, [item.id]: e.target.value }))}
                  />
                )}
              </li>
            ))}
          </ul>

          {check.items.some((i) => i.flaggedMissing) && (
            <div className="mt-5">
              <h4 className="text-sm font-medium text-amber-300 mb-2">{t('rc.scope_gaps_title')}</h4>
              <ul className="space-y-1 text-xs text-amber-100/80">
                {check.items.filter((i) => i.flaggedMissing).map((g) => (
                  <li key={g.id}>• {g.lineLabel}{g.missingCategory ? ` (${g.missingCategory})` : ''}{g.benchmarkMidpointMxn ? ` — ≈ ${fmtMxn(g.benchmarkMidpointMxn)}` : ''}</li>
                ))}
              </ul>
            </div>
          )}

          {isProposer && check.state === 'adjust_required' && (
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={acceptAdjustment}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-400"
              >
                {t('rc.accept_adjustment')}
              </button>
              <button
                type="button"
                onClick={submitJustifications}
                disabled={Object.values(justifications).every((j) => !j || j.trim().length < 10)}
                className="rounded-lg border border-amber-500 px-4 py-2 text-sm font-medium text-amber-200 hover:bg-amber-500/10 disabled:opacity-50"
              >
                {t('rc.submit_justification')}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-emerald-300/60">{label}</div>
      <div className="text-sm text-emerald-50">{value}</div>
    </div>
  );
}
