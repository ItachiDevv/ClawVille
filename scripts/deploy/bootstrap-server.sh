#!/usr/bin/env bash
#
# bootstrap-server.sh — One-shot server hardening + Coolify install.
#
# Run this ONCE on a fresh Hetzner box (after provision-hetzner.sh), by
# SSHing in as root and piping this script over:
#
#   ssh root@<IPV4> 'bash -s' < scripts/deploy/bootstrap-server.sh
#
# What it does:
#   • Updates apt + installs unattended-upgrades
#   • Sets hostname, timezone
#   • Creates a non-root 'clawops' user with sudo + the same SSH key
#   • Tightens sshd (no root pw login, no pw auth)
#   • Installs Coolify (pulls Docker, Traefik, and the Coolify stack)
#
# Coolify will be reachable at http://<IPV4>:8000 after this finishes.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "error: bootstrap must run as root (ssh root@... 'bash -s' < this)"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "→ Setting hostname + timezone..."
hostnamectl set-hostname clawville-prod || true
timedatectl set-timezone UTC || true

echo "→ apt update + upgrade..."
apt-get update -y
apt-get upgrade -y
apt-get install -y curl ca-certificates ufw unattended-upgrades fail2ban jq

echo "→ Enabling unattended security upgrades..."
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "→ Creating clawops user..."
if ! id clawops >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" clawops
  usermod -aG sudo clawops
  mkdir -p /home/clawops/.ssh
  cp /root/.ssh/authorized_keys /home/clawops/.ssh/authorized_keys
  chown -R clawops:clawops /home/clawops/.ssh
  chmod 700 /home/clawops/.ssh
  chmod 600 /home/clawops/.ssh/authorized_keys
  echo 'clawops ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/clawops
fi

echo "→ Hardening sshd..."
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh || systemctl reload sshd || true

echo "→ Configuring host firewall (in addition to Hetzner firewall)..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 8000/tcp   # Coolify UI — close this later via 'ufw delete allow 8000/tcp'
ufw --force enable

echo "→ Enabling fail2ban..."
systemctl enable --now fail2ban

echo "→ Installing Coolify (this pulls Docker + Traefik + the Coolify stack)..."
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash

IP=$(curl -s4 https://ifconfig.me || hostname -I | awk '{print $1}')

echo
echo "════════════════════════════════════════════════════════════════════"
echo "  Bootstrap complete"
echo "════════════════════════════════════════════════════════════════════"
echo "  Coolify UI:  http://$IP:8000"
echo "  SSH user:    clawops@$IP  (root login still allowed via key)"
echo
echo "  Open the Coolify URL in your browser and complete the first-run"
echo "  wizard (admin email + password). Then continue with the steps in"
echo "  docs/DEPLOY-HETZNER.md § 'Configure Coolify'."
echo "════════════════════════════════════════════════════════════════════"
