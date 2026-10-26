#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=common.sh
source "${here}/common.sh"
echo "Current release: $(current_sha)"
dc ps --format 'table {{.Service}}\t{{.State}}\t{{.Health}}'
df -h "${CAV_ROOT}"
if [[ -f "${CAV_ROOT}/backups/last-success" ]]; then
  printf 'Last backup: '; cat "${CAV_ROOT}/backups/last-success"
else echo 'Last backup: none'; fi
host="$(env_value "${CAV_ROOT}/env/backend.env" APP_URL)"
host="${host#https://}"; host="${host%%/*}"
cert="/etc/letsencrypt/live/${host}/fullchain.pem"
if [[ -r "${cert}" ]]; then openssl x509 -in "${cert}" -noout -enddate; fi
curl --fail --silent --max-time 5 "${CAV_INTERNAL_URL:-http://127.0.0.1:5100}/health"
printf '\n'
