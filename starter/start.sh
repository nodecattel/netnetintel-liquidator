#!/bin/sh
# Starts, updates or restarts the NetNet Loop liquidator and opens its page. Mac or Linux; needs Docker (Docker Desktop
# on a Mac). Your wallet and settings live in the Docker volume "netnet-liq" and survive updates: run this again any time.
#   curl -fsSL https://raw.githubusercontent.com/nodecattel/netnetintel-liquidator/main/starter/start.sh | sh
# Exactly one liquidator runs afterwards: every liquidator container on this computer (any name, any version, ones made
# with docker compose) is stopped and removed first, so two never race each other. Their storage is never deleted.
set -e
IMAGE=ghcr.io/nodecattel/netnetintel-liquidator:latest
NAME=netnet-liq
VOLUME=netnet-liq
LABEL=org.netnetintel.liquidator
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

# Every liquidator container here, running or stopped: the label (1.4.2 on), our image under any tag (the name it was
# started with is kept even after an update moves the tag), a compose-built copy, or the usual name.
copies=$(docker ps -aq --no-trunc | while read -r id; do
  docker inspect -f '{{.Id}} {{.Name}} {{.Config.Image}} {{json .Config.Labels}}' "$id" 2>/dev/null || echo "$id ? ? null"
done | awk -v name="/$NAME" -v label="\"$LABEL\":\"1\"" '$2 == name || $3 ~ /netnetintel-liquidator/ || index($0, label) { print $1 }')

for id in $copies; do
  cname=$(docker inspect -f '{{.Name}}' "$id" | sed 's#^/##')
  state=$(docker inspect -f '{{.State.Status}}' "$id")
  store=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$id")
  docker rm -f "$id" >/dev/null
  if [ "$cname" = "$NAME" ] && [ "$store" = "$VOLUME" ]; then
    echo "Replacing the current liquidator ($state)."
  else
    echo "Stopped another liquidator: \"$cname\" ($state), storage \"${store:-none}\"."
    if [ -n "$store" ] && [ "$store" != "$VOLUME" ]; then
      addr=$(docker run --rm --entrypoint sh -v "$store:/data" "$IMAGE" -c 'cat /data/keystore.json 2>/dev/null' | sed -n 's/.*"address" *: *"\(0x\)\{0,1\}\([0-9a-fA-F]\{40\}\)".*/0x\2/p' | head -n 1)
      echo "  It used its own wallet${addr:+ $addr}. Nothing was deleted. If that wallet still holds funds, start it alone"
      echo "  to withdraw them, then stop it again:"
      echo "    docker run -d --name netnet-liq-old -p 127.0.0.1:8789:8788 -v \"$store:/data\" -e LIVE=0 $IMAGE"
      echo "    open http://localhost:8789 → Settings → Withdraw, then: docker rm -f netnet-liq-old"
    fi
  fi
done

# Something outside Docker on the port (a copy started from the source code, say) would keep running beside this one.
if curl -fs "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1 || { command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }; then
  echo "Port $PORT is still in use, probably by a liquidator started from the source code (npm start / node src/main.mjs):"
  command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sed 's/^/  /'
  echo "Stop it (Ctrl+C in its terminal, or kill the PID above) and run this again, so only one liquidator runs."
  exit 1
fi

# the page is published to this computer only (127.0.0.1): never change that to 0.0.0.0
docker run -d --name "$NAME" --label "$LABEL=1" --restart unless-stopped -p "127.0.0.1:$PORT:8788" -v "$VOLUME:/data" "$IMAGE" >/dev/null

printf "Starting"
v=""
i=0; until v=$(curl -fs "http://127.0.0.1:$PORT/api/state" 2>/dev/null); do printf .; sleep 1; i=$((i + 1)); if [ $i -gt 60 ]; then break; fi; done
echo
ver=$(printf '%s' "$v" | sed -n 's/.*"v":"\([^"]*\)".*/\1/p')

if [ "$(uname)" = Darwin ]; then open "$URL"
elif [ -n "$DISPLAY$WAYLAND_DISPLAY" ] && command -v xdg-open >/dev/null 2>&1; then (xdg-open "$URL" >/dev/null 2>&1 &)
else
  echo "On a server? From your own computer run:  ssh -N -L $PORT:127.0.0.1:$PORT $(whoami)@<this server>"
  echo "and open $URL there."
fi
echo "The liquidator${ver:+ v$ver} is running, the only one on this computer: $URL"
echo "It keeps running in the background and after restarts. Logs: docker logs --tail 50 $NAME"
echo "Running it on another machine too? Use one at a time: with the same Telegram link, the newest keeps going and the older one pauses."
