#!/usr/bin/env bash
# Run as the owner-provided admin on a NEW staging server only. No production host.
# Firewall enable is a second step, after verifying SSH from a second terminal.
set -euo pipefail
umask 077
[[ ${EUID} == 0 ]] || { echo 'Run with sudo on the new staging host' >&2; exit 2; }
admin="${CAV_ADMIN_USER:-${SUDO_USER:-ubuntu}}"
[[ "${admin}" =~ ^[a-z_][a-z0-9_-]*$ ]] || exit 2
[[ -n "${CAV_SSH_CIDRS:-}" ]] || { echo 'Set CAV_SSH_CIDRS to the team IP/CIDR list first' >&2; exit 2; }
[[ "${CAV_STAGING_HOST_CONFIRMED:-}" == yes ]] || { echo 'Set CAV_STAGING_HOST_CONFIRMED=yes after checking this is the NEW staging host' >&2; exit 2; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y ca-certificates curl gnupg nginx certbot python3-certbot-nginx \
  python3 awscli age chrony unattended-upgrades fail2ban ufw socat
if ! command -v docker >/dev/null; then
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  source /etc/os-release
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$(dpkg --print-architecture)" "${VERSION_CODENAME}" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
id cav >/dev/null 2>&1 || useradd --create-home --shell /bin/bash cav
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
usermod -aG docker cav
usermod -aG cav deploy
root=/srv/cell-ai-voicebot
install -d -o cav -g cav -m 755 "${root}" "${root}"/{src,releases,data,uploads,backups,logs,deploy}
chmod 2770 "${root}/src" "${root}/deploy"
install -d -o cav -g cav -m 700 "${root}/env"
install -d -o 1000 -g 1000 -m 750 "${root}/uploads" "${root}/uploads/tmp-rec"
install -d -o 999 -g 999 -m 700 "${root}/data/mongo"
if [[ ! -s "${root}/env/mongo-keyfile" ]]; then
  openssl rand -base64 512 > "${root}/env/mongo-keyfile"
  chown cav:cav "${root}/env/mongo-keyfile"; chmod 600 "${root}/env/mongo-keyfile"
fi
install -d /etc/ssh/sshd_config.d
printf 'PasswordAuthentication no\nPermitRootLogin no\nAllowUsers %s deploy\n' "${admin}" > /etc/ssh/sshd_config.d/00-cav-staging.conf
sshd -t
systemctl reload ssh
printf '[sshd]\nenabled = true\n' > /etc/fail2ban/jail.d/cav.conf
systemctl enable --now chrony fail2ban unattended-upgrades
timedatectl set-timezone UTC
if ! swapon --show=NAME --noheadings | grep -q .; then
  [[ -f /swapfile ]] || { fallocate -l 4G /swapfile; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
install -d /etc/docker
python3 - <<'PYDOCKER'
import json,pathlib
p=pathlib.Path('/etc/docker/daemon.json')
d=json.loads(p.read_text()) if p.exists() else {}
d['log-driver']='json-file'; d['log-opts']={'max-size':'20m','max-file':'5'}
p.write_text(json.dumps(d,indent=2)+'\n')
PYDOCKER
printf 'net.core.rmem_max=26214400\nnet.core.wmem_max=26214400\n' > /etc/sysctl.d/90-cav-media.conf
sysctl --system >/dev/null
ufw default deny incoming
ufw default allow outgoing
for cidr in ${CAV_SSH_CIDRS}; do ufw allow from "${cidr}" to any port 22 proto tcp; done
ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 40000:40999/udp
# Enable only on the second run, after testing the new deploy/admin key in a second
# SSH session. The first run leaves the prepared firewall rules inactive.
if [[ "${CAV_ENABLE_FIREWALL:-}" == yes ]]; then ufw --force enable; fi
printf 'deploy ALL=(cav) NOPASSWD: /srv/cell-ai-voicebot/deploy/scripts/deploy.sh *\n' > /etc/sudoers.d/cav-deploy
chmod 440 /etc/sudoers.d/cav-deploy
visudo -cf /etc/sudoers.d/cav-deploy >/dev/null
echo 'Provisioned staging. Install deploy/admin authorized_keys; test a second SSH session before CAV_ENABLE_FIREWALL=yes.'
