/**
 * Lawyer-only queue: cases waiting for legal sign-off before they go public
 * for funding. Also lets a regular user register as a lawyer with their
 * cédula profesional (DGP verification is stubbed in sim mode).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { getSession } from '../lib/auth';

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001';

interface LegalReviewSummary {
  id: string;
  projectId: string;
  state: string;
  queuedAt: string;
  feeMxn: number;
  checklistItems: { label: string; category: string; required: boolean }[];
  project: { title: string; category: string; summary: string; fundingGoalMxn: number; plannerId: string } | null;
}

interface LawyerStatus {
  isLawyer: boolean;
  credential: { cedulaProfesional: string; specialties: string[]; availability: string } | null;
}

const fmtMxn = (n: number) => `$${Math.round(n).toLocaleString('es-MX')}`;

export default function LegalQueue() {
  const [token, setToken] = useState<string>('');
  const [status, setStatus] = useState<LawyerStatus | null>(null);
  const [queue, setQueue] = useState<LegalReviewSummary[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [cap, setCap] = useState(3);
  const [loading, setLoading] = useState(true);
  const [cedulaInput, setCedulaInput] = useState('');
  const [specialty, setSpecialty] = useState('administrative');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSession().then(({ data: { session } }) => {
      if (session) setToken(session.access_token);
    });
  }, []);

  async function refresh() {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const s = await axios.get<LawyerStatus>(`${API_URL}/api/legal-review/credentials`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setStatus(s.data);
      if (s.data.isLawyer) {
        const q = await axios.get(`${API_URL}/api/legal-review/queue`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setQueue(q.data.queue);
        setActiveCount(q.data.lawyer?.activeCount ?? 0);
        setCap(q.data.lawyer?.cap ?? 3);
      } else {
        setQueue([]);
      }
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e.message ?? 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  async function registerAsLawyer() {
    if (!token) return;
    if (!/^\d{6,10}$/.test(cedulaInput)) {
      setError('Cédula profesional inválida (6–10 dígitos)');
      return;
    }
    try {
      await axios.post(`${API_URL}/api/legal-review/credentials`,
        { cedulaProfesional: cedulaInput, specialties: [specialty] },
        { headers: { Authorization: `Bearer ${token}` } });
      setCedulaInput('');
      await refresh();
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'No se pudo registrar la credencial');
    }
  }

  async function claim(projectId: string) {
    if (!token) return;
    try {
      await axios.post(`${API_URL}/api/legal-review/${projectId}/claim`, {},
        { headers: { Authorization: `Bearer ${token}` } });
      await refresh();
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'No se pudo tomar el caso');
    }
  }

  return (
    <div className="min-h-screen px-6 py-10 max-w-5xl mx-auto text-neutral-100" style={{ background: '#0b1410' }}>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-semibold">Cola legal</h1>
        <Link to="/dashboard" className="text-sm text-emerald-400 hover:underline">← Dashboard</Link>
      </div>

      {loading && <p className="text-neutral-400">Cargando…</p>}
      {error && (
        <div className="my-4 rounded-lg border border-red-500/40 bg-red-900/20 p-3 text-sm text-red-200">{error}</div>
      )}

      {!loading && status && !status.isLawyer && (
        <section className="rounded-xl border border-amber-500/40 bg-amber-900/10 p-5 my-6">
          <h2 className="text-lg font-medium text-amber-300 mb-2">Sólo abogados verificados pueden ver la cola</h2>
          <p className="text-sm text-amber-100/80 mb-4">
            Para tomar casos de la cola legal, regístrate como abogado con tu cédula profesional. En modo simulación,
            la verificación contra el DGP está sustituida por una validación de formato (6–10 dígitos).
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={cedulaInput}
              onChange={(e) => setCedulaInput(e.target.value)}
              placeholder="Cédula (ej. 12345678)"
              className="rounded-lg bg-black/40 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500"
            />
            <select
              value={specialty}
              onChange={(e) => setSpecialty(e.target.value)}
              className="rounded-lg bg-black/40 px-3 py-2 text-sm text-neutral-100"
            >
              <option value="administrative">Administrativo</option>
              <option value="civil">Civil</option>
              <option value="fintech">Fintech</option>
              <option value="fiscal">Fiscal</option>
              <option value="contractual">Contractual</option>
              <option value="general">General</option>
            </select>
            <button
              type="button"
              onClick={registerAsLawyer}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-400"
            >
              Registrarme como abogado
            </button>
          </div>
        </section>
      )}

      {!loading && status?.isLawyer && (
        <>
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-900/10 p-4 my-4 flex items-center justify-between">
            <div>
              <div className="text-sm text-emerald-300">Verificado · cédula {status.credential?.cedulaProfesional}</div>
              <div className="text-xs text-neutral-400">Especialidades: {status.credential?.specialties.join(', ')}</div>
            </div>
            <div className="text-sm text-emerald-300">{activeCount} / {cap} casos activos</div>
          </div>

          <h2 className="text-lg font-medium mt-6 mb-3">Casos pendientes ({queue.length})</h2>
          {queue.length === 0 && (
            <p className="text-neutral-400 italic">No hay casos en la cola por ahora.</p>
          )}
          <ul className="space-y-3">
            {queue.map((rev) => (
              <li key={rev.id} className="rounded-xl border border-neutral-700 bg-neutral-900/50 p-4">
                <div className="flex items-baseline justify-between gap-3 mb-2">
                  <h3 className="text-base font-medium text-neutral-100">{rev.project?.title ?? rev.projectId}</h3>
                  <span className="text-xs text-neutral-400">{rev.project?.category}</span>
                </div>
                <p className="text-sm text-neutral-300 mb-3">{rev.project?.summary}</p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs mb-3">
                  <div><span className="text-neutral-500">Presupuesto</span><div>{fmtMxn(rev.project?.fundingGoalMxn ?? 0)}</div></div>
                  <div><span className="text-neutral-500">Cuota legal</span><div>{rev.feeMxn === 0 ? 'Pro bono' : fmtMxn(rev.feeMxn)}</div></div>
                  <div><span className="text-neutral-500">Estado</span><div>{rev.state}</div></div>
                </div>
                <div className="text-xs text-neutral-400 mb-3">
                  <span className="text-neutral-500">Lista de revisión:</span>
                  <ul className="list-disc list-inside mt-1 space-y-1">
                    {rev.checklistItems.map(item => (
                      <li key={item.label}>{item.label}{item.required ? ' *' : ''}</li>
                    ))}
                  </ul>
                </div>
                <button
                  type="button"
                  onClick={() => claim(rev.projectId)}
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-400"
                >
                  Tomar el caso
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
