#!/usr/bin/env bash
# Encrypted, off-server backup. Local targets are for the isolated rehearsal only.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=common.sh
source "${here}/common.sh"
target="${CAV_BACKUP_TARGET:-$(env_value "${CAV_ROOT}/env/ops.env" BACKUP_TARGET)}"
[[ -s "${CAV_ROOT}/env/backup.pub" ]] || fail 'age recipient file is missing'
case "${target}" in
  s3://*/*) load_aws ;;
  /*) [[ "${CAV_PROJECT}" == cell-ai-voicebot-rehearsal ]] || fail 'staging requires an off-server S3 target' ;;
  *) fail 'set BACKUP_TARGET to s3://bucket/staging/ (local path only in rehearsal)' ;;
esac
mkdir -p "${CAV_ROOT}/backups"
mkdir "${CAV_ROOT}/.backup-lock" 2>/dev/null || fail 'backup already running'
work="$(mktemp -d "${CAV_ROOT}/backups/.work.XXXXXX")"
finish() {
  local code=$?
  trap - EXIT
  rm -r "${work}"
  rmdir "${CAV_ROOT}/.backup-lock"
  if (( code != 0 )); then
    echo 'Backup failed; inspect staging status and backup credentials' >&2
    "${here}/healthwatch.sh" --backup-failed >/dev/null 2>&1 || true
  fi
  exit "${code}"
}
trap finish EXIT
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
begin=$SECONDS
# Credentials are expanded inside the container, never printed by this script. Only the
# app database, without --oplog (an Atlas app user can't read the oplog): restore drills
# compare counts, so back up a quiet database.
if mongo_external; then
  # shellcheck disable=SC2016 # expanded by sh inside the tools container
  mongo_uri "${work}" sh -c 'exec mongodump --uri "$MONGODB_URI" --archive --gzip' \
    > "${work}/mongo.archive.gz" 2> "${work}/dump.log"
  # shellcheck disable=SC2016 # expanded by sh inside the tools container
  mongo_uri "${work}" sh -c 'exec mongosh "$MONGODB_URI" --quiet --eval "$1"' sh "${COUNTS_JS}" > "${work}/counts.json"
else
  mongo="$(dc ps -q mongo)"
  [[ -n "${mongo}" ]] || fail 'mongo is not running'
  docker exec "${mongo}" sh -c 'exec mongodump --port 27018 -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --db cell_ai_voicebot --archive --gzip' \
    > "${work}/mongo.archive.gz" 2> "${work}/dump.log"
  mongo_counts "${mongo}" > "${work}/counts.json"
fi
tar --exclude='./tmp-rec' -czf "${work}/uploads.tar.gz" -C "${CAV_ROOT}/uploads" .
for kind in mongo.archive.gz uploads.tar.gz counts.json; do
  name="cav-${stamp}-${kind}.age"
  age -R "${CAV_ROOT}/env/backup.pub" -o "${work}/${name}" "${work}/${kind}"
  if [[ "${target}" == s3://* ]]; then aws s3 cp --only-show-errors "${work}/${name}" "${target%/}/${name}"
  else mkdir -p "${target}"; cp "${work}/${name}" "${target}/${name}"; fi
done
python3 "${here}/retention.py" "${target}"
date -u +%Y-%m-%dT%H:%M:%SZ > "${CAV_ROOT}/backups/last-success.next"
mv "${CAV_ROOT}/backups/last-success.next" "${CAV_ROOT}/backups/last-success"
bytes="$(wc -c < "${work}/mongo.archive.gz")"
echo "Backup complete (${stamp}, mongo ${bytes// /} bytes, $((SECONDS - begin)) seconds)"
