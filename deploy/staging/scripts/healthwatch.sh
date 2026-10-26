#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=common.sh
source "${here}/common.sh"
mkdir -p "${CAV_ROOT}/logs/alerts"
issues=()
if ! curl --fail --silent --max-time 5 "${CAV_INTERNAL_URL:-http://127.0.0.1:5100}/ready" >/dev/null; then issues+=(ready); fi
disk="$(df -P "${CAV_ROOT}" | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
if (( disk > 80 )); then issues+=(disk); fi
if [[ -r /proc/meminfo ]]; then
  free_pct="$(awk '/MemTotal:/ {total=$2} /MemAvailable:/ {available=$2} END {printf "%.0f",100*available/total}' /proc/meminfo)"
  if (( free_pct < 10 )); then issues+=(memory); fi
fi
if ! python3 - "${CAV_ROOT}/backups/last-success" <<'PY'
import datetime as d,pathlib,sys
p=pathlib.Path(sys.argv[1])
if not p.exists(): raise SystemExit(1)
date=d.datetime.fromisoformat(p.read_text().strip().replace('Z','+00:00'))
raise SystemExit((d.datetime.now(d.timezone.utc)-date).total_seconds()>26*3600)
PY
then issues+=(backup-age); fi
host="$(env_value "${CAV_ROOT}/env/backend.env" APP_URL)"
host="${host#https://}"; host="${host%%/*}"
cert="/etc/letsencrypt/live/${host}/fullchain.pem"
if [[ ! -r "${cert}" ]] || ! openssl x509 -checkend 1209600 -noout -in "${cert}" >/dev/null 2>&1; then issues+=(certificate); fi
for id in $(dc ps -aq); do
  restarts="$(docker inspect --format '{{.RestartCount}}' "${id}")"
  # Remember the count per container. A new restart since the previous five-minute
  # observation alerts; an old historical restart is not a new incident.
  prior="${CAV_ROOT}/logs/alerts/restarts-${id}"
  if [[ -f "${prior}" ]] && (( restarts > $(cat "${prior}") )); then issues+=(container-restarts); fi
  printf '%s\n' "${restarts}" > "${prior}"
done
if [[ "${1:-}" == --test ]]; then issues+=(test-alert); fi
if [[ "${1:-}" == --backup-failed ]]; then issues+=(backup-failed); fi
email="${CAV_ALERT_EMAIL:-$(env_value "${CAV_ROOT}/env/ops.env" ALERT_EMAIL)}"
[[ -n "${email}" ]] || fail 'set ALERT_EMAIL in env/ops.env'
now="$(date +%s)"
for issue in "${issues[@]}"; do
  sent="${CAV_ROOT}/logs/alerts/${issue}"
  if [[ -f "${sent}" ]] && (( now - $(cat "${sent}") < 3600 )); then continue; fi
  dc run --rm --no-deps api node dist/ops/alert.js "${email}" "${issue}"
  printf '%s\n' "${now}" > "${sent}"
done
echo "Healthwatch complete (${#issues[@]} issues; repeated mails limited to hourly)"
