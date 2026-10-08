#!/usr/bin/env bash
# Runs the local SIP lab end to end (T0.16):
#   Asterisk (Docker) ← SIPp call (Docker) ; ARI app (Node, host) ← ExternalMedia RTP
# Only touches the "cav-sip-lab" compose project. Usage: ./run-lab.sh   (ECHO=0 to disable echo)
set -euo pipefail
cd "$(dirname "$0")"

cleanup() {
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null || true
  docker compose --profile call down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 1. Lab-only credentials (random on first run, gitignored).
if [ ! -f .env.lab ]; then
  {
    echo "ARI_USER=cavlab"
    echo "ARI_PASSWORD=$(openssl rand -hex 12)"
    echo "SOFTPHONE_PASSWORD=$(openssl rand -hex 12)"
  } > .env.lab
  echo "Created .env.lab with random lab passwords."
fi
set -a
# shellcheck disable=SC1091
source .env.lab
set +a

# 2. Generated config + caller audio.
mkdir -p generated output
render() { sed -e "s|\${ARI_USER}|${ARI_USER}|g" -e "s|\${ARI_PASSWORD}|${ARI_PASSWORD}|g" -e "s|\${SOFTPHONE_PASSWORD}|${SOFTPHONE_PASSWORD}|g" "$1" > "$2"; }
render asterisk/ari.conf.template generated/ari.conf
render asterisk/pjsip_softphone.conf.template generated/pjsip_softphone.conf
(cd app && { [ -d node_modules ] || npm ci --silent; } && npm run --silent gen-caller-wav)

# 3. Asterisk.
docker compose up -d asterisk
echo -n "Waiting for ARI"
for _ in $(seq 1 60); do
  if curl -fsu "${ARI_USER}:${ARI_PASSWORD}" http://127.0.0.1:8088/ari/asterisk/info >/dev/null 2>&1; then echo " ready"; break; fi
  echo -n "."; sleep 1
done
curl -fsu "${ARI_USER}:${ARI_PASSWORD}" http://127.0.0.1:8088/ari/asterisk/info >/dev/null || { echo " ARI not reachable"; docker compose logs --tail=50 asterisk; exit 1; }

# 4. ARI app on the host; Asterisk reaches it via host.docker.internal.
HOST_IP=$(docker exec cav-sip-lab-asterisk getent ahostsv4 host.docker.internal | awk '{print $1}' | head -1 || true)
export EXTERNAL_HOST="${HOST_IP:-host.docker.internal}:40000"
export ECHO="${ECHO:-1}"
(cd app && npm start) &
APP_PID=$!
sleep 2

# 5. One automated call from SIPp.
SIPP_EXIT=0
docker compose --profile call run --rm sipp || SIPP_EXIT=$?

APP_EXIT=0
wait "$APP_PID" || APP_EXIT=$?
APP_PID=""

echo
echo "SIPp exit: ${SIPP_EXIT} · ARI app exit: ${APP_EXIT}"
[ -f output/last-summary.json ] && cat output/last-summary.json
[ "$SIPP_EXIT" -eq 0 ] && [ "$APP_EXIT" -eq 0 ]
