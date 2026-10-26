#!/usr/bin/env bash
# Archives committed code only. Secrets are copied separately by the owner at Gate A.
# Usage: deploy-from-mac.sh <user@host> <key-path> [backend-ref] [frontend-ref]
# Remote paths contain only validated full Git SHAs.
# shellcheck disable=SC2029
set -euo pipefail
umask 077
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend="$(cd "${here}/../.." && pwd)"
frontend="${CAV_FRONTEND_REPO:-${backend%/*}/cell-ai-voicebot-frontend}"
host="${1:?usage: deploy-from-mac.sh user@host key [backend-ref] [frontend-ref]}"
key="${2:?SSH key path required}"
[[ "${host}" =~ ^[a-z_][a-z0-9_-]*@[a-zA-Z0-9.-]+$ ]] || { echo 'Invalid SSH target' >&2; exit 2; }
[[ "${host##*@}" != 13.232.191.62 ]] || { echo 'Client production host is excluded' >&2; exit 2; }
[[ -r "${key}" ]] || exit 2
be_sha="$(git -C "${backend}" rev-parse "${3:-HEAD}^{commit}")"
fe_sha="$(git -C "${frontend}" rev-parse "${4:-HEAD}^{commit}")"
work="$(mktemp -d)"
trap 'rm -r "${work}"' EXIT
git -C "${backend}" archive --format=tar "${be_sha}" > "${work}/backend.tar"
git -C "${frontend}" archive --format=tar "${fe_sha}" > "${work}/frontend.tar"
printf '%s\n' "${fe_sha}" > "${work}/frontend.sha"
ssh_opts=(-i "${key}" -o BatchMode=yes -o StrictHostKeyChecking="${CAV_HOST_KEY_POLICY:-accept-new}")
remote="/srv/cell-ai-voicebot/src/${be_sha}"
ssh "${ssh_opts[@]}" "${host}" "mkdir -p '${remote}/backend' '${remote}/frontend'"
scp "${ssh_opts[@]}" "${work}/backend.tar" "${work}/frontend.tar" "${work}/frontend.sha" "${host}:${remote}/"
ssh "${ssh_opts[@]}" "${host}" "tar -xf '${remote}/backend.tar' -C '${remote}/backend' && tar -xf '${remote}/frontend.tar' -C '${remote}/frontend' && cp -R '${remote}/backend/deploy/staging/.' /srv/cell-ai-voicebot/deploy/ && sudo -n -u cav /srv/cell-ai-voicebot/deploy/scripts/deploy.sh '${be_sha}'"
echo "Deploy complete (backend ${be_sha}, frontend ${fe_sha})"
