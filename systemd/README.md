# Scheduled Tasks & Services

RoRo runs on two machines. This directory contains the service definitions for both.

## Home PC — WhatsApp Bot

Runs as systemd **user** services (no root needed).

**Install:**
```bash
cp systemd/home-pc/*.service systemd/home-pc/*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now roro-bot.service
systemctl --user enable --now roro-pull.timer
```

- `roro-bot.service` — runs the WhatsApp bot via `start-bot.sh`
- `roro-pull.timer` — checks GitHub for updates every 60 seconds
- `roro-pull.service` — runs `pull-and-restart.sh` when triggered by the timer

## DO Server (144.126.210.189) — Geni OAuth

Runs via cron as root.

**Install:**
```bash
crontab -e
# Add the line from do-server/crontab
```

- Checks GitHub for updates every minute, pulls and restarts `geni-auth.js` if changed
- Logs to `/var/log/geni-pull.log`
