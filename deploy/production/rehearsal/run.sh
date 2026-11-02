#!/usr/bin/env bash
# Laptop rehearsal of the production kit (never on a server): real image builds, real migrations,
# a bundled MongoDB, dummy provider keys. Usage: run.sh <empty work folder> [--keep]
# Steps: first deploy → second deploy → a release that throws at start (automatic restore) →
# rollback.sh to a named release. Every step prints its time.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend="$(cd "${here}/../../.." && pwd)"
frontend="${CAV_FRONTEND_REPO:-${backend%/*}/cell-ai-voicebot-frontend}"
root="${1:?usage: run.sh <work folder> [--keep]}"
keep="${2:-}"
export CAV_ROOT="${root}" CAV_PROJECT=cav-prod-rehearsal
export CAV_COMPOSE_OVERRIDE="${root}/deploy/rehearsal/override.yaml"
export CAV_PUBLIC_URL=http://127.0.0.1:8080
export CAV_CALL_DRAIN_SEC=5
export COMPOSE_PROFILES=bundled-mongo

mkdir -p "${root}"/{env,uploads,data,logs,releases,src,backups,deploy}
cp -R "${backend}/deploy/staging/scripts" "${root}/deploy/scripts"
cp -R "${backend}/deploy/production/." "${root}/deploy/"
scripts="${root}/deploy/scripts"
python3 - "${root}/env/backend.env" <<'PY'
import base64,secrets,sys
key=lambda n=32: base64.b64encode(secrets.token_bytes(n)).decode()
values={'NODE_ENV':'production','APP_URL':'http://127.0.0.1:8080','FRONTEND_URL':'http://127.0.0.1:8080',
'CORS_ORIGINS':'http://127.0.0.1:8080','TRUST_PROXY':'1','HSTS_BY_PROXY':'true','LOG_LEVEL':'warn',
'JWT_ACCESS_SECRET':secrets.token_hex(32),'JWT_REFRESH_SECRET':secrets.token_hex(32),'ENCRYPTION_KEY':key(),
'SUPPRESSION_HMAC_KEY':key(),'OPENAI_API_KEY':'sk-rehearsal-dummy','AI_PROVIDER':'openai','VOICE_PROVIDER':'openai',
'MOCK_APIS_ENABLED':'false','AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS':'false','VOICE_TEXT_INPUT_ENABLED':'false',
'TELEPHONY_PROVIDER':'dryrun','DRY_RUN_MAX_SPEED':'20','CAMPAIGNS_ENABLED':'true','WHATSAPP_ENABLED':'false',
'STORAGE_DRIVER':'local','STORAGE_LOCAL_PATH':'/srv/cell-ai-voicebot/uploads','CALL_RECORDING_TMP_DIR':'/srv/cell-ai-voicebot/uploads/tmp-rec',
'EMAIL_DRIVER':'smtp','SMTP_HOST':'127.0.0.1','SMTP_PORT':'1025','MAIL_FROM':'NotifyNow <no-reply@example.com>',
'PAYMENT_PROVIDER':'razorpay','RAZORPAY_KEY_ID':'rzp_test_dummy','RAZORPAY_KEY_SECRET':'dummy','RAZORPAY_WEBHOOK_SECRET':'dummy',
'BILLING_SELLER_NAME':'Rehearsal','BILLING_SELLER_ADDRESS':'1 Test Road','BILLING_SELLER_GSTIN':'08ABCDE1234F1Z0','BILLING_SELLER_STATE_CODE':'08','MONGODB_URI':'','REDIS_URL':''}
open(sys.argv[1],'w').write(''.join(f'{k}={v}\n' for k,v in values.items()))
PY
"${scripts}/init-secrets.sh" >/dev/null
# inside the shared network Redis answers on its own port, not the published one
python3 - "${root}/env/backend.env" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); s=p.read_text()
p.write_text(re.sub(r'(REDIS_URL=redis://:[^@]+@127\.0\.0\.1:)6380',r'\g<1>6379',s))
PY
cleanup() {
  [[ "${keep}" == --keep ]] && return 0
  # shellcheck source=../../staging/scripts/common.sh
  (source "${scripts}/common.sh"; APP_SHA=x dc --profile bundled-mongo down -v --remove-orphans >/dev/null 2>&1 || true)
}
trap cleanup EXIT

place() { # <full fake sha> <backend tree-ish> [patch-to-throw]
  local src="${root}/src/$1"
  mkdir -p "${src}/backend" "${src}/frontend"
  git -C "${backend}" archive "$2" | tar -x -C "${src}/backend"
  git -C "${frontend}" archive HEAD | tar -x -C "${src}/frontend"
  git -C "${frontend}" rev-parse HEAD > "${src}/frontend.sha"
  if [[ "${3:-}" == throw ]]; then
    printf "\nthrow new Error('rehearsal: this release fails at start');\n" >> "${src}/backend/src/index.ts"
  fi
}
timed() { local t=$SECONDS; "$@" >"${root}/logs/step.log" 2>&1 || { tail -30 "${root}/logs/step.log"; return 1; }; echo "  ok in $((SECONDS - t)) s"; }
health() { curl --silent --max-time 5 http://127.0.0.1:18080/api/v1/health | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["commit"])'; }

A="$(printf 'a%.0s' {1..40})"; B="$(printf 'b%.0s' {1..40})"; C="$(printf 'c%.0s' {1..40})"
ref="${CAV_REHEARSAL_REF:-HEAD}"

echo "1. first deploy (A)"; place "${A}" "${ref}"; timed "${scripts}/deploy.sh" "${A}"
[[ "$(health)" == "${A}" ]] || { echo 'health does not show A'; exit 1; }
[[ -f "${root}/releases/${A}/web/version.json" ]] || { echo 'no version.json'; exit 1; }
echo "2. second deploy (B)"; place "${B}" "${ref}"; timed "${scripts}/deploy.sh" "${B}"
[[ "$(health)" == "${B}" ]] || { echo 'health does not show B'; exit 1; }
echo "3. a release that throws at start (C): must restore B"; place "${C}" "${ref}" throw
if "${scripts}/deploy.sh" "${C}" >"${root}/logs/step.log" 2>&1; then echo 'C should have failed'; exit 1; fi
[[ "$(health)" == "${B}" ]] || { echo 'B was not restored'; exit 1; }
[[ "$(basename "$(readlink "${root}/releases/current")")" == "${B}" ]] || { echo 'current moved'; exit 1; }
echo "  restored B"
echo "4. rollback.sh to A"; timed "${scripts}/rollback.sh" "${A}"
[[ "$(health)" == "${A}" ]] || { echo 'health does not show A'; exit 1; }
echo "Rehearsal passed"
