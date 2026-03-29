#!/bin/bash
set -e

# AgentsLink deployment script
# Usage:
#   bash deploy.sh          → deploy to production (agentslink.link)
#   bash deploy.sh staging  → deploy to staging (agentlink-staging.kennyz.workers.dev)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV="${1:-}"

if [ "$ENV" = "staging" ]; then
  ENV_FLAG="--env staging"
  KV_NAMESPACE_ID="82beac8de083408c920c82e0beb2db5a"
  LABEL="Staging"
else
  ENV_FLAG=""
  KV_NAMESPACE_ID="5d45ad263039414fb25c18ac1040b531"
  LABEL="Production"
fi

echo "=== AgentsLink Deploy ($LABEL) ==="
echo ""

# Check for wrangler
if ! command -v npx &> /dev/null; then
  echo "Error: npx not found. Please install Node.js first."
  exit 1
fi

# Step 1: Deploy Worker
echo "[1/3] Deploying Worker..."
cd "$SCRIPT_DIR"
npx wrangler deploy $ENV_FLAG
echo ""

# Step 2: Upload website-v2/index.html to KV as site:home
WEBSITE_FILE="$PROJECT_DIR/website-v2/index.html"
if [ -f "$WEBSITE_FILE" ]; then
  echo "[2/3] Uploading website to KV (site:home)..."
  npx wrangler kv key put "site:home" --namespace-id="$KV_NAMESPACE_ID" --path="$WEBSITE_FILE" --remote
  echo ""
else
  echo "[2/3] Warning: website-v2/index.html not found, skipping..."
  echo ""
fi

# Step 3: Upload SKILL.md to KV as skill:latest
SKILL_FILE="$PROJECT_DIR/skills/agents-link/SKILL.md"
if [ -f "$SKILL_FILE" ]; then
  echo "[3/3] Uploading SKILL.md to KV (skill:latest)..."
  npx wrangler kv key put "skill:latest" --namespace-id="$KV_NAMESPACE_ID" --path="$SKILL_FILE" --remote
  echo ""
else
  echo "[3/3] Warning: skills/agents-link/SKILL.md not found, skipping..."
  echo ""
fi

echo "=== Deploy complete ($LABEL) ==="
echo ""
if [ "$ENV" = "staging" ]; then
  echo "  Staging:  https://agentlink-staging.kennyz.workers.dev"
  echo "  Test:     curl -s https://agentlink-staging.kennyz.workers.dev/create -X POST -H 'Content-Type: application/json' -d '{\"content\":\"test\",\"from\":\"test\"}'"
else
  echo "  Website:  https://agentslink.link"
  echo "  Install:  https://agentslink.link/install"
  echo "  API:      https://agentslink.link/create"
fi
echo ""
