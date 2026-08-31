# Homelab

Reference for anything that needs to know what hardware is available.
Fill in the `TODO` fields once; update when hardware changes.

## Always-on server

- **Role:** primary always-on box (rendering, scheduled jobs, self-hosted services)
- **OS:** TrueNAS (custom build), SCALE lineage - Debian-based Linux
- **Version:** 25.x (Goldeye/Fangtooth era). Docker is native since 24.10 Electric Eel.
- **CPU:** TODO - model, cores/threads
- **RAM:** TODO - total (8GB+ assumed; ZFS minimum)
- **Storage:** TODO - pool layout, free space
- **Hostname / LAN address:** TODO - how to reach it from other devices

### Container / app runtime

- **Docker:** yes, native. Docker Compose works directly.
- **Reverse proxy in front:** TODO - none / Traefik / Caddy / nginx
- **Ports already in use:** TODO

### Capability notes

- **Headless Chromium (Playwright/Puppeteer):** viable. Runs in a Docker
  container; needs ~500MB-1GB RAM per render.
- **Scheduled jobs:** TrueNAS Cron Jobs (Data Protection -> Cron Jobs), or a
  scheduler inside the container.

## Network

- **Router / gateway:** TODO
- **2.4GHz WiFi available for IoT:** TODO — yes/no, separate SSID?
- **Static leases / local DNS:** TODO — how devices resolve each other
- **Anything reachable from outside the LAN:** TODO — VPN / tunnel / nothing

## Other hardware

- **Single-board computers:** TODO — any Pis, mini PCs, spare boxes
- **Microcontrollers:** TODO — ESP32 boards, dev kits
- **3D printer:** TODO — enclosures/mounts feasible?
- **Soldering / bench tools:** TODO

## Standing preferences

- Prefer battery-powered for anything not near an outlet, even when mains is available.
- Prefer keyless / no-signup APIs over anything requiring a token that can expire.
- Prefer self-hosted over cloud where the always-on box can carry it.

## Location

- **Region:** United States (affects which weather/alert APIs apply)
- **City / coordinates:** TODO
