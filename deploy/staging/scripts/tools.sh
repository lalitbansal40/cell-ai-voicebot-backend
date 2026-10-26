#!/usr/bin/env bash
# One-off tools in the same immutable image, with an optional temporary secret file.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=common.sh
source "${here}/common.sh"
op="${1:?usage: tools.sh migrate|sync-indexes|analytics-rebuild|superadmin-create|staging:demo|smoke|email:test [args]}"
shift
case "${op}" in
  migrate|sync-indexes|analytics-rebuild|superadmin-create) entry="dist/ops/${op}.js" ;;
  staging:demo) entry=dist-tools/scripts/staging-demo.js ;;
  smoke) entry=dist-tools/scripts/smoke.js ;;
  email:test) entry=dist/ops/email-test.js ;;
  *) fail 'unknown tool' ;;
esac
if [[ -n "${CAV_TOOLS_ENV:-}" ]]; then
  [[ -f "${CAV_TOOLS_ENV}" ]] || fail 'tools env file missing'
  extra="$(mktemp "${CAV_ROOT}/env/.tools.XXXXXX")"
  trap 'rm -f "${extra}"' EXIT
  python3 - "${CAV_TOOLS_ENV}" "${extra}" <<'PYENV'
import json,pathlib,sys
pathlib.Path(sys.argv[2]).write_text(json.dumps({'services':{'api':{'env_file':[str(pathlib.Path(sys.argv[1]).resolve())]}}}))
PYENV
  dc -f "${extra}" run --rm --no-deps api node "${entry}" "$@"
else dc run --rm --no-deps api node "${entry}" "$@"; fi
