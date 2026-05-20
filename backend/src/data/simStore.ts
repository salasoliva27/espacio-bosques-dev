/**
 * In-memory simulation store with JSON persistence.
 * Shared between routes so that investments + projects survive a restart.
 *
 * Goals are intentionally small (1 ETH = ~65,000 MXN) so that a typical
 * 1,000 MXN investment (~0.015 ETH) produces ~1.5% visible progress.
 */

import * as fs from 'fs';
import * as path from 'path';

// 1 ETH in wei
const ETH = BigInt('1000000000000000000');

const DATA_FILE = path.join(__dirname, '../../sim-data.json');

export interface SimProject {
  id: string;
  title: string;
  summary: string;
  category: string;
  status: string;
  fundingGoal: string;
  fundingRaised: string;
  createdAt: Date;
  updatedAt: Date;
  planner: { id: string; walletAddress: string; role: string };
  milestones: {
    id: string;
    title: string;
    status: string;
    fundingPercentage: number;
    description: string;
    durationDays: number;
  }[];
  requiredRoles?: { id: string; role: string; description: string; milestoneId?: string }[];
  investments: { id: string; amount: string; investor: { id: string; walletAddress: string } }[];
  telemetry: { id: string; timestamp: Date; data: Record<string, unknown> }[];
  reports: unknown[];
  _count: { investments: number };
}

export interface SimComment {
  id: string;
  projectId: string;
  userId: string;
  walletAddress: string;
  username: string;
  text: string;
  createdAt: string; // ISO string for easy serialization
}

// Clean launch: no pre-seeded projects. All projects are created by users via the UI.
export const DEMO_PROJECTS: SimProject[] = [];

// ── Comments store ─────────────────────────────────────────────────────
const commentStore = new Map<string, SimComment[]>();

// ── Persistence ───────────────────────────────────────────────────────

function loadPersistedData(): void {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);

    if (Array.isArray(data.projects)) {
      for (const p of data.projects) {
        if (!DEMO_PROJECTS.find(d => d.id === p.id)) {
          DEMO_PROJECTS.push({
            ...p,
            createdAt: new Date(p.createdAt),
            updatedAt: new Date(p.updatedAt),
            investments: (p.investments || []).map((inv: any) => ({
              ...inv,
              createdAt: inv.createdAt ? new Date(inv.createdAt) : undefined,
            })),
          });
        }
      }
    }

    if (data.comments && typeof data.comments === 'object') {
      for (const [projectId, comments] of Object.entries(data.comments as Record<string, SimComment[]>)) {
        const existing = commentStore.get(projectId) ?? [];
        const existingIds = new Set(existing.map(c => c.id));
        const newComments = (comments as SimComment[]).filter(c => !existingIds.has(c.id));
        if (newComments.length > 0) {
          commentStore.set(projectId, [...existing, ...newComments]);
        }
      }
    }

    // Restore provider profiles
    if (data.providerProfiles && typeof data.providerProfiles === 'object') {
      for (const [userId, profile] of Object.entries(data.providerProfiles as Record<string, ProviderUserProfile>)) {
        providerProfileStore.set(userId, profile as ProviderUserProfile);
      }
    }

    // Restore user balances
    if (data.balances && typeof data.balances === 'object') {
      for (const [userId, balance] of Object.entries(data.balances as Record<string, number>)) {
        userBalances.set(userId, Number(balance));
      }
    }

    // Restore reality checks (one per projectId, keyed by projectId)
    if (data.realityChecks && typeof data.realityChecks === 'object') {
      for (const [projectId, check] of Object.entries(data.realityChecks as Record<string, SimRealityCheck>)) {
        realityCheckStore.set(projectId, check);
      }
    }
  } catch {
    // Ignore load errors — start fresh
  }
}

export function persistData(): void {
  try {
    const userCreatedProjects = DEMO_PROJECTS.filter(p => p.id.startsWith('sim-'));
    const commentsObj: Record<string, SimComment[]> = {};
    commentStore.forEach((comments, projectId) => {
      commentsObj[projectId] = comments;
    });
    const providerProfilesObj: Record<string, ProviderUserProfile> = {};
    providerProfileStore.forEach((profile, userId) => {
      providerProfilesObj[userId] = profile;
    });
    // Persist user balances so they survive restarts
    const balancesObj: Record<string, number> = {};
    userBalances.forEach((balance, userId) => {
      balancesObj[userId] = balance;
    });
    const realityChecksObj: Record<string, SimRealityCheck> = {};
    realityCheckStore.forEach((check, projectId) => {
      realityChecksObj[projectId] = check;
    });
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      projects: userCreatedProjects,
      comments: commentsObj,
      providerProfiles: providerProfilesObj,
      balances: balancesObj,
      realityChecks: realityChecksObj,
    }, null, 2), 'utf8');
  } catch {
    // Ignore write errors
  }
}

/** Full sim reset — wipes all funding, investments, balances, user-created projects, and comments. Preserves provider profiles. */
export function resetSimFull(): void {
  // Reset all demo project funding and investments
  for (const p of DEMO_PROJECTS) {
    p.fundingRaised = '0';
    p.investments = [];
    p._count.investments = 0;
  }
  // Remove user-created projects
  const userProjectIds = DEMO_PROJECTS.filter(p => p.id.startsWith('sim-')).map(p => p.id);
  for (const id of userProjectIds) {
    const idx = DEMO_PROJECTS.findIndex(p => p.id === id);
    if (idx !== -1) DEMO_PROJECTS.splice(idx, 1);
  }
  // Clear balances
  userBalances.clear();
  // Clear comments
  commentStore.clear();
  // NOTE: providerProfileStore is intentionally NOT cleared — provider company
  // profiles and services survive a full reset so users don't lose their work.
  // Persist remaining state (provider profiles) to disk
  persistData();
}

/** Add a user-created sim project to the store and persist it. */
export function addSimProject(project: SimProject): void {
  DEMO_PROJECTS.unshift(project);
  persistData();
}

// ── Comments ──────────────────────────────────────────────────────────

export function getProjectComments(projectId: string): SimComment[] {
  return (commentStore.get(projectId) ?? []).slice().reverse(); // newest first
}

export function addProjectComment(comment: SimComment): void {
  const existing = commentStore.get(comment.projectId) ?? [];
  commentStore.set(comment.projectId, [...existing, comment]);
  persistData();
}

// ── Likes ─────────────────────────────────────────────────────────────
// projectId → Set of userIds who liked it
const likesStore = new Map<string, Set<string>>();

export function toggleLike(projectId: string, userId: string): { liked: boolean; count: number } {
  const likers = likesStore.get(projectId) ?? new Set<string>();
  if (likers.has(userId)) {
    likers.delete(userId);
  } else {
    likers.add(userId);
  }
  likesStore.set(projectId, likers);
  return { liked: likers.has(userId), count: likers.size };
}

export function getLikes(projectId: string, userId?: string): { count: number; liked: boolean } {
  const likers = likesStore.get(projectId) ?? new Set<string>();
  return { count: likers.size, liked: userId ? likers.has(userId) : false };
}

// ── Balances ──────────────────────────────────────────────────────────

export interface SimUserInvestment {
  id: string;
  projectId: string;
  projectTitle: string;
  projectCategory: string;
  ethAmount: number;
  mxnAmount: number;
  createdAt: Date;
}

const ETH_MXN_RATE = 65000;
const DEFAULT_SIM_BALANCE_MXN = 0; // Users must deposit to invest — clean launch state
const userBalances = new Map<string, number>();

export function getSimBalance(userId: string): number {
  if (!userBalances.has(userId)) userBalances.set(userId, DEFAULT_SIM_BALANCE_MXN);
  return userBalances.get(userId)!;
}

export function addSimBalance(userId: string, mxn: number): number {
  const current = getSimBalance(userId);
  const next = Math.max(0, current + mxn);
  userBalances.set(userId, next);
  persistData();
  return next;
}

export function deductSimBalance(userId: string, mxn: number): boolean {
  const current = getSimBalance(userId);
  if (current < mxn) return false;
  userBalances.set(userId, current - mxn);
  persistData();
  return true;
}

export function getSimUserInvestments(userId: string): SimUserInvestment[] {
  const results: SimUserInvestment[] = [];
  for (const project of DEMO_PROJECTS) {
    for (const inv of project.investments) {
      if (inv.investor.id !== userId) continue;
      const ethAmount = Number(BigInt(inv.amount)) / 1e18;
      const mxnAmount = (inv as any).mxn ?? Math.round(ethAmount * ETH_MXN_RATE);
      results.push({
        id: inv.id,
        projectId: project.id,
        projectTitle: project.title,
        projectCategory: project.category,
        ethAmount,
        mxnAmount,
        createdAt: (inv as any).createdAt ?? project.updatedAt,
      });
    }
  }
  return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export function addSimInvestment(projectId: string, ethAmount: number, mxnAmount?: number, userId?: string): boolean {
  const project = DEMO_PROJECTS.find((p) => p.id === projectId);
  if (!project) return false;

  const weiAmount = BigInt(Math.round(ethAmount * 1e12)) * BigInt(1e6);
  project.fundingRaised = (BigInt(project.fundingRaised) + weiAmount).toString();
  project.updatedAt = new Date();

  const inv: any = {
    id: `sim-inv-${Date.now()}`,
    amount: weiAmount.toString(),
    investor: { id: userId ?? 'sim-user', walletAddress: '0xsimulated' },
    mxn: mxnAmount ?? Math.round(ethAmount * ETH_MXN_RATE),
    createdAt: new Date(),
  };
  project.investments.push(inv);
  project._count.investments += 1;

  persistData();
  return true;
}

// ── Provider User Profiles ────────────────────────────────────────────

export interface ProviderService {
  id: string;
  name: string;
  description: string;
  deliverables: string[];
  typicalPriceMxn: string;
  chatMessages: { role: 'user' | 'assistant'; content: string }[];
  finalized: boolean;
  createdAt: string;
}

export interface ProviderUserProfile {
  userId: string;
  enabled: boolean;
  companyName: string;
  specialty: string;
  rfc: string;
  services: ProviderService[];
  createdAt: string;
}

const providerProfileStore = new Map<string, ProviderUserProfile>();

export function getProviderUserProfile(userId: string): ProviderUserProfile | null {
  return providerProfileStore.get(userId) ?? null;
}

export function upsertProviderUserProfile(userId: string, data: Partial<Omit<ProviderUserProfile, 'userId'>>): ProviderUserProfile {
  const existing = providerProfileStore.get(userId) ?? {
    userId, enabled: false, companyName: '', specialty: '', rfc: '', services: [], createdAt: new Date().toISOString(),
  };
  const updated = { ...existing, ...data, userId };
  providerProfileStore.set(userId, updated);
  persistData();
  return updated;
}

export function addProviderService(userId: string, service: ProviderService): ProviderUserProfile {
  const profile = upsertProviderUserProfile(userId, {});
  profile.services.push(service);
  providerProfileStore.set(userId, profile);
  persistData();
  return profile;
}

export function updateProviderService(userId: string, serviceId: string, data: Partial<ProviderService>): ProviderService | null {
  const profile = providerProfileStore.get(userId);
  if (!profile) return null;
  const idx = profile.services.findIndex(s => s.id === serviceId);
  if (idx === -1) return null;
  profile.services[idx] = { ...profile.services[idx], ...data };
  persistData();
  return profile.services[idx];
}

export function deleteProviderService(userId: string, serviceId: string): boolean {
  const profile = providerProfileStore.get(userId);
  if (!profile) return false;
  const idx = profile.services.findIndex(s => s.id === serviceId);
  if (idx === -1) return false;
  profile.services.splice(idx, 1);
  persistData();
  return true;
}

// ── Platform Stats ────────────────────────────────────────────────────

export function getSimStats(): {
  projects: number;
  investors: number;
  fundedMxn: number;
  milestones: number;
} {
  const uniqueInvestors = new Set(
    DEMO_PROJECTS.flatMap(p => p.investments.map(i => i.investor.id))
  ).size;

  const fundedMxn = DEMO_PROJECTS.reduce((sum, p) => {
    const ethRaised = Number(BigInt(p.fundingRaised)) / 1e18;
    return sum + Math.round(ethRaised * ETH_MXN_RATE);
  }, 0);

  const milestones = DEMO_PROJECTS.reduce((sum, p) => sum + p.milestones.length, 0);

  return {
    projects: DEMO_PROJECTS.length,
    investors: uniqueInvestors,
    fundedMxn,
    milestones,
  };
}

// ── Reality Check ─────────────────────────────────────────────────────
/**
 * Pre-funding "Reality Check" gate. A project that has been drafted by
 * the user (with AI assistance) is run through a market-rate sanity check
 * before it can transition to PENDING / open-for-funding.
 *
 * State machine (lives on SimProject.status):
 *   REALITY_CHECK_PENDING   → Layer 1 (AI market-rate pass) running or queued
 *   REALITY_CHECK_ADJUST    → Layer 2 — proposer must accept the adjusted
 *                             number or attach a justification for the delta
 *   PENDING                 → passed Reality Check, open for funding
 *   (REALITY_CHECK_EXPERT is reserved for the Layer-3 community-expert
 *    escalation; not implemented in this PR — deferred to a follow-up.)
 */

export type RealityCheckState =
  | 'pending'        // Layer 1 in progress or queued
  | 'pass'           // passed; project can move to PENDING
  | 'adjust_required'; // delta exceeds threshold; proposer must act

export type RealityCheckScopeGap =
  | 'permits'
  | 'insurance'
  | 'maintenance'
  | 'iva_retencion'
  | 'contingency'
  | 'other';

export interface RealityCheckItem {
  id: string;
  realityCheckId: string;
  milestoneTitle?: string;
  lineLabel: string;
  proposerEstimateMxn: number;
  benchmarkLowMxn: number | null;
  benchmarkHighMxn: number | null;
  benchmarkMidpointMxn: number | null;
  finalAmountMxn: number;
  deltaPct: number | null;
  confidence: number;
  sources: { url: string; title: string; snippet: string; priceObserved: number | null }[];
  proposerJustification: string | null;
  proposerEvidenceUrls: string[];
  flaggedMissing: boolean;
  missingCategory: RealityCheckScopeGap | null;
}

export interface SimRealityCheck {
  id: string;
  projectId: string;
  revision: number;
  state: RealityCheckState;
  layer1CompletedAt: string | null;
  layer1Confidence: number | null;
  layer1Model: string | null;
  layer1RawResponse: unknown | null;
  proposerTotalMxn: number;
  finalTotalMxn: number;
  benchmarkTotalLowMxn: number;
  benchmarkTotalHighMxn: number;
  items: RealityCheckItem[];
  createdAt: string;
  updatedAt: string;
}

const realityCheckStore = new Map<string, SimRealityCheck>(); // keyed by projectId — only latest revision

export function getRealityCheck(projectId: string): SimRealityCheck | null {
  return realityCheckStore.get(projectId) ?? null;
}

export function putRealityCheck(check: SimRealityCheck): SimRealityCheck {
  check.updatedAt = new Date().toISOString();
  realityCheckStore.set(check.projectId, check);
  persistData();
  return check;
}

export function deleteRealityCheck(projectId: string): boolean {
  const ok = realityCheckStore.delete(projectId);
  if (ok) persistData();
  return ok;
}

export function listRealityChecks(): SimRealityCheck[] {
  return Array.from(realityCheckStore.values());
}

// ── Init ──────────────────────────────────────────────────────────────
loadPersistedData();
