-- ─────────────────────────────────────────────────────────────────────────────
-- 002_reality_check.sql
--
-- Reality Check — pre-funding budget verification gate.
--
-- DO NOT RUN AUTOMATICALLY. This migration is the production target schema for
-- the feature; today (sim mode), Reality Check state lives in the in-memory
-- simStore (backend/src/data/simStore.ts) and is persisted to sim-data.json.
-- Apply this migration only when moving the platform off simulation mode.
--
-- Spec: janus-ia/dump/espacio-bosques-reality-check-spec.md
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists "uuid-ossp";

-- One row per (project_id, revision). Latest revision is the live one.
create table if not exists eb_reality_checks (
  id                          uuid primary key default uuid_generate_v4(),
  project_id                  uuid not null,
  revision                    int  not null default 1,
  state                       text not null check (state in ('pending', 'pass', 'adjust_required', 'expert_required', 'failed')),
  layer1_completed_at         timestamptz,
  layer1_confidence           numeric(3,2) check (layer1_confidence is null or (layer1_confidence >= 0 and layer1_confidence <= 1)),
  layer1_model                text,
  layer1_raw_response         jsonb,
  layer3_triggered            boolean not null default false,
  proposer_total_mxn          numeric(14,2) not null default 0,
  final_total_mxn             numeric(14,2) not null default 0,
  benchmark_total_low_mxn     numeric(14,2) not null default 0,
  benchmark_total_high_mxn    numeric(14,2) not null default 0,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (project_id, revision)
);

create index if not exists eb_reality_checks_project_idx on eb_reality_checks (project_id);

-- One row per line item per check revision.
create table if not exists eb_reality_check_items (
  id                          uuid primary key default uuid_generate_v4(),
  reality_check_id            uuid not null references eb_reality_checks(id) on delete cascade,
  milestone_id                uuid,
  line_label                  text not null,
  proposer_estimate_mxn       numeric(14,2) not null default 0,
  benchmark_low_mxn           numeric(14,2),
  benchmark_high_mxn          numeric(14,2),
  benchmark_midpoint_mxn      numeric(14,2) generated always as ((benchmark_low_mxn + benchmark_high_mxn) / 2) stored,
  final_amount_mxn            numeric(14,2) not null default 0,
  delta_pct                   numeric(7,2),
  confidence                  numeric(3,2) not null check (confidence >= 0 and confidence <= 1),
  sources                     jsonb not null default '[]'::jsonb,
  proposer_justification      text,
  proposer_evidence_urls      jsonb not null default '[]'::jsonb,
  flagged_missing             boolean not null default false,
  missing_category            text check (missing_category is null or missing_category in ('permits','insurance','maintenance','iva_retencion','contingency','other')),
  created_at                  timestamptz not null default now()
);

create index if not exists eb_reality_check_items_rc_idx on eb_reality_check_items (reality_check_id);

-- Layer 3 — community-expert reviewer signoffs. Only populated when the
-- check escalates. Phase 4 of the spec; table created here for forward-compat.
create table if not exists eb_reality_check_reviewers (
  id                          uuid primary key default uuid_generate_v4(),
  reality_check_id            uuid not null references eb_reality_checks(id) on delete cascade,
  reviewer_user_id            uuid not null,
  invited_at                  timestamptz not null default now(),
  responded_at                timestamptz,
  decision                    text not null default 'pending' check (decision in ('pending','approve','reject','abstain')),
  note                        text,
  conflict_disclosed          boolean not null default false
);

create index if not exists eb_reality_check_reviewers_rc_idx on eb_reality_check_reviewers (reality_check_id);

-- ── Row-Level Security ──────────────────────────────────────────────────────
-- Public read after a project transitions to OPEN_FOR_FUNDING (i.e. its
-- linked Reality Check is in state 'pass'). Proposer-only read while in any
-- *_required state. Service-role-only writes.

alter table eb_reality_checks enable row level security;
alter table eb_reality_check_items enable row level security;
alter table eb_reality_check_reviewers enable row level security;

-- TODO before production: add the actual RLS policies once the projects table
-- exists in Supabase (currently sim-only). The shape should be:
--   create policy "public read on passed checks"
--     on eb_reality_checks for select using (state = 'pass');
--   create policy "proposer reads own pending checks"
--     on eb_reality_checks for select
--     using (state <> 'pass' and project_id in (
--       select id from eb_projects where planner_id = auth.uid()));
--
-- Service role bypasses RLS for inserts/updates (backend uses
-- SUPABASE_SERVICE_ROLE_KEY for write paths).
