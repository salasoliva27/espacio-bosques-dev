#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Espacio Bosques — API Test Script
#
# Exercises the full investment flow end-to-end.
# Requires: curl, jq
#
# Usage:
#   ./scripts/test-api.sh                    # full authenticated flow
#   ./scripts/test-api.sh --sim              # quick sim test (no auth)
#   ./scripts/test-api.sh --state            # dump current state only
#   ./scripts/test-api.sh --reset            # reset sim investments
#
# Demo credentials: jano@bosques.mx / Test1234!
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

BACKEND="http://localhost:3001"
SUPABASE_URL="${SUPABASE_URL:?Set SUPABASE_URL in your environment or .env before running this script}"
ANON_KEY="${SUPABASE_ANON_KEY:?Set SUPABASE_ANON_KEY in your environment or .env before running this script}"
DEMO_EMAIL="jano@bosques.mx"
DEMO_PASS="Test1234!"
PROJECT_ID="demo-project-001"
MIN_MXN=100

# ── colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
info() { echo -e "${CYAN}→${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
fail() { echo -e "${RED}✗${NC} $*"; exit 1; }
hdr()  { echo -e "\n${CYAN}━━ $* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

# ── health check ──────────────────────────────────────────────────────────────
check_backend() {
  hdr "Backend health"
  curl -sf "$BACKEND/health" | jq .
}

# ── dump state ────────────────────────────────────────────────────────────────
dump_state() {
  hdr "Current sim state"
  curl -sf "$BACKEND/api/test/state" | jq '.projects[] | {id, title, fundingPct, raisedEth, investmentCount}'
}

# ── reset ─────────────────────────────────────────────────────────────────────
reset_investments() {
  hdr "Reset sim investments"
  curl -sf -X POST "$BACKEND/api/test/reset" | jq .
  ok "Reset complete"
}

# ── sim (no auth) ─────────────────────────────────────────────────────────────
sim_invest() {
  hdr "Seed demo-project-001"
  curl -sf -X POST "$BACKEND/api/test/project/seed" | jq '{seeded, project}'

  hdr "Simulated invest (no auth) — ${MIN_MXN} MXN → ${PROJECT_ID}"
  local result
  result=$(curl -sf -X POST "$BACKEND/api/test/invest" \
    -H 'Content-Type: application/json' \
    -d "{\"projectId\": \"$PROJECT_ID\", \"mxn\": $MIN_MXN}")
  echo "$result" | jq .
  ok "Investment recorded via test harness"

  hdr "User investment history (test user)"
  echo "$result" | jq '.userHistory'
}

# ── full authenticated flow ───────────────────────────────────────────────────
authenticated_flow() {
  # 0. Seed demo project
  hdr "Seed demo-project-001"
  curl -sf -X POST "$BACKEND/api/test/project/seed" | jq '{seeded, project}'

  # 1. Sign in
  hdr "Supabase sign-in (${DEMO_EMAIL})"
  local auth_resp
  auth_resp=$(curl -sf -X POST \
    "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
    -H "apikey: ${ANON_KEY}" \
    -H 'Content-Type: application/json' \
    -d "{\"email\": \"${DEMO_EMAIL}\", \"password\": \"${DEMO_PASS}\"}")
  local TOKEN USER_ID
  TOKEN=$(echo "$auth_resp" | jq -r '.access_token')
  USER_ID=$(echo "$auth_resp" | jq -r '.user.id')
  [[ "$TOKEN" == "null" || -z "$TOKEN" ]] && fail "Auth failed: $(echo "$auth_resp" | jq .)"
  ok "Authenticated as ${USER_ID}"

  # 2. Quote
  hdr "GET /api/invest/quote?mxn=${MIN_MXN}"
  curl -sf "$BACKEND/api/invest/quote?mxn=${MIN_MXN}" | jq .

  # 3. Buy
  hdr "POST /api/invest/buy — ${MIN_MXN} MXN → ${PROJECT_ID}"
  local buy_resp
  buy_resp=$(curl -sf -X POST "$BACKEND/api/invest/buy" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"projectId\": \"${PROJECT_ID}\", \"mxn\": ${MIN_MXN}}")
  echo "$buy_resp" | jq .
  ok "Buy confirmed"

  # 4. Profile investments
  hdr "GET /api/invest/me (user history)"
  curl -sf "$BACKEND/api/invest/me" \
    -H "Authorization: Bearer ${TOKEN}" | jq .

  # 5. State after
  hdr "State after investment"
  curl -sf "$BACKEND/api/test/state" | \
    jq --arg id "$PROJECT_ID" '.projects[] | select(.id == $id) | {fundingPct, raisedEth, investmentCount}'
}

# ── governance flow (no auth required) ───────────────────────────────────────
governance_flow() {
  hdr "Governance state (before seed)"
  curl -sf "$BACKEND/api/test/governance" | jq '.totals'

  hdr "POST /api/test/governance/seed — create proposal + open voting"
  local seed
  seed=$(curl -sf -X POST "$BACKEND/api/test/governance/seed")
  echo "$seed" | jq .
  local PROP_ID
  PROP_ID=$(echo "$seed" | jq -r '.proposal.id')
  ok "Proposal seeded: $PROP_ID"

  hdr "GET /api/governance/milestones/m2/proposals (public)"
  curl -sf "$BACKEND/api/governance/milestones/m2/proposals" \
    -H 'Authorization: Bearer sim-token' | jq '.proposals[] | {id, providerName, quotedAmountMxn, timelineDays}'

  hdr "GET /api/governance/milestones/m2/votes (before voting)"
  curl -sf "$BACKEND/api/governance/milestones/m2/votes" \
    -H 'Authorization: Bearer sim-token' | jq '{totalVotes, votingOpen, myVote}'

  hdr "POST /api/test/governance/vote — cast vote as test-investor-1"
  curl -sf -X POST "$BACKEND/api/test/governance/vote" \
    -H 'Content-Type: application/json' \
    -d "{\"proposalId\": \"$PROP_ID\", \"investorId\": \"test-investor-1\"}" | jq .
  ok "Vote cast"

  hdr "POST /api/test/governance/vote — cast vote as test-investor-2"
  curl -sf -X POST "$BACKEND/api/test/governance/vote" \
    -H 'Content-Type: application/json' \
    -d "{\"proposalId\": \"$PROP_ID\", \"investorId\": \"test-investor-2\"}" | jq .

  hdr "GET /api/governance/milestones/m2/votes (after 2 votes)"
  curl -sf "$BACKEND/api/governance/milestones/m2/votes" \
    -H 'Authorization: Bearer sim-token' | jq '{totalVotes, votingOpen, results}'

  hdr "GET /api/governance/projects/demo-project-001/transactions (ledger)"
  curl -sf "$BACKEND/api/governance/projects/demo-project-001/transactions" | \
    jq '.transactions[] | {milestoneTitle, providerName, bankMasked, amountMxn}'

  hdr "Governance state (after)"
  curl -sf "$BACKEND/api/test/governance" | jq '.totals'

  ok "Governance flow complete"
}

# ── add balance (no auth) ─────────────────────────────────────────────────────
add_balance() {
  local user="${2:-$DEMO_USER_ID}"
  local amount="${3:-5000}"
  hdr "Add balance — ${amount} MXN to ${user}"
  curl -sf -X POST "$BACKEND/api/test/add-balance" \
    -H 'Content-Type: application/json' \
    -d "{\"userId\": \"$user\", \"mxn\": $amount}" | jq .
}

# ── check authenticated balance ───────────────────────────────────────────────
check_balance() {
  hdr "Supabase sign-in (${DEMO_EMAIL})"
  local auth_resp TOKEN
  auth_resp=$(curl -sf -X POST \
    "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
    -H "apikey: ${ANON_KEY}" \
    -H 'Content-Type: application/json' \
    -d "{\"email\": \"${DEMO_EMAIL}\", \"password\": \"${DEMO_PASS}\"}")
  TOKEN=$(echo "$auth_resp" | jq -r '.access_token')
  [[ "$TOKEN" == "null" || -z "$TOKEN" ]] && fail "Auth failed"

  hdr "GET /api/balance/me"
  curl -sf "$BACKEND/api/balance/me" -H "Authorization: Bearer ${TOKEN}" | jq .
}

# ── router ────────────────────────────────────────────────────────────────────
check_backend

case "${1:-}" in
  --state)         dump_state ;;
  --reset)         reset_investments ;;
  --sim)           sim_invest ;;
  --balance)       check_balance ;;
  --add-balance)   add_balance "$@" ;;
  --governance)    governance_flow ;;
  *)               authenticated_flow ;;
esac

echo ""
ok "Done."
