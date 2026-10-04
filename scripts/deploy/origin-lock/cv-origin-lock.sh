#!/bin/bash
# cv-origin-lock.sh - ClawVille H1/H2 origin lock (security pass, Option B in
# ~/.clawville-brain/plans/security-held-server-items-2026-09-30.md).
# Idempotent. Run by cv-origin-lock.service after docker.service (DOCKER-USER is
# empty after a reboot). Docker-published ports bypass ufw, so the rules live in
# DOCKER-USER and match the ORIGINAL (pre-DNAT) destination port.
#
# /etc/default/cv-origin-lock:
#   CF_ONLY=0  drop the Coolify panel (8000), realtime (6001-6002) and Traefik
#              dashboard (8080) on the public interface only.
#   CF_ONLY=1  also allow 80/443 (tcp + udp/443) only from Cloudflare ranges.
#              Only safe when EVERY hostname on this box is Cloudflare-proxied.
# tailscale0 and the sandbox bridges are never matched (-i $PUB_IF only).
# Rollback: iptables -D DOCKER-USER -i eth0 -j CV-ORIGIN; ip6tables -D DOCKER-USER -i eth0 -j CV-ORIGIN
set -euo pipefail

CF_ONLY=0
PUB_IF=eth0
[ -f /etc/default/cv-origin-lock ] && . /etc/default/cv-origin-lock

# Cloudflare ranges re-fetched 2026-10-04 from https://www.cloudflare.com/ips-v4 and /ips-v6.
CF_V4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
CF_V6="2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32"

for T in iptables ip6tables; do
  $T -N CV-ORIGIN 2>/dev/null || $T -F CV-ORIGIN
  $T -A CV-ORIGIN -p tcp -m conntrack --ctorigdstport 8000 --ctdir ORIGINAL -j DROP
  $T -A CV-ORIGIN -p tcp -m conntrack --ctorigdstport 6001:6002 --ctdir ORIGINAL -j DROP
  $T -A CV-ORIGIN -p tcp -m conntrack --ctorigdstport 8080 --ctdir ORIGINAL -j DROP
done

if [ "$CF_ONLY" = "1" ]; then
  for r in $CF_V4; do
    iptables -A CV-ORIGIN -s "$r" -m conntrack --ctorigdstport 80:443 --ctdir ORIGINAL -j RETURN
  done
  for r in $CF_V6; do
    ip6tables -A CV-ORIGIN -s "$r" -m conntrack --ctorigdstport 80:443 --ctdir ORIGINAL -j RETURN
  done
  for T in iptables ip6tables; do
    $T -A CV-ORIGIN -p tcp -m conntrack --ctorigdstport 80 --ctdir ORIGINAL -j DROP
    $T -A CV-ORIGIN -p tcp -m conntrack --ctorigdstport 443 --ctdir ORIGINAL -j DROP
    $T -A CV-ORIGIN -p udp -m conntrack --ctorigdstport 443 --ctdir ORIGINAL -j DROP
  done
fi

for T in iptables ip6tables; do
  $T -C DOCKER-USER -i "$PUB_IF" -j CV-ORIGIN 2>/dev/null || $T -I DOCKER-USER 1 -i "$PUB_IF" -j CV-ORIGIN
done
echo "cv-origin-lock applied (CF_ONLY=$CF_ONLY, PUB_IF=$PUB_IF)"
