# Host hardening (for the client's admin)

These settings are host-wide on the shared server, so the client's admin applies them (ADR 0049). Each step: what to run, how to check, how to undo. Keep a second SSH session open while changing SSH or the firewall.

## SSH: keys only, no root login

```bash
sudo tee /etc/ssh/sshd_config.d/60-hardening.conf >/dev/null <<'EOF'
PasswordAuthentication no
PermitRootLogin no
KbdInteractiveAuthentication no
EOF
sudo sshd -t && sudo systemctl reload ssh
```

Check from a new terminal that key login still works. Undo: remove the file and reload.

## Firewall

```bash
sudo ufw allow from <office-ip>/32 to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 40000:40999/udp   # WhatsApp call media
sudo ufw enable
sudo ufw status numbered
```

Add rules the client's other app needs before `enable`. Undo: `sudo ufw disable`. If the server is behind a cloud security group, set the same rules there.

**Phone calls (Phase 18, ADR 0050).** SIP and its audio are opened **only to the trunk's addresses** (from the trunk details; repeat per address). Never open 5060 to everyone: SIP scanners find it within minutes and try toll fraud.

```bash
sudo ufw allow from <trunk-ip> to any port 5060 proto udp
sudo ufw allow from <trunk-ip> to any port 5060 proto tcp
sudo ufw allow from <trunk-media-ip> to any port 20000:20999 proto udp
# ARI (8088) and our RTP (21000-21999) stay on 127.0.0.1: no rule needed
```

## Security updates and fail2ban

```bash
sudo apt-get install -y unattended-upgrades fail2ban
sudo dpkg-reconfigure -plow unattended-upgrades
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd
```

## Time

```bash
timedatectl show -p NTPSynchronized   # must say yes; two-step codes and signed links need it
```

## Docker logs

In `/etc/docker/daemon.json`, `{ "log-driver": "local", "log-opts": { "max-size": "50m", "max-file": "5" } }`, then `sudo systemctl restart docker` in a window (it restarts every container on the host, including the client's). Our Compose file sets this for our containers anyway, so this step is optional.
