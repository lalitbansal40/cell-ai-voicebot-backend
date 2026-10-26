#!/usr/bin/env bash
# Backward-compatible migrations are never reversed by rollback.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=common.sh
source "${here}/common.sh"
sha="${1:-$(basename "$(readlink "${CAV_ROOT}/releases/previous" 2>/dev/null || echo unknown)")}"
valid_sha "${sha}" || fail 'no previous release (or invalid sha)'
[[ -d "${CAV_ROOT}/releases/${sha}/web" ]] || fail 'previous web artifact missing'
docker image inspect "cav-backend:${sha}" >/dev/null
export APP_SHA="${sha}"
dc up -d --no-deps api worker
wait_ready
dc exec -T api node dist-tools/scripts/smoke.js --url "${CAV_INTERNAL_URL:-http://127.0.0.1:5100}" --internal --expect-commit "${sha}"
point_release "${sha}" current
if [[ "${CAV_PROJECT}" == cell-ai-voicebot-rehearsal ]]; then dc exec -T nginx nginx -s reload; fi
echo "Rollback ready (${sha}); database migrations retained"
