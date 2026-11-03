#!/usr/bin/env bash
# One command for a production release (ADR 0049): release.sh <tag>
# Tags come only from scripts/sync-client-repo.sh; their message holds both full shas.
# Order: preflight → kit from the tag → backup → source → deploy.sh (build, migrate, wait for
# calls, swap, checks, automatic restore on failure) → record. Prints no env values.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CAV_PROJECT="${CAV_PROJECT:-cav-prod}"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../../staging/scripts/common.sh
source "${here}/common.sh"
tag="${1:-}"
[[ "${tag}" =~ ^release-[0-9]{8}-[a-f0-9]{7}$ ]] || fail 'usage: release.sh release-YYYYMMDD-<backend sha7>'
subdir="${CAV_RELEASE_SUBDIR:-cell-ai-voicebot-phase13}"
repo="${CAV_ROOT}/repo"
ops="${CAV_ROOT}/env/ops.env"
backend_env="${CAV_ROOT}/env/backend.env"
[[ -f "${ops}" && -f "${backend_env}" ]] || fail 'env/ops.env and env/backend.env are required'

# preflight: names only, values are never read out
for key in APP_URL MONGODB_URI REDIS_URL JWT_ACCESS_SECRET JWT_REFRESH_SECRET ENCRYPTION_KEY SUPPRESSION_HMAC_KEY; do
  [[ -n "$(env_value "${backend_env}" "${key}")" ]] || fail "backend.env has no ${key}"
done
used="$(df -P "${CAV_ROOT}" | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
(( used <= 85 )) || fail "disk is ${used}% full; 15% free is required"

url="$(env_value "${ops}" RELEASE_REPO_URL)"
[[ -n "${url}" ]] || fail 'set RELEASE_REPO_URL in env/ops.env'
if [[ ! -d "${repo}/.git" ]]; then git clone --quiet "${url}" "${repo}"; fi
git -C "${repo}" fetch --quiet --tags --force origin
git -C "${repo}" rev-parse --quiet --verify "refs/tags/${tag}^{tag}" >/dev/null || fail "no annotated tag ${tag}"
message="$(git -C "${repo}" tag -l --format='%(contents)' "${tag}")"
backend_sha="$(sed -n 's/^backend \([a-f0-9]\{40\}\)$/\1/p' <<<"${message}")"
frontend_sha="$(sed -n 's/^frontend \([a-f0-9]\{40\}\)$/\1/p' <<<"${message}")"
if ! valid_sha "${backend_sha}" || ! valid_sha "${frontend_sha}"; then fail "tag ${tag} does not name both shas"; fi
[[ "${tag}" == *"-${backend_sha:0:7}" ]] || fail "tag ${tag} does not match backend ${backend_sha}"

# The kit in the tag replaces the installed one, then this script restarts from it. Whole folder
# swap: bash reads a running script as it goes, so it must not be overwritten in place.
if [[ "${CAV_KIT_FROM:-}" != "${tag}" ]] \
  && git -C "${repo}" cat-file -e "${tag}:${subdir}/backend/deploy/production/compose.yaml" 2>/dev/null; then
  next="${CAV_ROOT}/deploy.next"
  rm -rf "${next}"
  mkdir -p "${next}"
  git -C "${repo}" archive "${tag}" "${subdir}/backend/deploy" \
    | tar -x -C "${next}" --strip-components=3
  mkdir "${next}/kit"
  cp -R "${next}/staging/scripts" "${next}/kit/scripts"
  cp -R "${next}/production/." "${next}/kit/"
  old="${CAV_ROOT}/deploy.old"
  rm -rf "${old}"
  mv "${CAV_ROOT}/deploy" "${old}"
  mv "${next}/kit" "${CAV_ROOT}/deploy"
  rm -rf "${next}" "${old}"
  chmod +x "${CAV_ROOT}"/deploy/scripts/*
  CAV_KIT_FROM="${tag}" exec "${CAV_ROOT}/deploy/scripts/release.sh" "${tag}"
fi

begin=$SECONDS
"${here}/backup.sh"

src="${CAV_ROOT}/src/${backend_sha}"
rm -rf "${src}"
mkdir -p "${src}/backend" "${src}/frontend"
git -C "${repo}" archive "${tag}" "${subdir}/backend" | tar -x -C "${src}/backend" --strip-components=2
git -C "${repo}" archive "${tag}" "${subdir}/frontend" | tar -x -C "${src}/frontend" --strip-components=2
printf '%s\n' "${frontend_sha}" > "${src}/frontend.sha"

"${here}/deploy.sh" "${backend_sha}"
APP_SHA="${backend_sha}" dc run --rm --no-deps -T api node dist/ops/ops-record.js release \
  --tag "${tag}" --backend "${backend_sha}" --frontend "${frontend_sha}" >/dev/null \
  || echo 'Release is live, but it could not be recorded in the app' >&2
mkdir -p "${CAV_ROOT}/logs"
printf '%s tag=%s backend=%s frontend=%s seconds=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "${tag}" "${backend_sha}" "${frontend_sha}" "$((SECONDS - begin))" >> "${CAV_ROOT}/logs/releases.log"
echo "Release ${tag} is live (backend ${backend_sha:0:7}, frontend ${frontend_sha:0:7}, $((SECONDS - begin)) seconds)"
