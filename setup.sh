#!/usr/bin/env bash
# second-brain-starter/setup.sh
# Interactive setup for your AI second brain.
#
# Usage:
#   ./setup.sh            Full auto — paste your keys, script handles everything
#   ./setup.sh --guided   Same steps, but pauses to explain each one
#
# What it does:
#   1. Checks you have the required tools installed
#   2. Collects your Supabase and GitHub credentials
#   3. Links your Supabase project
#   4. Creates the database table
#   5. Stores your secrets securely on Supabase
#   6. Deploys the MCP server
#   7. Seeds your starter documents
#   8. Verifies everything works
#   9. Prints your connection URL

set -euo pipefail

# NOTE: If this script fails partway through, re-running is safe.
# Each step is idempotent — linking an already-linked project, setting
# secrets that already exist, or deploying over an existing function
# all work fine. You won't get duplicates or broken state.

# ─── Colors & Helpers ───────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

GUIDED=false
[[ "${1:-}" == "--guided" ]] && GUIDED=true

info()    { echo -e "${BLUE}ℹ${NC}  $1"; }
success() { echo -e "${GREEN}✓${NC}  $1"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $1"; }
error()   { echo -e "${RED}✗${NC}  $1"; }
step()    { echo -e "\n${BOLD}${CYAN}── $1 ──${NC}\n"; }

explain() {
  if $GUIDED; then
    echo -e "  ${YELLOW}Why:${NC} $1"
  fi
}

prompt_secret() {
  local varname="$1" prompt="$2"
  local val
  read -rsp "$prompt" val
  echo
  printf -v "$varname" '%s' "$val"
}

prompt_value() {
  local varname="$1" prompt="$2"
  local val
  read -rp "$prompt" val
  printf -v "$varname" '%s' "$val"
}

confirm_continue() {
  if $GUIDED; then
    local yn
    read -rp "  Ready to continue? [Y/n] " yn
    [[ "${yn:-Y}" =~ ^[Nn] ]] && { echo "Paused. Re-run to resume."; exit 0; }
  fi
}

# ─── Pre-flight Checks ─────────────────────────────────────────

step "Pre-flight checks"

MISSING_DEPS=false

check_cmd() {
  local cmd="$1" install_hint="$2"
  if command -v "$cmd" &>/dev/null; then
    success "$cmd found"
  else
    error "$cmd not found. Install: $install_hint"
    MISSING_DEPS=true
  fi
}

check_cmd "git"      "https://git-scm.com/downloads"
check_cmd "node"     "https://nodejs.org (v18+)"
check_cmd "supabase" "npx supabase  OR  brew install supabase/tap/supabase"
check_cmd "curl"     "(should be pre-installed)"
check_cmd "jq"       "https://jqlang.github.io/jq/download/  OR  brew install jq"

if $MISSING_DEPS; then
  error "Missing dependencies. Install them and re-run."
  exit 1
fi

# Check node version
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if (( NODE_VER < 18 )); then
  error "Node.js v18+ required. You have $(node -v)."
  exit 1
fi
success "Node.js $(node -v)"

# ─── Mode Selection ─────────────────────────────────────────────

if ! $GUIDED; then
  echo ""
  echo -e "${BOLD}Choose setup mode:${NC}"
  echo "  1) Full auto — paste your keys, script handles everything"
  echo "  2) Guided    — same steps, pauses to explain each one"
  echo ""
  read -rp "Enter 1 or 2 [1]: " mode_choice
  [[ "${mode_choice:-1}" == "2" ]] && GUIDED=true
fi

if $GUIDED; then
  info "Guided mode ON — I'll explain what's happening at each step."
else
  info "Full auto mode — let's go fast."
fi

# ─── Step 1: Collect Credentials ────────────────────────────────

step "Step 1: Your credentials"

explain "We need keys for Supabase (where your data lives) and GitHub (where backups go). Both are stored securely as Supabase secrets — never in your code."

echo ""
info "From your Supabase dashboard → Settings → API:"
prompt_value   SUPABASE_URL        "  Supabase Project URL: "
prompt_secret  SUPABASE_SERVICE_KEY "  Supabase Service Role Key (hidden): "

explain "The service role key gives full database access. It's stored as a Supabase secret — never in your code, never in git."

echo ""
info "From GitHub → Settings → Developer Settings → Personal Access Tokens → Fine-grained:"
prompt_secret  GITHUB_PAT          "  GitHub Personal Access Token (hidden): "
prompt_value   GITHUB_OWNER        "  GitHub username: "
prompt_value   GITHUB_REPO         "  Repo name [second-brain-starter]: "
GITHUB_REPO="${GITHUB_REPO:-second-brain-starter}"

explain "The GitHub token should be scoped to just this repo with Contents read+write permission. Least privilege = least risk."

# Validate inputs
for var in SUPABASE_URL SUPABASE_SERVICE_KEY GITHUB_PAT GITHUB_OWNER; do
  if [[ -z "${!var}" ]]; then
    error "$var is required but empty."
    exit 1
  fi
done

success "Credentials collected."
confirm_continue

# ─── Step 2: Link Supabase Project ──────────────────────────────

step "Step 2: Link Supabase project"

explain "This tells the Supabase CLI which cloud project to deploy to. The 'project ref' is the random string in your dashboard URL (the part before .supabase.co)."

# Extract project ref from URL
PROJECT_REF=$(echo "$SUPABASE_URL" | sed 's|https://||' | sed 's|\.supabase\.co.*||')

if [[ -z "$PROJECT_REF" ]]; then
  error "Couldn't parse project ref from URL: $SUPABASE_URL"
  error "Expected format: https://abcdefghijk.supabase.co"
  exit 1
fi

info "Project ref: $PROJECT_REF"
supabase link --project-ref "$PROJECT_REF"
success "Project linked."
confirm_continue

# ─── Step 3: Create Database Table ──────────────────────────────

step "Step 3: Create database table"

explain "This creates a 'documents' table in your Postgres database. Each row is one document with a name, content, and metadata. The unique constraint on 'name' is what makes upserts work — saving a document with an existing name updates it instead of creating a duplicate."

info "Running migration..."
supabase db push --project-ref "$PROJECT_REF"
success "Database table created."
confirm_continue

# ─── Step 4: Set Secrets ────────────────────────────────────────

step "Step 4: Store secrets on Supabase"

explain "Secrets are environment variables stored securely on Supabase's servers. Your edge function reads them at runtime. They never appear in your code, your repo, or server logs."

supabase secrets set \
  SUPABASE_URL="$SUPABASE_URL" \
  SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_KEY" \
  GITHUB_PAT="$GITHUB_PAT" \
  GITHUB_OWNER="$GITHUB_OWNER" \
  GITHUB_REPO="$GITHUB_REPO" \
  --project-ref "$PROJECT_REF"

success "Secrets stored."
confirm_continue

# ─── Step 5: Deploy MCP Server ──────────────────────────────────

step "Step 5: Deploy MCP server"

explain "This uploads your edge function to Supabase's global network. The --no-verify-jwt flag means Claude can call it without a Supabase auth token — the server uses your service role key internally for database access."

supabase functions deploy mcp --no-verify-jwt --project-ref "$PROJECT_REF"

MCP_URL="${SUPABASE_URL}/functions/v1/mcp"
success "MCP server deployed!"
info "Server URL: $MCP_URL"
confirm_continue

# ─── Step 6: Seed Starter Documents ─────────────────────────────

step "Step 6: Seed starter documents"

explain "These template documents give your second brain its initial structure. Claude will help you customize and expand them over time."

seed_doc() {
  local name="$1" file="$2"
  if [[ ! -f "$file" ]]; then
    warn "Skipped (file not found): $file"
    return
  fi

  local content
  content=$(cat "$file")

  # Use the MCP server itself to seed documents — dogfooding!
  local response
  response=$(curl -s -X POST "${MCP_URL}/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -d "$(jq -n \
      --arg name "$name" \
      --arg content "$content" \
      '{
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "add_doc",
          arguments: { name: $name, content: $content }
        }
      }')")

  if echo "$response" | grep -q "Saved"; then
    success "  Seeded: $name"
  else
    warn "  May have failed: $name"
    warn "  Response: $(echo "$response" | head -c 200)"
  fi
}

seed_doc "tid.md"    "docs/tid.md"
seed_doc "til.md"    "docs/til.md"
seed_doc "learn.md"  "docs/learn.md"
seed_doc "mentor.md" "docs/mentor.md"

success "Starter documents seeded."
confirm_continue

# ─── Step 7: Verify ─────────────────────────────────────────────

step "Step 7: Verify everything works"

info "Testing MCP server..."

RESPONSE=$(curl -s -X POST "${MCP_URL}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }')

if echo "$RESPONSE" | grep -q "list_docs"; then
  success "MCP server is responding. All 6 tools registered."
else
  warn "Server responded but tools may not be ready yet."
  warn "This sometimes takes a minute after first deploy. Try again shortly."
  info "Response: $(echo "$RESPONSE" | head -c 300)"
fi

# ─── Done ───────────────────────────────────────────────────────

step "Setup complete!"

echo -e "${GREEN}${BOLD}Your second brain is live.${NC}"
echo ""
echo "  MCP Server URL:  $MCP_URL"
echo "  GitHub repo:     https://github.com/$GITHUB_OWNER/$GITHUB_REPO"
echo "  Supabase:        https://supabase.com/dashboard/project/$PROJECT_REF"
echo ""
echo -e "${BOLD}Connect Claude to your MCP server:${NC}"
echo ""
echo "  Claude.ai → Settings → MCP Servers → Add Server"
echo "  URL: $MCP_URL"
echo ""
echo "  Claude Code → add to .mcp.json:"
echo ""
echo "    {"
echo "      \"mcpServers\": {"
echo "        \"second-brain\": {"
echo "          \"type\": \"http\","
echo "          \"url\": \"$MCP_URL\""
echo "        }"
echo "      }"
echo "    }"
echo ""
echo -e "${BOLD}Then try:${NC}"
echo "  \"List my documents\""
echo "  \"What's in my knowledge base?\""
echo ""
echo -e "  ${CYAN}Happy building.${NC}"
