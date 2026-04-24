#!/usr/bin/env bash
set -e

echo ""
echo "🔵 Ergora Desktop Agent — Setup"
echo "================================"
echo ""

# Check Node
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Install Node 20+ from https://nodejs.org"
  exit 1
fi
NODE_VER=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
if [ "$NODE_VER" -lt 20 ]; then
  echo "❌ Node.js 20+ required (found v$NODE_VER). Please upgrade."
  exit 1
fi
echo "✓ Node.js $(node -v)"

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install --silent
echo "✓ Dependencies installed"

# Check for .env
if [ ! -f .env ]; then
  echo ""
  echo "Creating .env from template..."
  cp .env.example .env
  echo ""
  echo "⚠️  You need to fill in your .env file before running the agent."
  echo "   Open .env and add:"
  echo "   - ERGORA_AGENT_TOKEN  (from ergora.cloud/portal/settings/desktop-agent)"
  echo "   - ERGORA_USER_ID      (your Ergora user ID)"
  echo "   - ANTHROPIC_API_KEY   (from console.anthropic.com)"
  echo "   - MOUNTED_PATHS       (comma-separated folders to give the agent access to)"
  echo ""
  echo "   Then run: npm run dev"
else
  echo "✓ .env already exists"
  echo ""
  echo "Starting agent..."
  npm run dev
fi
