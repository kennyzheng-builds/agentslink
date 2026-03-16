#!/bin/bash
set -e

# AgentsLink deployment script
# Deploys Worker code and uploads static assets to KV

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
KV_NAMESPACE_ID="5d45ad263039414fb25c18ac1040b531"

echo "=== AgentsLink Deploy ==="
echo ""

# Check for wrangler
if ! command -v npx &> /dev/null; then
  echo "Error: npx not found. Please install Node.js first."
  exit 1
fi

# Step 1: Deploy Worker
echo "[1/3] Deploying Worker..."
cd "$SCRIPT_DIR"
npx wrangler deploy
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

echo "=== Deploy complete ==="
echo ""
echo "  Website:  https://agentslink.link"
echo "  Install:  https://agentslink.link/install"
echo "  API:      https://agentslink.link/create"
echo ""
