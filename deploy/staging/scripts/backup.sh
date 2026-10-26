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
mongo="$(dc ps -q mongo)"
[[ -n "${mongo}" ]] || fail 'mongo is not running'
begin=$SECONDS
# Arguments are expanded inside the container, never printed by this script.
docker exec "${mongo}" sh -c 'exec mongodump --port 27018 -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip --oplog' \
  > "${work}/mongo.archive.gz" 2> "${work}/dump.log"
docker exec "${mongo}" sh -c 'mongosh --port 27018 --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval '\''const d=db.getSiblingDB("cell_ai_voicebot"); print(JSON.stringify(Object.fromEntries(d.getCollectionNames().sort().map(n=>[n,d.getCollection(n).countDocuments({})]))))'\''' > "${work}/counts.json"
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
