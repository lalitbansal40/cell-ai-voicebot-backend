#!/usr/bin/env bash
# Lab only (Phase 20): the SIPp "trunk" calls our Asterisk as a customer would.
#   bash deploy/asterisk/lab/call-in.sh <dialed number> [caller number]
# Example: call-in.sh 911600000001 919000000001  (the DID must be an inbound number in the app)
set -euo pipefail
did="${1:?dialed number (DID), digits only}"
from="${2:-919000000001}"
[[ "${did}" =~ ^[0-9]{6,15}$ && "${from}" =~ ^[0-9]{6,15}$ ]] || { echo "numbers: digits only" >&2; exit 1; }
docker exec cav-sip-lab-sipp-uas sh -c "printf 'SEQUENTIAL\n${from};\n' > /tmp/callers.csv && \
  sipp 172.29.1.10:5060 -sf /sipp/scenarios/uac-inbound.xml -inf /tmp/callers.csv -s ${did} \
  -i 172.29.1.31 -p 5070 -mi 172.29.1.31 -mp 6100 -rtp_echo -m 1 -nostdin -trace_err"
