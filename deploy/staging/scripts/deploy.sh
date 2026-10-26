#!/usr/bin/env bash
# Receives archives under src/<backend-sha>/{backend,frontend}; builds on this server.
set -euo pipefail
# Propagate failures inside dc()/other helpers to the rollback trap.
set -E
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=common.sh
source "${here}/common.sh"
sha="${1:-}"
valid_sha "${sha}" || fail 'usage: deploy.sh <40-character backend sha>'
[[ -d "${CAV_ROOT}/src/${sha}/backend" && -d "${CAV_ROOT}/src/${sha}/frontend" ]] || fail 'both source archives are required'
mkdir -p "${CAV_ROOT}/releases" "${CAV_ROOT}/logs"
mkdir "${CAV_ROOT}/.deploy-lock" 2>/dev/null || fail 'another deploy is in progress'
trap 'rmdir "${CAV_ROOT}/.deploy-lock"' EXIT
old="$(current_sha)"
old_previous="$(basename "$(readlink "${CAV_ROOT}/releases/previous" 2>/dev/null || echo unknown)")"
changed=false
recover() {
  local code=$?
  trap - ERR
  if [[ "${changed}" == true ]] && valid_sha "${old}"; then
    echo 'Deploy failed; restoring the previous release' >&2
    if "${here}/rollback.sh" "${old}"; then
      if valid_sha "${old_previous}"; then point_release "${old_previous}" previous
      else python3 - "${CAV_ROOT}/releases/previous" <<'PYPREV'
import pathlib,sys
p=pathlib.Path(sys.argv[1])
if p.is_symlink(): p.unlink()
PYPREV
      fi
    else echo 'Rollback failed; run status.sh and inspect the app containers' >&2; fi
  fi
  exit "${code}"
}
trap recover ERR
export APP_SHA="${sha}"
begin=$SECONDS
docker build --build-arg "GIT_SHA=${sha}" --build-arg "BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -t "cav-backend:${sha}" "${CAV_ROOT}/src/${sha}/backend"
mkdir -p "${CAV_ROOT}/releases/${sha}/web"
# Frontend env contains public VITE values only. Never pass backend.env to this build.
python3 - "${CAV_ROOT}/env/frontend.env" <<'PYENV'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1])
if p.exists():
    for line in p.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith('#') and not re.match(r'^VITE_[A-Z0-9_]+=',line):
            raise SystemExit('frontend.env may contain public VITE_* assignments only')
PYENV
build_env=(--rm --user "$(id -u):$(id -g)")
if [[ -f "${CAV_ROOT}/env/frontend.env" ]]; then build_env+=(--env-file "${CAV_ROOT}/env/frontend.env"); fi
docker run "${build_env[@]}" \
  -e VITE_API_URL=/api/v1 -e VITE_WS_URL= -e npm_config_cache=/tmp/npm-cache \
  -v "${CAV_ROOT}/src/${sha}/frontend:/web" -w /web \
  node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 \
  bash scripts/build-web.sh "${sha}"
cp -R "${CAV_ROOT}/src/${sha}/frontend/dist/." "${CAV_ROOT}/releases/${sha}/web/"
printf '%s\n' "${sha}" > "${CAV_ROOT}/releases/${sha}/backend.sha"
cp "${CAV_ROOT}/src/${sha}/frontend.sha" "${CAV_ROOT}/releases/${sha}/frontend.sha"
dc up -d --wait mongo redis
dc run --rm --no-deps api node dist/ops/migrate.js up
dc run --rm --no-deps api node dist/ops/sync-indexes.js
changed=true
dc up -d --no-deps api worker
wait_ready
dc exec -T api node dist-tools/scripts/smoke.js --url "${CAV_INTERNAL_URL:-http://127.0.0.1:5100}" --internal --expect-commit "${sha}"
if valid_sha "${old}" && [[ "${old}" != "${sha}" ]]; then point_release "${old}" previous; fi
point_release "${sha}" current
# Docker Desktop rehearsal resolves a bridge service address; reload its own proxy
# after container replacement. Linux staging proxies a fixed loopback address.
if [[ "${CAV_PROJECT}" == cell-ai-voicebot-rehearsal ]]; then dc exec -T nginx nginx -s reload; fi
# Probe through nginx as well. Every failure here restores both image and web pointer.
public_url="$(env_value "${CAV_ROOT}/env/backend.env" APP_URL)"
dc exec -T api node dist-tools/scripts/smoke.js --url "${CAV_PUBLIC_URL:-${public_url}}" --expect-commit "${sha}"
trap - ERR
# Remove old source/releases only under the two app-owned directories; keep current,
# previous and at least the five most recent releases. Uploads/data are never touched.
python3 - "${CAV_ROOT}" <<'PY'
import pathlib,re,shutil,sys
root=pathlib.Path(sys.argv[1]); releases=root/'releases'
dirs=sorted((p for p in releases.iterdir() if not p.is_symlink() and p.is_dir() and re.fullmatch('[a-f0-9]{40}',p.name)),key=lambda p:p.stat().st_mtime,reverse=True)
keep={p.resolve() for p in dirs[:5]}
for name in ['current','previous']:
    link=releases/name
    if link.exists(): keep.add(link.resolve())
for p in dirs:
    if p.resolve() not in keep:
        shutil.rmtree(p)
        source=root/'src'/p.name
        if source.is_dir() and not source.is_symlink(): shutil.rmtree(source)
PY
echo "Deploy ready (${sha}, $((SECONDS - begin)) seconds)"
