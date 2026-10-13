#!/usr/bin/env bash
# Runs ON the VM. Pulls the latest code, reinstalls dependencies and restarts
# the service. Called by .github/workflows/deploy.yml and safe to run by hand:
#
#   sudo bash /opt/minecraft-bots/deploy/remote-update.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/minecraft-bots}"
SERVICE="${SERVICE:-minecraft-bot}"
BRANCH="${BRANCH:-main}"
RUN_AS="${RUN_AS:-minecraft}"

cd "$APP_DIR"

echo "→ current commit: $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
git fetch --prune origin
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
echo "→ new commit:     $(git rev-parse --short HEAD)"

# Install production dependencies only when package.json actually changed.
if ! cmp -s <(git show HEAD~1:package.json 2>/dev/null || echo '') package.json; then
  echo "→ package.json changed, reinstalling dependencies"
  sudo -u "$RUN_AS" -H npm ci --omit=dev --no-audit --no-fund
fi

# Make sure the runtime folders exist and belong to the service user.
sudo -u "$RUN_AS" mkdir -p data .mc-profiles

if systemctl list-unit-files | grep -q "^${SERVICE}.service"; then
  sudo systemctl restart "$SERVICE"
  sleep 3
  sudo systemctl --no-pager --lines=15 status "$SERVICE" || true
  echo "→ service restarted"
else
  echo "!! ${SERVICE}.service is not installed — see deploy/systemd/"
fi

PORT="$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2)"
PORT="${PORT:-8080}"
curl -fsS "http://127.0.0.1:${PORT}/healthz" && echo " ← healthz ok" || echo "!! healthz failed on port ${PORT}"
