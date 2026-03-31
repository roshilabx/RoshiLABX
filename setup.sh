#!/usr/bin/env bash
set -e
echo ""
echo "  ⚡ RoshiLABX Setup"
echo "  ─────────────────"
echo ""

if ! command -v node &>/dev/null; then
  echo "❌  Node.js not found — install from https://nodejs.org (v18+ required)"
  exit 1
fi

MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$MAJOR" -lt 18 ]; then
  echo "❌  Node.js v18+ required (found v$(node --version))"
  exit 1
fi

echo "✓  Node $(node --version)  /  npm $(npm --version)"
echo ""
echo "📦  Installing dependencies (electron + ssh2)..."
echo ""

npm install --omit=dev 2>&1 | grep -v "^npm warn" || true

echo ""
echo "✓  Done — launching RoshiLABX..."
echo ""
npm start
