#!/usr/bin/env bash
# Runs scripts/server-audit.sh on the client server over SSH (READ-ONLY) and saves the raw
# output OUTSIDE the repo. Usage: npm run server:audit [-- /path/to/output.txt]
# Key path: CLIENT_SSH_KEY_PATH in .env, else ~/.ssh/cell-voicebot-client.pem
set -euo pipefail
cd "$(dirname "$0")/.."

KEY="$(grep -E '^CLIENT_SSH_KEY_PATH=' .env 2>/dev/null | cut -d= -f2- || true)"
KEY="${KEY:-$HOME/.ssh/cell-voicebot-client.pem}"
HOST="ubuntu@13.232.191.62"
OUT="${1:-${TMPDIR:-/tmp}/cav-server-audit-$(date +%Y%m%d-%H%M%S).txt}"

if [ ! -f "$KEY" ]; then
  echo "SSH key not found: $KEY — set CLIENT_SSH_KEY_PATH in .env or place the key there (chmod 400)." >&2
  exit 2
fi
PERM="$(stat -f '%Lp' "$KEY" 2>/dev/null || stat -c '%a' "$KEY")"
if [ "$PERM" != "400" ] && [ "$PERM" != "600" ]; then
  echo "Key permissions are $PERM — run: chmod 400 \"$KEY\"" >&2
  exit 3
fi

# accept-new adds the host key to ~/.ssh/known_hosts on first connect (local change only).
ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new \
  "$HOST" 'bash -s' < scripts/server-audit.sh > "$OUT"
echo "Raw audit saved to $OUT (do not commit). Summarise it into docs/client/server-audit.md."
