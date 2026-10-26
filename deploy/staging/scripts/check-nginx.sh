#!/usr/bin/env bash
# CI / local check of the staging nginx config (Phase 13): renders both templates for a
# test host and runs `nginx -t` in a throwaway nginx container with a self-signed cert.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
nginx_dir="${here}/../nginx"
image="nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10"
host="staging.example.com"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

mkdir -p "${work}/sites" "${work}/live/${host}" "${work}/web"
"${here}/render-nginx.sh" "${host}" --out "${work}/sites/full.conf"
"${here}/render-nginx.sh" "${host}" --csp enforce --out "${work}/sites/enforce.conf.off"
"${here}/render-nginx.sh" "${host}" --http-only --out "${work}/sites/http.conf.off"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=${host}" \
  -keyout "${work}/live/${host}/privkey.pem" -out "${work}/live/${host}/fullchain.pem" 2>/dev/null
cp "${work}/live/${host}/fullchain.pem" "${work}/live/${host}/chain.pem"

for variant in full enforce http; do
  conf="${work}/sites/${variant}.conf"
  [[ -f "${conf}" ]] || mv "${conf}.off" "${conf}"
  others=("${work}"/sites/*.conf)
  for o in "${others[@]}"; do [[ "${o}" == "${conf}" ]] || mv "${o}" "${o}.off"; done
  docker run --rm \
    -v "${nginx_dir}/cell-ai-voicebot-logformat.conf:/etc/nginx/conf.d/cell-ai-voicebot-logformat.conf:ro" \
    -v "${nginx_dir}/cav-proxy.conf:/etc/nginx/snippets/cav-proxy.conf:ro" \
    -v "${work}/sites:/etc/nginx/sites:ro" \
    -v "${work}/live:/etc/letsencrypt/live:ro" \
    -v "${work}/web:/srv/cell-ai-voicebot/releases/current/web:ro" \
    "${image}" sh -c 'printf "include /etc/nginx/sites/*.conf;\n" > /etc/nginx/conf.d/zz-sites.conf && nginx -t -q' \
    && echo "nginx -t ok: ${variant}"
  mv "${conf}" "${conf}.off"
done
