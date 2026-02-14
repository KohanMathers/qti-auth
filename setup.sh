#!/usr/bin/env bash
set -euo pipefail

echo "QTI Auth setup"
echo "=============="

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required."
  exit 1
fi

if ! command -v wrangler >/dev/null 2>&1; then
  echo "Wrangler CLI not found. Install with: npm install -g wrangler"
  exit 1
fi

echo "Installing dependencies..."
npm install
(cd frontend && npm install)
(cd support-frontend && npm install)

echo
echo "Create your D1 database and update wrangler.toml placeholders:"
echo "  wrangler d1 create qti_auth"
echo
echo "Apply database schema:"
echo "  wrangler d1 execute qti_auth --file=./setup.sql"
echo
echo "Set required secrets:"
echo "  wrangler secret put JWT_SECRET"
echo "  wrangler secret put EMAIL_SERVICE_API_KEY"
echo
echo "Optional OAuth secrets:"
echo "  wrangler secret put GOOGLE_CLIENT_ID"
echo "  wrangler secret put GOOGLE_CLIENT_SECRET"
echo "  wrangler secret put GITHUB_CLIENT_ID"
echo "  wrangler secret put GITHUB_CLIENT_SECRET"
echo "  wrangler secret put DISCORD_CLIENT_ID"
echo "  wrangler secret put DISCORD_CLIENT_SECRET"
echo
echo "Create local frontend env files from examples:"
echo "  cp frontend/.env.example frontend/.env.local"
echo "  cp support-frontend/.env.example support-frontend/.env.local"
echo
echo "Setup complete. See README.md for full deployment details."
