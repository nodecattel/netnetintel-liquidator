#!/bin/sh
# Starts (or updates) the NetNet Loop liquidator and opens its page. Mac or Linux; needs Docker (Docker Desktop on a
# Mac). Your wallet and settings live in the Docker volume "netnet-liq" and survive updates: run this again any time.
#   curl -fsSL https://raw.githubusercontent.com/nodecattel/netnetintel-liquidator/main/starter/start.sh | sh
set -e
IMAGE=ghcr.io/nodecattel/netnetintel-liquidator:latest
PORT=${PORT:-8788}
URL="http://localhost:$PORT"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker isn't installed. Mac/Windows: https://www.docker.com/products/docker-desktop/  Linux: https://docs.docker.com/engine/install/"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  if [ "$(uname)" = Darwin ]; then
    echo "Starting Docker Desktop…"; open -a Docker
    i=0; until docker info >/dev/null 2>&1; do sleep 2; i=$((i + 1)); if [ $i -gt 90 ]; then echo "Docker didn't start. Open Docker Desktop, wait until it says it's running, and run this again."; exit 1; fi; done
  else
    echo "Docker isn't running, or this user can't use it."
    echo "Try: sudo systemctl start docker   (and: sudo usermod -aG docker \$USER, then log in again)"
    exit 1
  fi
fi

echo "Getting the latest liquidator…"
docker pull -q "$IMAGE" >/dev/null
docker rm -f netnet-liq >/dev/null 2>&1 || true
# the page is published to this computer only (127.0.0.1): never change that to 0.0.0.0
docker run -d --name netnet-liq --restart unless-stopped -p "127.0.0.1:$PORT:8788" -v netnet-liq:/data "$IMAGE" >/dev/null

printf "Starting"
i=0; until curl -fs "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; do printf .; sleep 1; i=$((i + 1)); if [ $i -gt 60 ]; then break; fi; done
echo

if [ "$(uname)" = Darwin ]; then open "$URL"
elif [ -n "$DISPLAY$WAYLAND_DISPLAY" ] && command -v xdg-open >/dev/null 2>&1; then (xdg-open "$URL" >/dev/null 2>&1 &)
else
  echo "On a server? From your own computer run:  ssh -N -L $PORT:127.0.0.1:$PORT $(whoami)@<this server>"
  echo "and open $URL there."
fi
echo "The liquidator is running: $URL"
echo "It keeps running in the background and after restarts. Logs: docker logs --tail 50 netnet-liq"
