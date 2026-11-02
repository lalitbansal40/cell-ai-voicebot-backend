#!/usr/bin/env bash
# READ-ONLY audit of the client server (T0.19). Runs ON the server via:
#   ssh ... 'bash -s' < scripts/server-audit.sh
#
# Allowlist only. Every command is read-only and must not print secrets.
# Phase 17 adds docker names / volumes, nginx server_name lines, certificate dates, MongoDB and
# Redis answers that need no login, firewall, time, updates and timers.
# EXPLICITLY FORBIDDEN here (never add):
#   - sudo (anything)                      - env / printenv / set
#   - cat/less/head of configs, .env, logs - history
#   - ps with arguments (ps aux / -ef)     - docker inspect / docker exec / docker logs
#   - pm2 env / pm2 show / pm2 logs        - nginx -T / apachectl -S
#   - any write, install, restart, kill, rm, chmod, mv, cp, tee, > redirection to files
set -u

section() { printf '\n===== %s =====\n' "$1"; }
run() { "$@" 2>&1 || echo "n/a"; }

section "identity"
run whoami
run hostname

section "os & kernel"            # kernel decides MongoDB 8.0 (fails on >= 6.19) vs 8.2
run uname -srm
grep -E '^(NAME|VERSION)=' /etc/os-release 2>&1 || echo "n/a"

section "resources"
run nproc
run free -h
run df -h --output=source,size,used,avail,pcent,target -x tmpfs -x devtmpfs
run uptime

section "runtimes"
command -v node >/dev/null 2>&1 && run node -v || echo "node: not installed"
command -v npm >/dev/null 2>&1 && run npm -v || echo "npm: not installed"
command -v docker >/dev/null 2>&1 && run docker --version || echo "docker: not installed"
command -v docker >/dev/null 2>&1 && { docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' 2>&1 | head -50 || echo "docker ps: n/a"; }
# shellcheck disable=SC2016 # the JS template literal is for node, not the shell
command -v pm2 >/dev/null 2>&1 && { pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const p of JSON.parse(s))console.log(`${p.name}\t${p.pm2_env&&p.pm2_env.status}`)}catch{console.log("pm2: unreadable")}})' || echo "pm2: n/a"; } || echo "pm2: not installed"

section "listening ports (unprivileged, no process names)"
run ss -tuln

section "running services"
systemctl list-units --type=service --state=running --no-pager --plain 2>&1 | head -80 || echo "n/a"

section "web servers"
command -v nginx >/dev/null 2>&1 && run nginx -v || echo "nginx: not installed"
ls /etc/nginx/sites-enabled 2>/dev/null || echo "nginx sites-enabled: n/a"
command -v apache2 >/dev/null 2>&1 && run apache2 -v || echo "apache2: not installed"

section "databases"
command -v mongod >/dev/null 2>&1 && { mongod --version 2>&1 | head -1; } || echo "mongod: not installed"
command -v mysqld >/dev/null 2>&1 && run mysqld --version || echo "mysqld: not installed"
command -v psql >/dev/null 2>&1 && run psql --version || echo "psql: not installed"
command -v redis-server >/dev/null 2>&1 && run redis-server --version || echo "redis-server: not installed"

section "top processes by memory (names only)"
ps -eo comm,rss --sort=-rss 2>&1 | head -15 || echo "n/a"

section "telephony software"
command -v asterisk >/dev/null 2>&1 && echo "asterisk: present" || echo "asterisk: not installed"
command -v freeswitch >/dev/null 2>&1 && echo "freeswitch: present" || echo "freeswitch: not installed"

section "docker (names, images, status, ports only)"
command -v docker >/dev/null 2>&1 && {
  run docker compose ls
  run docker network ls --format "{{.Name}}\t{{.Driver}}"
  run docker volume ls --format "{{.Name}}"
  run docker system df
  run docker info --format "logging driver: {{.LoggingDriver}}"
} || echo "docker: n/a"

section "nginx server names (no file contents)"
for f in /etc/nginx/sites-enabled/*; do
  [ -e "$f" ] || continue
  printf "%s: " "$(basename "$f")"
  grep -h -o -E "^\s*server_name[^;]*" "$f" 2>/dev/null | tr -s " " | tr "\n" " "
  echo
done

section "tls certificate (dates and issuer only)"
for c in /etc/letsencrypt/live/*/cert.pem; do
  [ -r "$c" ] || { echo "$c: not readable"; continue; }
  printf "%s: " "$c"
  openssl x509 -noout -issuer -enddate -in "$c" 2>&1 | tr "\n" " "
  echo
done
systemctl list-timers --all --no-pager 2>/dev/null | grep -iE "certbot|letsencrypt" || echo "certbot timer: not found"

section "mongodb (no credentials used)"
# hello and buildInfo answer without a login; listDatabases tells whether auth is on
for p in 27017 27018; do
  command -v mongosh >/dev/null 2>&1 || { echo "mongosh: not installed"; break; }
  echo "port $p:"
  mongosh --quiet --port "$p" --eval "const h = db.adminCommand({ hello: 1 }); print(\"version \" + db.adminCommand({ buildInfo: 1 }).version + \", replica set \" + (h.setName || \"none\") + \", primary \" + h.isWritablePrimary); try { db.adminCommand({ listDatabases: 1, nameOnly: true }); print(\"auth: OFF (anyone on this host can read)\") } catch (e) { print(\"auth: on\") }" 2>&1 | head -3 || echo "  no answer"
done

section "redis (no credentials used)"
for p in 6379 6380; do
  command -v redis-cli >/dev/null 2>&1 || { echo "redis-cli: not installed"; break; }
  printf "port %s: " "$p"
  redis-cli -p "$p" PING 2>&1 | head -1
done

section "firewall, time, updates, swap"
command -v ufw >/dev/null 2>&1 && { ufw status 2>&1 | head -20; } || echo "ufw: n/a"
run timedatectl show -p NTPSynchronized -p Timezone
dpkg -l unattended-upgrades 2>/dev/null | grep -q "^ii" && echo "unattended-upgrades: installed" || echo "unattended-upgrades: not installed"
run swapon --show
run df -i /

section "scheduled jobs (names only)"
systemctl list-timers --all --no-pager 2>&1 | head -30 || echo "n/a"
ls /etc/cron.d 2>/dev/null || echo "cron.d: n/a"

section "done"
