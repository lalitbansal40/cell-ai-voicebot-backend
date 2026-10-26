#!/usr/bin/env bash
# Renders the staging nginx site (Phase 13).
#   render-nginx.sh <app-host> [--http-only] [--csp report|enforce] [--out <file>]
# --http-only: bootstrap config before the certificate exists (ACME challenge only).
# --csp report (default) sends Content-Security-Policy-Report-Only; enforce sends the
# enforcing header (switch after a clean day in the browser console).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
templates="${here}/../nginx"

host="${1:-}"
shift || true
mode="full"
csp="report"
out="/dev/stdout"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --http-only) mode="http"; shift ;;
    --csp) csp="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ ! "${host}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$ ]]; then
  echo "usage: render-nginx.sh <app-host> [--http-only] [--csp report|enforce] [--out file]" >&2
  exit 2
fi
case "${csp}" in
  report) header="Content-Security-Policy-Report-Only" ;;
  enforce) header="Content-Security-Policy" ;;
  *) echo "--csp must be report or enforce" >&2; exit 2 ;;
esac

if [[ "${mode}" == "http" ]]; then
  template="${templates}/cell-ai-voicebot.http.conf.template"
else
  template="${templates}/cell-ai-voicebot.conf.template"
fi

sed -e "s/__APP_HOST__/${host}/g" -e "s/__CSP_HEADER__/${header}/g" "${template}" > "${out}"
