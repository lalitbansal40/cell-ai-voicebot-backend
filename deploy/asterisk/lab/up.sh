#!/usr/bin/env bash
# Starts the SIP lab: a lab-only ARI password (kept in the git-ignored .env.lab), test audio, containers.
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env.lab ]]; then
  umask 077
  printf 'ARI_PASSWORD=%s\n' "$(openssl rand -hex 16)" >.env.lab
fi
python3 -I gen-audio.py audio
docker compose -f compose.yaml up -d --build --wait asterisk
docker compose -f compose.yaml up -d sipp-uas
echo "sip lab: ARI http://127.0.0.1:18088 (user cav), trunk = SIPp at 172.29.1.31"
