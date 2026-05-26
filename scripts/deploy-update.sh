#!/bin/bash
set -e

# WSL/Windows shell compatibility: if 'node' command is missing but 'node.exe' is present, forward calls to 'node.exe'
if ! command -v node &> /dev/null && command -v node.exe &> /dev/null; then
  node() {
    node.exe "$@"
  }
fi

# ── CONFIG ────────────────────────────────────────────────────────────────────
API_URL="${NEXT_PUBLIC_API_URL:-https://pratik0165-pulsebackend.hf.space}"
VERSION=$1

if [ -z "$VERSION" ]; then
  echo "Usage: ./scripts/deploy-update.sh 1.2.0"
  exit 1
fi

if [ -z "$ADMIN_TOKEN" ]; then
  echo "Error: ADMIN_TOKEN env var not set. Export your JWT token first."
  echo "  export ADMIN_TOKEN=eyJ..."
  exit 1
fi

echo "▶  Building Next.js..."
npm run build

# Next.js static export puts files in 'out/', regular build uses '.next/'
# Adjust WEB_DIR below to match your setup:
WEB_DIR="out"          # change to ".next" if you don't use static export

if [ ! -d "$WEB_DIR" ]; then
  echo "Error: $WEB_DIR not found. Run 'npm run build' first or fix WEB_DIR in this script."
  exit 1
fi

echo "▶  Zipping bundle from $WEB_DIR/..."
node scripts/zip.js

CHECKSUM=$(sha256sum app-bundle.zip | cut -d' ' -f1)
echo "▶  Checksum: $CHECKSUM"
echo "▶  Uploading to $API_URL/upload ..."

RESPONSE=$(curl -s -X POST "$API_URL/upload" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@app-bundle.zip;type=application/pdf")

BUNDLE_URL=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])" 2>/dev/null)

if [ -z "$BUNDLE_URL" ]; then
  echo "Upload failed. Response was:"
  echo "$RESPONSE"
  rm -f app-bundle.zip
  exit 1
fi

rm -f app-bundle.zip

echo ""
echo "✅  Upload complete!"
echo ""
echo "Now paste these into HuggingFace Space → Settings → Repository secrets:"
echo "──────────────────────────────────────────────────────────────────────"
echo "  APP_VERSION      = $VERSION"
echo "  BUNDLE_URL       = $BUNDLE_URL"
echo "  BUNDLE_CHECKSUM  = $CHECKSUM"
echo "──────────────────────────────────────────────────────────────────────"
echo "Then click 'Restart space' — users will silently get the update."
