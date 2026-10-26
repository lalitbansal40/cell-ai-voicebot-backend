#!/usr/bin/env bash
# Checks a built backend image (Phase 13): no env files, no tests / sources / docs, runs
# as the non-root `node` user, the ops commands are compiled, and prints the size.
#   check-image.sh <image>
set -euo pipefail

image="${1:?usage: check-image.sh <image>}"
fail() { echo "check-image: $*" >&2; exit 1; }

user="$(docker run --rm --entrypoint id "${image}" -un)"
[[ "${user}" == "node" ]] || fail "runs as ${user}, expected node"

listing="$(docker run --rm --entrypoint sh "${image}" -c 'cd /app && find . -maxdepth 2 -not -path "./node_modules*" | sort')"
for forbidden in ./.env ./tests ./src ./docs ./deploy ./scripts ./coverage ./uploads ./.git; do
  if grep -qx -- "${forbidden}" <<<"${listing}"; then fail "image contains ${forbidden}"; fi
done
if docker run --rm --entrypoint sh "${image}" -c 'find / -xdev -name ".env*" -not -path "/proc/*" 2>/dev/null | grep -q .'; then
  fail "image contains an .env file"
fi
for op in migrate sync-indexes superadmin-create email-test cli alert; do
  docker run --rm --entrypoint test "${image}" -f "/app/dist/ops/${op}.js" || fail "dist/ops/${op}.js missing"
done
docker run --rm --entrypoint test "${image}" -d /app/assets || fail "assets/ missing"

size="$(docker image inspect "${image}" --format '{{.Size}}')"
echo "check-image: ok (user node, no secrets / sources / tests; $((size / 1024 / 1024)) MB)"

for op in smoke staging-demo; do
  docker run --rm --entrypoint test "${image}" -f "/app/dist-tools/scripts/${op}.js" || fail "compiled tool missing"
done
