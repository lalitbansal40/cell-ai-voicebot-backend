#!/usr/bin/env bash
# Runs scripts/server-audit.sh on the production (or staging) server over SSH (READ-ONLY) and
# saves the raw output OUTSIDE the repo. Usage: npm run server:audit [-- prod|stg [output.txt]]
# Host, user and port come from ~/.cav-prod/inputs.env (CAV_PROD_* / CAV_STG_*); keys are
# ~/.ssh/cav-prod and ~/.ssh/cav-stg; host keys are pinned in ~/.cav-prod/known_hosts.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-prod}"
INPUTS="$HOME/.cav-prod/inputs.env"
[ -f "$INPUTS" ] || { echo "Missing $INPUTS (see docs/prompts/PHASE_17_PROMPT.md §0)." >&2; exit 2; }
# shellcheck disable=SC1090
. "$INPUTS"
case "$TARGET" in
  prod) HOST="${CAV_PROD_HOST:-}" USER_="${CAV_PROD_SSH_USER:-}" PORT="${CAV_PROD_SSH_PORT:-22}" KEY="$HOME/.ssh/cav-prod" ;;
  stg) HOST="${CAV_STG_HOST:-}" USER_="${CAV_STG_SSH_USER:-}" PORT=22 KEY="$HOME/.ssh/cav-stg" ;;
  *) echo "Target must be prod or stg" >&2; exit 2 ;;
esac
OUT="${2:-${TMPDIR:-/tmp}/cav-server-audit-$TARGET-$(date +%Y%m%d-%H%M%S).txt}"

# hosts that are not ours: the old SMS box and the client's other EC2
case "$HOST" in
  45.114.245.71 | 13.232.191.62 | "") echo "Refusing host '$HOST'." >&2; exit 2 ;;
esac
[ -n "$USER_" ] || { echo "SSH user missing in $INPUTS" >&2; exit 2; }
[ -f "$KEY" ] || { echo "SSH key not found: $KEY" >&2; exit 2; }
PERM="$(stat -f '%Lp' "$KEY" 2>/dev/null || stat -c '%a' "$KEY")"
if [ "$PERM" != "400" ] && [ "$PERM" != "600" ]; then
  echo "Key permissions are $PERM — run: chmod 400 \"$KEY\"" >&2
  exit 3
fi

ssh -i "$KEY" -p "$PORT" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$HOME/.cav-prod/known_hosts" \
  "$USER_@$HOST" 'bash -s' < scripts/server-audit.sh > "$OUT"
echo "Raw audit saved to $OUT (do not commit). Summarise it into docs/ops/PRODUCTION_AUDIT.md."
