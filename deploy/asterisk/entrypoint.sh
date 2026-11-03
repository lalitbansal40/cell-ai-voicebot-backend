#!/usr/bin/env bash
# Renders the config from env, then runs Asterisk in the foreground as the asterisk user.
set -euo pipefail
/usr/local/bin/cav-render /etc/asterisk-templates /etc/asterisk
exec /usr/sbin/asterisk -f -U asterisk -G asterisk -n
