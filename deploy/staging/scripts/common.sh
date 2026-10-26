#!/usr/bin/env bash
# Shared staging helpers. This file never sources an env file as shell code.
set -euo pipefail
umask 077

CAV_ROOT="${CAV_ROOT:-/srv/cell-ai-voicebot}"
CAV_PROJECT="${CAV_PROJECT:-cell-ai-voicebot-staging}"
case "${CAV_PROJECT}" in
  cell-ai-voicebot-staging|cell-ai-voicebot-rehearsal|cell-ai-voicebot-restore-check) ;;
  *) echo 'Refusing an unrelated compose project' >&2; exit 2 ;;
esac
[[ "${CAV_ROOT}" == /* && "${CAV_ROOT}" != / ]] || { echo 'CAV_ROOT must be an absolute app directory' >&2; exit 2; }
export CAV_ROOT CAV_PROJECT

fail() { echo "staging: $*" >&2; exit 1; }
valid_sha() { [[ "$1" =~ ^[a-f0-9]{40}$ ]]; }
env_value() {
  python3 - "$1" "$2" <<'PY'
import pathlib,sys
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    key, sep, value = line.partition('=')
    if sep and key.strip() == sys.argv[2]:
        value=value.strip()
        if len(value)>1 and value[0]==value[-1] and value[0] in "\"'": value=value[1:-1]
        print(value,end=''); break
PY
}
current_sha() { basename "$(readlink "${CAV_ROOT}/releases/current" 2>/dev/null || echo unknown)"; }
export APP_SHA="${APP_SHA:-$(current_sha)}"
dc() {
  local files=(-f "${CAV_ROOT}/deploy/compose.yaml")
  if [[ -n "${CAV_COMPOSE_OVERRIDE:-}" ]]; then files+=(-f "${CAV_COMPOSE_OVERRIDE}"); fi
  docker compose --project-name "${CAV_PROJECT}" --env-file "${CAV_ROOT}/env/compose.env" "${files[@]}" "$@"
}
point_release() {
  python3 - "${CAV_ROOT}/releases" "$1" "$2" <<'PY'
import os,pathlib,sys
root=pathlib.Path(sys.argv[1]); target=sys.argv[2]; name=sys.argv[3]
temp=root/(name+'.next')
temp.unlink(missing_ok=True); temp.symlink_to(target); os.replace(temp,root/name)
PY
}
wait_ready() {
  local until=$((SECONDS + 90))
  until curl --fail --silent --max-time 3 "${CAV_INTERNAL_URL:-http://127.0.0.1:5100}/ready" >/dev/null; do
    (( SECONDS < until )) || return 1
    sleep 1
  done
}
load_aws() {
  # AWS CLI uses the instance role or the owner's ~/.aws credentials by default.
  # Optional secret file uses AWS's native format, never a shell source.
  if [[ -f "${CAV_ROOT}/env/aws.credentials" ]]; then
    export AWS_SHARED_CREDENTIALS_FILE="${CAV_ROOT}/env/aws.credentials"
  fi
}
# Same image as the bundled mongo service; also runs the tools against an external database.
MONGO_IMAGE='mongo:8.2@sha256:e0ce8c35124d4a9f9785532d1f268f39e9728ffa1cb38f46fa482436424c4bd3'
COUNTS_JS='const d=db.getSiblingDB("cell_ai_voicebot"); print(JSON.stringify(Object.fromEntries(d.getCollectionNames().sort().map(n=>[n,d.getCollection(n).countDocuments({})]))))'
mongo_counts() {
  docker exec "$1" sh -c 'exec mongosh --port 27018 --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "$1"' sh \
    "${COUNTS_JS}"
}
# True when backend.env points at an external database (MongoDB Atlas) rather than the
# bundled one that init-secrets.sh writes (…@127.0.0.1:27018/…) or an unset value.
mongo_external() {
  local uri=''
  if [[ -f "${CAV_ROOT}/env/backend.env" ]]; then uri="$(env_value "${CAV_ROOT}/env/backend.env" MONGODB_URI)"; fi
  [[ "${uri}" == mongodb* && "${uri}" != *'@127.0.0.1:27018/'* ]]
}
# Runs a mongo tools command against the external database: `mongo_uri <dir> sh -c '…'`.
# The URI travels in a mode-600 env file inside <dir>, never in arguments or output.
mongo_uri() {
  local dir="$1"; shift
  printf 'MONGODB_URI=%s\n' "$(env_value "${CAV_ROOT}/env/backend.env" MONGODB_URI)" > "${dir}/mongo.env"
  local code=0
  docker run --rm --env-file "${dir}/mongo.env" "${MONGO_IMAGE}" "$@" || code=$?
  rm -f "${dir}/mongo.env"
  return "${code}"
}
