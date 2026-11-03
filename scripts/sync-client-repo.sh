#!/usr/bin/env bash
# Makes a release in the client's repo (ADR 0049), the only way code gets there.
#   scripts/sync-client-repo.sh <backend-ref> <frontend-ref> [--dry-run]
#   scripts/sync-client-repo.sh --tag-existing <client-commit> <backend-ref> <frontend-ref>
# Stops if the repo has commits or files we didn't release (the client once edited branding
# files), and if the new code holds anything that looks like a secret. Never forces a push.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend="${CAV_BACKEND_REPO:-$(cd "${here}/.." && pwd)}"
frontend="${CAV_FRONTEND_REPO:-${backend%/*}/cell-ai-voicebot-frontend}"
client="${CAV_CLIENT_REPO:-$HOME/Documents/Cell24x7-cell-ai-voicebot}"
sub="${CAV_CLIENT_SUBDIR:-cell-ai-voicebot-phase13}"
branch=main

die() { echo "sync: $*" >&2; exit "${2:-1}"; }
tag_for() { echo "release-$(date +%Y%m%d)-${1:0:7}"; }
make_tag() { # <commit> <backend sha> <frontend sha>
  git -C "${client}" tag -a "$(tag_for "$2")" "$1" -m "$(printf 'NotifyNow release\n\nbackend %s\nfrontend %s' "$2" "$3")"
}

existing=''
if [[ "${1:-}" == --tag-existing ]]; then existing="${2:?commit}"; shift 2; fi
be_sha="$(git -C "${backend}" rev-parse "${1:?usage: sync-client-repo.sh <backend-ref> <frontend-ref> [--dry-run]}^{commit}")"
fe_sha="$(git -C "${frontend}" rev-parse "${2:?frontend ref}^{commit}")"
dry="${3:-}"

[[ -z "$(git -C "${client}" status --porcelain)" ]] || die 'the client repo clone has local changes'
git -C "${client}" fetch --quiet --tags origin
[[ "$(git -C "${client}" rev-parse HEAD)" == "$(git -C "${client}" rev-parse "origin/${branch}")" ]] \
  || die "the clone differs from origin/${branch}: pull or inspect first"

if [[ -n "${existing}" ]]; then
  make_tag "${existing}" "${be_sha}" "${fe_sha}"
  git -C "${client}" push --quiet origin "$(tag_for "${be_sha}")"
  echo "Tagged ${existing:0:7} as $(tag_for "${be_sha}")"
  exit 0
fi

last="$(git -C "${client}" describe --tags --abbrev=0 --match 'release-*' 2>/dev/null || true)"
[[ -n "${last}" ]] || die 'no release tag yet: tag the running release first with --tag-existing'
if [[ -n "$(git -C "${client}" log --format=%h "${last}..HEAD")" ]]; then
  git -C "${client}" log --oneline "${last}..HEAD" >&2
  die "the client repo has commits since ${last}: read them before overwriting" 2
fi
message="$(git -C "${client}" tag -l --format='%(contents)' "${last}")"
last_be="$(sed -n 's/^backend \([a-f0-9]\{40\}\)$/\1/p' <<<"${message}")"
last_fe="$(sed -n 's/^frontend \([a-f0-9]\{40\}\)$/\1/p' <<<"${message}")"
[[ -n "${last_be}" && -n "${last_fe}" ]] || die "tag ${last} does not name both shas"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
mkdir "${work}/backend" "${work}/frontend"
git -C "${backend}" archive "${last_be}" | tar -x -C "${work}/backend"
git -C "${frontend}" archive "${last_fe}" | tar -x -C "${work}/frontend"
edits=0
for side in backend frontend; do
  if ! diff -rq "${work}/${side}" "${client}/${sub}/${side}" > "${work}/${side}.diff"; then
    cat "${work}/${side}.diff" >&2
    edits=1
  fi
done
(( edits == 0 )) || die "the client changed files since ${last}: keep their edits in our repos first" 2

git -C "${client}" rm -rq "${sub}/backend" "${sub}/frontend"
mkdir -p "${client}/${sub}/backend" "${client}/${sub}/frontend"
git -C "${backend}" archive "${be_sha}" | tar -x -C "${client}/${sub}/backend"
git -C "${frontend}" archive "${fe_sha}" | tar -x -C "${client}/${sub}/frontend"
if [[ -f "${here}/../deploy/production/client-repo/build.yml" ]]; then
  mkdir -p "${client}/.github/workflows"
  cp "${here}/../deploy/production/client-repo/build.yml" "${client}/.github/workflows/build.yml"
fi
git -C "${client}" add -A "${sub}" .github/workflows/build.yml

undo() { git -C "${client}" reset --quiet --hard HEAD; git -C "${client}" clean -fdq "${sub}" .github; }
secret_lines="$(git -C "${client}" diff --cached -U0 | grep -E '^\+' \
  | grep -cE 'AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{32,}|mongodb(\+srv)?://[^<" ]+:[^<" ]+@|BEGIN [A-Z ]*PRIVATE KEY|rzp[_]live_|(ARI|SIP)[_]PASSWORD=[^[:space:]]{8,}' || true)"
env_files="$(git -C "${client}" diff --cached --name-only | grep -E '(^|/)\.env($|\.)' | grep -vc 'example' || true)"
if (( secret_lines > 0 || env_files > 0 )); then
  undo
  die "stopped: ${secret_lines} lines look like secrets, ${env_files} env files" 3
fi

summary="$(git -C "${client}" diff --cached --shortstat)"
if [[ "${dry}" == --dry-run ]]; then
  undo
  echo "Dry run: ${summary}; would tag $(tag_for "${be_sha}")"
  exit 0
fi
git -C "${client}" commit -q -m "Update NotifyNow code (backend ${be_sha:0:7}, frontend ${fe_sha:0:7})"
make_tag HEAD "${be_sha}" "${fe_sha}"
git -C "${client}" push --quiet origin "${branch}" "$(tag_for "${be_sha}")"
echo "Released $(tag_for "${be_sha}"):${summary}"
