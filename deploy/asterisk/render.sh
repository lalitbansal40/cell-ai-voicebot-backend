#!/usr/bin/env bash
# Renders the Asterisk config from env (ADR 0050). Usage: render.sh <template-dir> <out-dir>
# Only the variables below are substituted; values are never printed.
# shellcheck disable=SC2016 # the grep pattern is literal
set -euo pipefail

src="${1:?template dir}"
out="${2:?out dir}"

fail() {
  echo "render: $*" >&2
  exit 1
}

: "${SIP_HOST:?}" "${ARI_PASSWORD:?}"
export SIP_PORT="${SIP_PORT:-5060}"
export SIP_TRANSPORT="${SIP_TRANSPORT:-udp}"
export SIP_AUTH="${SIP_AUTH:-ip}"
export SIP_CODECS="${SIP_CODECS:-ulaw,alaw}"
export SIP_DTMF="${SIP_DTMF:-rfc4733}"
export SIP_BIND="${SIP_BIND:-0.0.0.0}"
export SIP_LISTEN_PORT="${SIP_LISTEN_PORT:-5060}"
export SIP_EXTERNAL_ADDRESS="${SIP_EXTERNAL_ADDRESS:-}"
export SIP_LOCAL_NET="${SIP_LOCAL_NET:-}"
export SIP_TRUNK_IPS="${SIP_TRUNK_IPS:-}"
export SIP_USERNAME="${SIP_USERNAME:-}"
: "${SIP_PASSWORD:=}"
export SIP_PASSWORD
export SIP_RTP_START="${SIP_RTP_START:-20000}"
export SIP_RTP_END="${SIP_RTP_END:-20999}"
export SIP_STRICT_RTP="${SIP_STRICT_RTP:-yes}"
export ARI_BIND="${ARI_BIND:-127.0.0.1}"
export ARI_PORT="${ARI_PORT:-8088}"
export ARI_USER="${ARI_USER:-cav}"
export SIP_QUALIFY_SEC="${SIP_QUALIFY_SEC:-60}"
export SIP_OUTBOUND_AUTH=""

case "${SIP_TRANSPORT}" in udp | tcp) ;; *) fail "SIP_TRANSPORT must be udp or tcp" ;; esac
case "${SIP_DTMF}" in rfc4733 | info | inband | auto) ;; *) fail "SIP_DTMF is not valid" ;; esac
[[ "${#ARI_PASSWORD}" -ge 24 ]] || fail "ARI_PASSWORD must be at least 24 characters"
[[ "${SIP_RTP_START}" =~ ^[0-9]+$ && "${SIP_RTP_END}" =~ ^[0-9]+$ ]] || fail "SIP_RTP_START / SIP_RTP_END must be numbers"
((SIP_RTP_START < SIP_RTP_END)) || fail "SIP_RTP_START must be below SIP_RTP_END"
case "${SIP_AUTH}" in
  ip) [[ -n "${SIP_TRUNK_IPS}" ]] || fail "SIP_AUTH=ip needs SIP_TRUNK_IPS" ;;
  register)
    [[ -n "${SIP_USERNAME}" && -n "${SIP_PASSWORD}" ]] || fail "SIP_AUTH=register needs SIP_USERNAME and SIP_PASSWORD"
    SIP_OUTBOUND_AUTH="trunk-auth"
    ;;
  *) fail "SIP_AUTH must be ip or register" ;;
esac

names=(SIP_HOST SIP_PORT SIP_TRANSPORT SIP_CODECS SIP_DTMF SIP_BIND SIP_LISTEN_PORT
  SIP_EXTERNAL_ADDRESS SIP_LOCAL_NET SIP_TRUNK_IPS SIP_USERNAME SIP_PASSWORD SIP_OUTBOUND_AUTH
  SIP_RTP_START SIP_RTP_END SIP_STRICT_RTP SIP_QUALIFY_SEC ARI_BIND ARI_PORT ARI_USER ARI_PASSWORD)

# Replaces ${NAME} for the names above only (bash 3.2 safe; no envsubst needed).
render_file() {
  local line name value
  while IFS= read -r line || [[ -n "${line}" ]]; do
    for name in "${names[@]}"; do
      value="${!name}"
      line="${line//\$\{${name}\}/${value}}"
    done
    [[ "${line}" =~ ^[a-z_]+=$ ]] && continue
    printf '%s\n' "${line}"
  done <"$1"
}

mkdir -p "${out}"
umask 077
for t in "${src}"/*.template; do
  name="$(basename "${t}" .template)"
  render_file "${t}" >"${out}/${name}"
done
[[ -n "${SIP_TRUNK_IPS}" ]] || : >"${out}/pjsip_identify.conf"
[[ "${SIP_AUTH}" == register ]] || : >"${out}/pjsip_register.conf"
for f in "${src}"/*.conf; do cp "${f}" "${out}/"; done

if grep -l '\${SIP_\|\${ARI_' "${out}"/*.conf >/dev/null 2>&1; then
  fail "a placeholder was left in the rendered config"
fi
echo "render: ok (${SIP_AUTH}, ${SIP_TRANSPORT}, rtp ${SIP_RTP_START}-${SIP_RTP_END})"
