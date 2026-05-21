import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';
import { useT, useLanguage } from '../context/LanguageContext';
import InvestModal from '../components/InvestModal';
import MilestoneCalendar from '../components/MilestoneCalendar';
import VotingSection from '../components/VotingSection';
import TransactionLedger from '../components/TransactionLedger';
import BidModal from '../components/BidModal';
import MoneyFlowDiagram from '../components/MoneyFlowDiagram';
import MilestoneCompletion from '../components/MilestoneCompletion';
import EvidenceReview from '../components/EvidenceReview';
import RealityCheckPanel from '../components/RealityCheckPanel';
import { getSession } from '../lib/auth';
import { Send } from 'lucide-react';

interface EditChatMsg { role: 'user' | 'assistant'; text: string; }
interface RawMsg { role: 'user' | 'assistant'; content: string; }

const STATUS_STYLES: Record<string, { color: string; bg: string }> = {
  COMPLETED:       { color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
  IN_PROGRESS:     { color: '#00e5c4', bg: 'rgba(0,229,196,0.12)' },
  SUBMITTED:       { color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
  EVIDENCE_REVIEW: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  PENDING:         { color: '#6b7280', bg: 'rgba(107,114,128,0.12)' },
};

const CATEGORIES = ['infrastructure', 'environment', 'community', 'technology', 'education'];

export default function ProjectDetail() {
  const { id } = useParams();
  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showInvest, setShowInvest] = useState(false);
  const [bidRole, setBidRole] = useState<any>(null);
  const t = useT();
  const { lang } = useLanguage();

  // Auth — to detect if current user is the creator
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [token, setToken] = useState<string>('');

  // Edit mode
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editMilestones, setEditMilestones] = useState<any[]>([]);
  const [editSlots, setEditSlots] = useState<any[]>([]);

  // Milestone completion modal
  const [completingMilestone, setCompletingMilestone] = useState<any>(null);

  // AI chat state for edit panel
  const [editChatMsgs, setEditChatMsgs] = useState<EditChatMsg[]>([]);
  const [editRawHistory, setEditRawHistory] = useState<RawMsg[]>([]);
  const [editChatInput, setEditChatInput] = useState('');
  const [editChatSending, setEditChatSending] = useState(false);
  const editChatBottomRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    getSession().then(({ data: { session } }) => {
      if (session) {
        setCurrentUserId(session.user.id);
        setToken(session.access_token);
      }
    });
  }, []);

  useEffect(() => { fetchProject(); }, [id]);

  const fetchProject = async () => {
    try {
      const response = await axios.get(`/api/projects/${id}`);
      setProject(response.data.project);
    } catch (error) {
      console.error('Failed to fetch project:', error);
    } finally {
      setLoading(false);
    }
  };

  const isCreator = !!currentUserId && !!project && project.planner?.id === currentUserId;

  const enterEditMode = () => {
    setEditTitle(project.title);
    setEditSummary(project.summary);
    setEditCategory(project.category);
    setEditMilestones(project.milestones.map((m: any) => ({ ...m })));
    setEditSlots((project.requiredRoles ?? []).map((r: any) => ({ ...r })));
    setSaveError('');
    setEditChatMsgs([{ role: 'assistant', text: `I'm ready to help you refine this project. What would you like to change? You can ask me to update the title, summary, milestones, budget allocation, or service slots.` }]);
    setEditRawHistory([]);
    setEditChatInput('');
    setEditMode(true);
  };

  useEffect(() => {
    editChatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [editChatMsgs, editChatSending]);

  const handleEditChat = async () => {
    if (!editChatInput.trim() || editChatSending) return;
    const userText = editChatInput.trim();
    setEditChatInput('');
    setEditChatSending(true);

    const updatedMsgs: EditChatMsg[] = [...editChatMsgs, { role: 'user', text: userText }];
    setEditChatMsgs(updatedMsgs);

    // Build a blueprint-shaped object from the current edit state
    const currentBlueprint = {
      title: editTitle,
      summary: editSummary,
      category: editCategory,
      milestones: editMilestones.map(m => ({
        title: m.title,
        description: m.description,
        fundingPercentage: m.fundingPercentage,
        durationDays: m.durationDays,
        status: m.status,
      })),
      serviceSlots: editSlots.map(s => ({
        role: s.role,
        description: s.description,
        milestoneTitle: editMilestones.find(m => m.id === s.milestoneId)?.title ?? '',
      })),
    };

    try {
      const res = await axios.post('/api/ai/refine-blueprint', {
        currentBlueprint,
        message: userText,
        conversationHistory: editRawHistory,
      });
      const refined = res.data.blueprint;
      // Apply AI changes to edit fields
      if (refined.title) setEditTitle(refined.title);
      if (refined.summary) setEditSummary(refined.summary);
      if (refined.category) setEditCategory(refined.category);
      if (refined.milestones?.length > 0) {
        setEditMilestones(refined.milestones.map((m: any, i: number) => ({
          id: editMilestones[i]?.id ?? `new-${Date.now()}-${i}`,
          title: m.title,
          description: m.description,
          fundingPercentage: m.fundingPercentage,
          durationDays: m.durationDays,
          status: editMilestones[i]?.status ?? 'PENDING',
        })));
      }
      if (refined.serviceSlots?.length > 0) {
        setEditSlots(refined.serviceSlots.map((s: any, i: number) => ({
          id: editSlots[i]?.id ?? `new-slot-${Date.now()}-${i}`,
          role: s.role,
          description: s.description,
          milestoneId: editMilestones.find(m => m.title === s.milestoneTitle)?.id ?? '',
        })));
      }
      const aiMsg = res.data.message || 'Done — I updated the blueprint on the left.';
      setEditChatMsgs([...updatedMsgs, { role: 'assistant', text: aiMsg }]);
      setEditRawHistory([
        ...editRawHistory,
        { role: 'user', content: `Current blueprint:\n${JSON.stringify(currentBlueprint, null, 2)}\n\nMy request: ${userText}` },
        { role: 'assistant', content: aiMsg },
      ]);
    } catch (err: any) {
      const errMsg = err.response?.data?.details || err.response?.data?.error || 'Failed to process request.';
      setEditChatMsgs([...updatedMsgs, { role: 'assistant', text: errMsg }]);
    } finally {
      setEditChatSending(false);
      setTimeout(() => editInputRef.current?.focus(), 50);
    }
  };

  const saveProject = async () => {
    setSaving(true);
    setSaveError('');
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: editTitle,
          summary: editSummary,
          category: editCategory,
          milestones: editMilestones,
          requiredRoles: editSlots,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        setSaveError(err.error || 'Failed to save');
        return;
      }
      const data = await res.json();
      setProject(data.project);
      setEditMode(false);
    } catch {
      setSaveError('Network error');
    } finally {
      setSaving(false);
    }
  };

  const updateMilestone = (idx: number, field: string, value: any) => {
    setEditMilestones(prev => prev.map((m, i) => i === idx ? { ...m, [field]: value } : m));
  };

  const addMilestone = () => {
    setEditMilestones(prev => [...prev, { id: `new-${Date.now()}`, title: '', description: '', fundingPercentage: 0, durationDays: 30, status: 'PENDING' }]);
  };

  const removeMilestone = (idx: number) => {
    setEditMilestones(prev => prev.filter((_, i) => i !== idx));
  };

  const updateSlot = (idx: number, field: string, value: any) => {
    setEditSlots(prev => prev.map((s, i) => i === idx ? { ...s, [field]: value } : s));
  };

  const addSlot = () => {
    setEditSlots(prev => [...prev, { id: `new-slot-${Date.now()}`, role: '', description: '', milestoneId: '' }]);
  };

  const removeSlot = (idx: number) => {
    setEditSlots(prev => prev.filter((_, i) => i !== idx));
  };

  const toEth = (amount: string) => {
    try { return (Number(BigInt(amount)) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 }); }
    catch { return '0'; }
  };

  const fundingPct = (raised: string, goal: string) => {
    try {
      const r = Number(BigInt(raised)), g = Number(BigInt(goal));
      if (g === 0) return 0;
      return Math.min(Math.round((r / g) * 100), 100);
    } catch { return 0; }
  };

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#080c10' }}>
      <p style={{ color: '#6b7280', fontSize: 14 }}>{t('project.loading')}</p>
    </div>
  );
  if (!project) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#080c10' }}>
      <p style={{ color: '#6b7280', fontSize: 14 }}>{t('project.not_found')}</p>
    </div>
  );

  const progress = fundingPct(project.fundingRaised, project.fundingGoal);

  return (
    <div className="min-h-screen" style={{ background: '#080c10' }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">

        {/* Breadcrumb */}
        <Link to="/dashboard" className="inline-flex items-center gap-1.5 text-sm mb-6 transition-opacity hover:opacity-80" style={{ color: '#6b7280' }}>
          {t('project.back')}
        </Link>

        {/* Title row */}
        <div className="flex flex-wrap items-start justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold mb-2" style={{ color: '#e8f4f0' }}>{lang === 'es' ? project.titleEs || project.title : project.title}</h1>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{
                background: project.status === 'ACTIVE' ? 'rgba(16,185,129,0.12)' : 'rgba(107,114,128,0.12)',
                color: project.status === 'ACTIVE' ? '#10b981' : '#9ca3af',
              }}>
                {t(`status.${project.status.toLowerCase()}` as any) || project.status}
              </span>
              {isCreator && !editMode && (
                <button
                  onClick={enterEditMode}
                  className="text-xs font-medium px-3 py-1 rounded-lg transition-opacity hover:opacity-80"
                  style={{ background: 'rgba(0,229,196,0.1)', color: '#00e5c4', border: '1px solid rgba(0,229,196,0.25)' }}
                >
                  ✎ Edit project
                </button>
              )}
            </div>
          </div>
          <button
            onClick={() => setShowInvest(true)}
            className="px-6 py-2.5 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90"
            style={{ background: '#00e5c4', color: '#080c10' }}
          >
            {t('project.fund_btn')}
          </button>
        </div>

        {/* Reality Check — pre-funding budget verification gate */}
        <RealityCheckPanel
          projectId={project.id}
          isProposer={isCreator}
          authToken={token || undefined}
          onChange={fetchProject}
        />

        {/* Edit panel — shown only to creator */}
        {editMode && (
          <div className="mb-8 rounded-xl overflow-hidden" style={{ background: '#0d1520', border: '1px solid rgba(0,229,196,0.3)' }}>
            {/* Header row */}
            <div className="flex items-center justify-between px-6 py-3" style={{ borderBottom: '1px solid rgba(0,229,196,0.15)' }}>
              <h2 className="text-base font-semibold" style={{ color: '#00e5c4' }}>Edit project</h2>
              <div className="flex gap-2">
                <button
                  onClick={() => setEditMode(false)}
                  className="text-xs px-3 py-1.5 rounded-lg transition-opacity hover:opacity-80"
                  style={{ background: 'rgba(107,114,128,0.15)', color: '#9ca3af' }}
                >
                  Cancel
                </button>
                <button
                  onClick={saveProject}
                  disabled={saving}
                  className="text-xs font-semibold px-4 py-1.5 rounded-lg transition-opacity hover:opacity-90"
                  style={{ background: '#00e5c4', color: '#080c10' }}
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </div>
            {saveError && <p className="mx-6 mt-3 text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171' }}>{saveError}</p>}

            {/* Two-column body */}
            <div className="flex flex-col lg:flex-row" style={{ minHeight: 520 }}>

              {/* Left — form fields */}
              <div className="lg:w-[45%] p-5 overflow-y-auto space-y-4" style={{ borderRight: '1px solid #1e2d3d' }}>

                {/* Basic fields */}
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: '#9ca3af' }}>Title</label>
                    <input
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                      style={{ background: '#0a1420', border: '1px solid #1e2d3d', color: '#e5e7eb' }}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: '#9ca3af' }}>Summary</label>
                    <textarea
                      value={editSummary}
                      onChange={e => setEditSummary(e.target.value)}
                      rows={3}
                      className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none"
                      style={{ background: '#0a1420', border: '1px solid #1e2d3d', color: '#e5e7eb' }}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: '#9ca3af' }}>Category</label>
                    <select
                      value={editCategory}
                      onChange={e => setEditCategory(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                      style={{ background: '#0a1420', border: '1px solid #1e2d3d', color: '#e5e7eb' }}
                    >
                      {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>

                {/* Milestones */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium" style={{ color: '#9ca3af' }}>Milestones</label>
                    <button onClick={addMilestone} className="text-xs px-2 py-1 rounded" style={{ background: 'rgba(0,229,196,0.1)', color: '#00e5c4' }}>+ Add</button>
                  </div>
                  <div className="space-y-3">
                    {editMilestones.map((m, idx) => (
                      <div key={m.id} className="rounded-lg p-3 space-y-2" style={{ background: '#0a1420', border: '1px solid #1e2d3d' }}>
                        <div className="flex gap-2">
                          <input
                            value={m.title}
                            onChange={e => updateMilestone(idx, 'title', e.target.value)}
                            placeholder="Title"
                            className="flex-1 px-2 py-1.5 rounded text-xs outline-none"
                            style={{ background: '#080c10', border: '1px solid #1e2d3d', color: '#e5e7eb' }}
                          />
                          <button onClick={() => removeMilestone(idx)} className="text-xs px-2 rounded" style={{ color: '#6b7280' }}>✕</button>
                        </div>
                        <input
                          value={m.description}
                          onChange={e => updateMilestone(idx, 'description', e.target.value)}
                          placeholder="Description"
                          className="w-full px-2 py-1.5 rounded text-xs outline-none"
                          style={{ background: '#080c10', border: '1px solid #1e2d3d', color: '#e5e7eb' }}
                        />
                        <div className="flex gap-2">
                          <div className="flex-1">
                            <label className="text-[10px] mb-0.5 block" style={{ color: '#6b7280' }}>Funding %</label>
                            <input
                              type="number" min={1} max={100}
                              value={m.fundingPercentage}
                              onChange={e => updateMilestone(idx, 'fundingPercentage', Number(e.target.value))}
                              className="w-full px-2 py-1.5 rounded text-xs outline-none"
                              style={{ background: '#080c10', border: '1px solid #1e2d3d', color: '#e5e7eb' }}
                            />
                          </div>
                          <div className="flex-1">
                            <label className="text-[10px] mb-0.5 block" style={{ color: '#6b7280' }}>Duration (days)</label>
                            <input
                              type="number" min={1}
                              value={m.durationDays}
                              onChange={e => updateMilestone(idx, 'durationDays', Number(e.target.value))}
                              className="w-full px-2 py-1.5 rounded text-xs outline-none"
                              style={{ background: '#080c10', border: '1px solid #1e2d3d', color: '#e5e7eb' }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Service slots */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium" style={{ color: '#9ca3af' }}>Service slots</label>
                    <button onClick={addSlot} className="text-xs px-2 py-1 rounded" style={{ background: 'rgba(0,229,196,0.1)', color: '#00e5c4' }}>+ Add</button>
                  </div>
                  <div className="space-y-2">
                    {editSlots.map((s, idx) => (
                      <div key={s.id} className="rounded-lg p-3 space-y-2" style={{ background: '#0a1420', border: '1px solid #1e2d3d' }}>
                        <div className="flex gap-2">
                          <input
                            value={s.role}
                            onChange={e => updateSlot(idx, 'role', e.target.value)}
                            placeholder="Role (e.g. Legal Counsel)"
                            className="flex-1 px-2 py-1.5 rounded text-xs outline-none"
                            style={{ background: '#080c10', border: '1px solid #1e2d3d', color: '#e5e7eb' }}
                          />
                          <button onClick={() => removeSlot(idx)} className="text-xs px-2 rounded" style={{ color: '#6b7280' }}>✕</button>
                        </div>
                        <input
                          value={s.description}
                          onChange={e => updateSlot(idx, 'description', e.target.value)}
                          placeholder="Description"
                          className="w-full px-2 py-1.5 rounded text-xs outline-none"
                          style={{ background: '#080c10', border: '1px solid #1e2d3d', color: '#e5e7eb' }}
                        />
                        <div>
                          <label className="text-[10px] mb-0.5 block" style={{ color: '#6b7280' }}>Linked milestone</label>
                          <select
                            value={s.milestoneId}
                            onChange={e => updateSlot(idx, 'milestoneId', e.target.value)}
                            className="w-full px-2 py-1.5 rounded text-xs outline-none"
                            style={{ background: '#080c10', border: '1px solid #1e2d3d', color: '#e5e7eb' }}
                          >
                            <option value="">— none —</option>
                            {editMilestones.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
                          </select>
                        </div>
                      </div>
                    ))}
                    {editSlots.length === 0 && (
                      <p className="text-xs" style={{ color: '#4b5563' }}>No service slots yet.</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Right — AI chat */}
              <div className="lg:w-[55%] flex flex-col min-h-0" style={{ minHeight: 400 }}>
                {/* Chat header */}
                <div className="flex items-center gap-3 px-5 py-3 flex-shrink-0" style={{ borderBottom: '1px solid #1e2d3d' }}>
                  <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: '#00e5c4' }} />
                  <span className="text-sm font-medium" style={{ color: '#e8f4f0' }}>AI assistant</span>
                  <span className="text-xs" style={{ color: '#6b7280' }}>Ask me to change anything — fields update live</span>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4" style={{ maxHeight: 380 }}>
                  {editChatMsgs.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className="max-w-[88%] rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap"
                        style={msg.role === 'user'
                          ? { background: 'rgba(0,229,196,0.10)', color: '#e8f4f0', border: '1px solid rgba(0,229,196,0.18)' }
                          : { background: '#111d2b', color: '#9ca3af', border: '1px solid #1e2d3d' }}
                      >
                        {msg.text}
                      </div>
                    </div>
                  ))}
                  {editChatSending && (
                    <div className="flex justify-start">
                      <div className="rounded-xl px-4 py-3.5" style={{ background: '#111d2b', border: '1px solid #1e2d3d' }}>
                        <span className="flex gap-1.5 items-center">
                          {[0,1,2].map(i => (
                            <span key={i} className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: '#6b7280', animationDelay: `${i * 0.12}s` }} />
                          ))}
                        </span>
                      </div>
                    </div>
                  )}
                  <div ref={editChatBottomRef} />
                </div>

                {/* Input */}
                <div className="px-4 py-3 flex-shrink-0" style={{ borderTop: '1px solid #1e2d3d' }}>
                  <div className="flex gap-2 items-end">
                    <textarea
                      ref={editInputRef}
                      value={editChatInput}
                      onChange={e => setEditChatInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditChat(); } }}
                      rows={2}
                      disabled={editChatSending}
                      placeholder="e.g. Shorten the timeline by 2 weeks, add a QA milestone, change category to technology…"
                      className="flex-1 rounded-lg px-3 py-2.5 text-sm outline-none resize-none"
                      style={{ background: '#080c10', border: '1px solid #1e2d3d', color: '#e8f4f0' }}
                    />
                    <button
                      onClick={handleEditChat}
                      disabled={editChatSending || !editChatInput.trim()}
                      className="p-2.5 rounded-lg transition-opacity hover:opacity-90 disabled:opacity-40 flex-shrink-0"
                      style={{ background: '#00e5c4', color: '#080c10' }}
                    >
                      <Send size={16} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Milestone calendar — full width */}
          <div className="col-span-full">
            <MilestoneCalendar milestones={project.milestones} projectCreatedAt={project.createdAt} />
          </div>

          {/* Left column */}
          <div className="lg:col-span-2 space-y-5">
            {/* About */}
            <div className="rounded-xl p-6" style={{ background: '#0d1520', border: '1px solid #1e2d3d' }}>
              <h2 className="text-base font-semibold mb-3" style={{ color: '#e8f4f0' }}>{t('project.about')}</h2>
              <p className="text-sm leading-relaxed" style={{ color: '#9ca3af' }}>{lang === 'es' ? project.summaryEs || project.summary : project.summary}</p>
            </div>

            {/* Milestones */}
            <div className="rounded-xl p-6" style={{ background: '#0d1520', border: '1px solid #1e2d3d' }}>
              <h2 className="text-base font-semibold mb-4" style={{ color: '#e8f4f0' }}>{t('project.milestones')}</h2>
              <div className="space-y-4">
                {project.milestones.map((m: any, i: number) => {
                  const s = STATUS_STYLES[m.status] || STATUS_STYLES.PENDING;
                  return (
                    <div key={m.id} className="flex gap-4">
                      {/* Step indicator */}
                      <div className="flex flex-col items-center">
                        <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0" style={{ background: s.bg, color: s.color, border: `1px solid ${s.color}40` }}>
                          {i + 1}
                        </div>
                        {i < project.milestones.length - 1 && (
                          <div className="w-px flex-1 mt-1" style={{ background: '#1e2d3d' }} />
                        )}
                      </div>
                      <div className="pb-4 flex-1">
                        <div className="flex items-center justify-between mb-1">
                          <h3 className="text-sm font-semibold" style={{ color: '#e8f4f0' }}>{lang === 'es' ? m.titleEs || m.title : m.title}</h3>
                          <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: s.bg, color: s.color }}>{t(`status.${m.status.toLowerCase()}` as any) || m.status}</span>
                        </div>
                        <p className="text-xs mb-2" style={{ color: '#6b7280' }}>{lang === 'es' ? m.descriptionEs || m.description : m.description}</p>
                        <div className="flex items-center justify-between mt-2">
                          <div className="flex gap-4 text-xs" style={{ color: '#6b7280' }}>
                            <span>{m.fundingPercentage}% of funding</span>
                            <span>{m.durationDays} days</span>
                          </div>
                          {isCreator && m.status !== 'COMPLETED' && m.status !== 'EVIDENCE_REVIEW' && (
                            <button
                              onClick={() => setCompletingMilestone(m)}
                              className="text-xs px-2.5 py-1 rounded-lg transition-opacity hover:opacity-80"
                              style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.2)' }}
                            >
                              Complete →
                            </button>
                          )}
                          {m.status === 'EVIDENCE_REVIEW' && (
                            <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b' }}>⏳ Under review</span>
                          )}
                          {m.status === 'COMPLETED' && (
                            <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'rgba(16,185,129,0.1)', color: '#10b981' }}>✓ Completed</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Providers Needed */}
            <div className="rounded-xl p-6" style={{ background: '#0d1520', border: '1px solid #1e2d3d' }}>
              <h2 className="text-base font-semibold mb-4" style={{ color: '#e8f4f0' }}>{t('roles.title')}</h2>
              {!project.requiredRoles || project.requiredRoles.length === 0 ? (
                <p className="text-sm" style={{ color: '#6b7280' }}>{t('roles.empty')}</p>
              ) : (
                <div className="space-y-4">
                  {project.requiredRoles.map((role: any) => {
                    const linkedMilestone = project.milestones.find((m: any) => m.id === role.milestoneId);
                    return (
                      <div
                        key={role.id}
                        className="rounded-lg p-4"
                        style={{ background: '#0a1420', border: '1px solid #1e2d3d' }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold mb-1" style={{ color: '#e8f4f0' }}>{role.role}</p>
                            <p className="text-xs leading-relaxed mb-2" style={{ color: '#6b7280' }}>{role.description}</p>
                            {linkedMilestone && (
                              <span
                                className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
                                style={{ background: 'rgba(0,229,196,0.08)', color: '#00e5c4', border: '1px solid rgba(0,229,196,0.15)' }}
                              >
                                {t('roles.milestone')}: {linkedMilestone.title}
                              </span>
                            )}
                          </div>
                          <button
                            onClick={() => setBidRole(role)}
                            className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-opacity hover:opacity-80"
                            style={{ background: 'rgba(0,229,196,0.12)', color: '#00e5c4', border: '1px solid rgba(0,229,196,0.2)' }}
                          >
                            {t('roles.bid_btn')}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right column */}
          <div className="space-y-5">
            {/* Funding card */}
            <div className="rounded-xl p-6" style={{ background: '#0d1520', border: '1px solid #1e2d3d' }}>
              <h3 className="text-sm font-semibold mb-4" style={{ color: '#9ca3af' }}>{t('project.funding')}</h3>
              <div className="text-3xl font-bold mb-0.5" style={{ color: '#00e5c4' }}>
                {toEth(project.fundingRaised)} ETH
              </div>
              <div className="text-xs mb-4" style={{ color: '#6b7280' }}>
                of {toEth(project.fundingGoal)} ETH goal
              </div>
              <div className="w-full rounded-full h-2 mb-1" style={{ background: '#1e2d3d' }}>
                <div className="h-2 rounded-full" style={{ width: `${progress}%`, background: '#00e5c4' }} />
              </div>
              <div className="text-xs text-right mb-5" style={{ color: '#9ca3af' }}>{progress}%</div>
              <button
                onClick={() => setShowInvest(true)}
                className="w-full py-2.5 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90"
                style={{ background: '#00e5c4', color: '#080c10' }}
              >
                {t('project.fund_btn')}
              </button>
            </div>

            {/* Recent activity */}
            {project.investments?.length > 0 && (
              <div className="rounded-xl p-6" style={{ background: '#0d1520', border: '1px solid #1e2d3d' }}>
                <h3 className="text-sm font-semibold mb-3" style={{ color: '#9ca3af' }}>{t('project.activity')}</h3>
                <div className="space-y-2.5">
                  {project.investments.slice(0, 5).map((inv: any) => (
                    <div key={inv.id} className="flex items-center justify-between">
                      <span className="text-xs" style={{ color: '#6b7280' }}>{t('dashboard.community')}</span>
                      <span className="text-xs font-semibold font-mono" style={{ color: '#e8f4f0' }}>{toEth(inv.amount)} ETH</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Telemetry */}
            {project.telemetry?.length > 0 && (
              <div className="rounded-xl p-6" style={{ background: '#0d1520', border: '1px solid #1e2d3d' }}>
                <h3 className="text-sm font-semibold mb-3" style={{ color: '#9ca3af' }}>{t('project.telemetry')}</h3>
                <div className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span style={{ color: '#6b7280' }}>{t('project.uptime')}</span>
                    <span className="font-semibold" style={{ color: '#e8f4f0' }}>{project.telemetry[0].data.uptimePercent?.toFixed(1)}%</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span style={{ color: '#6b7280' }}>{t('project.battery')}</span>
                    <span className="font-semibold" style={{ color: '#e8f4f0' }}>{project.telemetry[0].data.batteryPercent?.toFixed(0)}%</span>
                  </div>
                </div>
                <Link to={`/reports/${project.id}`} className="block mt-4 text-xs font-medium transition-opacity hover:opacity-80" style={{ color: '#00e5c4' }}>
                  {t('project.reports')}
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Evidence Review + Money Flow + Voting + Ledger */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-10 space-y-6">
        <EvidenceReview
          projectId={project.id}
          isOwner={isCreator}
          currentUserId={currentUserId}
          onResolved={fetchProject}
        />
        <MoneyFlowDiagram projectId={project.id} />
        <VotingSection projectId={project.id} milestones={project.milestones} />
        <TransactionLedger projectId={project.id} />
      </div>

      {showInvest && (
        <InvestModal
          projectId={project.id}
          projectTitle={project.title}
          onClose={() => { setShowInvest(false); fetchProject(); }}
        />
      )}

      {bidRole && (
        <BidModal
          projectId={project.id}
          projectTitle={project.title}
          role={bidRole}
          milestones={project.milestones}
          onClose={() => setBidRole(null)}
          onSubmitted={() => { setBidRole(null); }}
        />
      )}

      {completingMilestone && (
        <MilestoneCompletion
          projectId={project.id}
          milestone={completingMilestone}
          onClose={() => setCompletingMilestone(null)}
          onCompleted={() => { setCompletingMilestone(null); fetchProject(); }}
        />
      )}
    </div>
  );
}
