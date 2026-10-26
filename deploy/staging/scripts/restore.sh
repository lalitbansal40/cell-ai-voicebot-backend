#!/usr/bin/env bash
# Restore drill only: no command in this file can restore over the live database.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=common.sh
source "${here}/common.sh"
stamp="${1:-}"
[[ "${stamp}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail 'usage: restore.sh <UTC backup timestamp>'
target="${CAV_BACKUP_TARGET:-$(env_value "${CAV_ROOT}/env/ops.env" BACKUP_TARGET)}"
identity="${CAV_BACKUP_IDENTITY:-${CAV_ROOT}/env/backup.key}"
[[ -r "${identity}" ]] || fail 'provide an age identity for the drill; remove it from the server afterwards'
load_aws
work="$(mktemp -d)"
project=cell-ai-voicebot-restore-check
cleanup() {
  docker compose -p "${project}" -f "${here}/../restore.compose.yaml" down -v >/dev/null
  rm -r "${work}"
}
trap cleanup EXIT
begin=$SECONDS
if [[ "${CAV_PROJECT}" == cell-ai-voicebot-rehearsal ]]; then
  live="$(dc ps -q mongo)"
  mongo_counts "${live}" > "${work}/live.json"
else
  [[ -n "${CAV_LIVE_COUNTS_FILE:-}" && -r "${CAV_LIVE_COUNTS_FILE}" ]] || fail 'supply live staging collection counts from a quiesced database in CAV_LIVE_COUNTS_FILE'
  cp "${CAV_LIVE_COUNTS_FILE}" "${work}/live.json"
fi
for kind in mongo.archive.gz uploads.tar.gz counts.json; do
  name="cav-${stamp}-${kind}.age"
  if [[ "${target}" == s3://* ]]; then aws s3 cp --only-show-errors "${target%/}/${name}" "${work}/${name}"
  else [[ "${CAV_PROJECT}" == cell-ai-voicebot-rehearsal ]] || fail 'local target is rehearsal-only'; cp "${target}/${name}" "${work}/${name}"; fi
  age -d -i "${identity}" -o "${work}/${kind}" "${work}/${name}"
done
docker compose -p "${project}" -f "${here}/../restore.compose.yaml" up -d --wait
mongo="$(docker compose -p "${project}" -f "${here}/../restore.compose.yaml" ps -q mongo)"
docker exec -i "${mongo}" mongorestore --archive --gzip --oplogReplay < "${work}/mongo.archive.gz" > "${work}/restore.log" 2>&1
docker exec "${mongo}" mongosh --quiet --eval 'const d=db.getSiblingDB("cell_ai_voicebot"); print(JSON.stringify(Object.fromEntries(d.getCollectionNames().sort().map(n=>[n,d.getCollection(n).countDocuments({})]))))' > "${work}/actual.json"
python3 - "${work}" <<'PY'
import json,pathlib,sys,tarfile,shutil
root=pathlib.Path(sys.argv[1])
expected=json.loads((root/'counts.json').read_text()); actual=json.loads((root/'actual.json').read_text())
live=json.loads((root/'live.json').read_text())
if expected != actual or live != actual: raise SystemExit('Restore counts differ; pause writes, take a fresh backup and retry the drill')
# Verify the upload archive is readable and contains no escaping paths or links.
with tarfile.open(root/'uploads.tar.gz') as archive:
    for item in archive.getmembers():
        if item.name.startswith('/') or '..' in pathlib.PurePosixPath(item.name).parts or not (item.isfile() or item.isdir()):
            raise SystemExit('Unexpected path in uploads archive')
    for item in archive.getmembers():
        target=root/'uploads'/item.name
        if item.isdir(): target.mkdir(parents=True,exist_ok=True)
        else:
            target.parent.mkdir(parents=True,exist_ok=True)
            with archive.extractfile(item) as source, target.open('wb') as output: shutil.copyfileobj(source,output)
print('Restore counts match ('+str(len(actual))+' collections); uploads extracted')
PY
echo "Restore drill complete ($((SECONDS - begin)) seconds); live data untouched"
