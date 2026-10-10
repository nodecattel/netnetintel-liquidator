# For AI assistants

If you are helping someone install or run this liquidator, follow
[skills/netnet-liquidator/SKILL.md](skills/netnet-liquidator/SKILL.md) (also at
https://netnetintel.com/skills/netnet-liquidator/SKILL.md).

The short version: get Docker running, start the container with the page published to `127.0.0.1` only, open
http://localhost:8788, and hand over. Never ask for, read or type a private key, recovery phrase, page password or
pairing code; never set key or password environment variables; never read `/data`; never switch the bot live.

If you are changing the code: `npm ci && npm test`. Keep the page local-only (Host and Origin checks, strict CSP, no
external resources), keep funds moving only to the owner's saved address, and keep Telegram limited to reports and
pause/resume.
