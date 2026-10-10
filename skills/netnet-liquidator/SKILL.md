---
name: netnet-liquidator
description: Set up, update, check on, stop or remove the NetNet Loop liquidator on the user's own computer or server (a Docker container with a local page). Use when the user asks to install or run "the NetNet liquidator", "a liquidation bot for Loop / Loopback", the netnetintel-liquidator Docker image, or to help with its page, pairing code or updates.
---

# NetNet Loop liquidator: setup guide for AI assistants

The user wants to run the NetNet Loop liquidator on **their own computer or server**. It is a small Docker container that watches every loan on Loopback (NetNet's wsNET/USDG market on Morpho Blue, Robinhood Chain) and, when one crosses the 62.5% line, repays it from **its own wallet's USDG** and takes the borrower's wsNET collateral (worth about 12.7% more at the oracle price). It reports to the user on Telegram through @netnetintel_bot. NetNet Intel never holds its key. It is open source, fan-made and not affiliated with NetNet Capital or Morpho. It is not financial advice: the seized wsNET's value follows NET's price.

Your job is the technical part: get Docker running, start the container, and open its page. **Everything that touches the wallet or money happens on the page, done by the user.**

## Rules for you, the assistant

- Never ask for, read, repeat, store or type a private key, a recovery phrase (the 12 words), the page password, or a pairing code. If the user pastes one into the chat, tell them to treat it as exposed: move the wallet's funds to a new wallet, or make a new pairing code with /liquidator.
- Never set `PRIVATE_KEY`, `KEYSTORE_PASSWORD` or similar variables, never run the `new-wallet`, `import-key` or `withdraw` commands for the user, and never read files in the container's `/data` (they hold the encrypted key).
- Don't fill in the page for them, don't choose their limits, and don't switch the bot to live. You can explain what each field means.
- Always publish the page as `-p 127.0.0.1:8788:8788`. Never `-p 8788:8788` or `0.0.0.0`: that would expose the page to the network.
- Only run the commands in this guide. Ask before anything that deletes data (`docker volume rm`).
- If you can't run commands, give the user one step at a time and wait until they say it worked.
- Recommend watching in dry run first (the default). The bot only works while the computer is on and awake: an always-on server is best.

## 1. Docker

Check: `docker info` (it must print server details, not an error).

- Not installed: the user installs **Docker Desktop** from https://www.docker.com/products/docker-desktop/ (Mac: Apple chip or Intel chip; Windows: the installer turns on WSL 2 if needed). Linux or a server: Docker Engine from https://docs.docker.com/engine/install/.
- Installed but not running: open Docker Desktop and wait until it says it's running (Mac: `open -a Docker`).

## 2. Start the liquidator

Mac or Linux, the easiest: the starter checks Docker (and opens Docker Desktop on a Mac), pulls the image, starts the
container on `127.0.0.1` only, waits for the page and opens it. Running it again updates the bot and keeps its data:

```
curl -fsSL https://raw.githubusercontent.com/nodecattel/netnetintel-liquidator/main/starter/start.sh | sh
```

Windows: the user downloads https://github.com/nodecattel/netnetintel-liquidator/raw/main/starter/start.bat and
double-clicks it (Docker Desktop running first).

Or the container directly, exactly this, as one line:

```
docker run -d --name netnet-liq --restart unless-stopped -p 127.0.0.1:8788:8788 -v netnet-liq:/data ghcr.io/nodecattel/netnetintel-liquidator:latest
```

- `-p 127.0.0.1:8788:8788`: the page is reachable from this computer only.
- `-v netnet-liq:/data`: the encrypted wallet, settings and history live in a Docker volume that survives updates and restarts.
- `--restart unless-stopped`: it comes back after a reboot (once Docker is running).

If the name is taken, it is already installed: `docker start netnet-liq`. If port 8788 is busy, change only the left side, e.g. `-p 127.0.0.1:8790:8788`, and open that port.

Check it started: `curl -s http://127.0.0.1:8788/api/state` prints `{"auth":"setup",…}` on a fresh install. `docker logs --tail 20 netnet-liq` shows `page: http://localhost:8788`. Neither contains secrets.

**On a remote server** (no browser there): run the same command on the server, then from the user's own computer open an SSH tunnel, `ssh -N -L 8788:127.0.0.1:8788 user@server`, and open http://localhost:8788 locally. Don't open the port in the server's firewall.

## 3. Hand over to the page

Open http://localhost:8788 (Mac: `open http://localhost:8788`; Windows: `start http://localhost:8788`). Tell the user what they'll do there, in this order:

1. **Choose a password.** It protects the page and encrypts the bot's key. There is no reset: a password manager is a good home for it.
2. **Make the bot's wallet** and write the 12 words on paper; the page checks three of them before saving. (Or import a wallet made just for the bot.)
3. **Fund it** on Robinhood Chain, both: **ETH for gas** (every transaction pays a little; 0.0005 ETH covers about
   100 liquidations) and **USDG** to liquidate with. The page shows the address as text and a QR code, live balances,
   and how many liquidations the ETH covers. Already on Robinhood Chain (e.g. Robinhood Wallet): send both to the
   bot's address. From another chain: a bridge with the bot's address as recipient (Across turns USDC into USDG; Relay;
   Jumper). The user sends the funds; you don't. Going live waits until both are there.
4. **Set limits:** the most one liquidation may repay, a reserve, the minimum profit, and their main wallet (seized wsNET and withdrawals go only there).
5. **Link Telegram (optional):** in @netnetintel_bot send `/liquidator`, tap *Make a pairing code*, paste it on the page. Telegram can then show its liquidations and pause or resume it; it can't change limits or move funds.
6. **Watch in dry run**, then press *Go live* and type LIVE.

After a restart the wallet stays locked until they log in on the page (Telegram tells them), unless they turn on *Stay unlocked after restarts* in Settings.

## Everyday commands

| Task | Command |
|---|---|
| Is it running? | `docker ps --filter name=netnet-liq` |
| Recent log | `docker logs --tail 50 netnet-liq` |
| Follow it live | `docker logs -f netnet-liq` (add `-e LOG_LEVEL=debug` to the run line for a line per check) |
| Update | Run the starter again, or `docker pull ghcr.io/nodecattel/netnetintel-liquidator:latest && docker rm -f netnet-liq` then the `docker run` line again. The volume keeps the wallet and settings. |
| Stop completely | `docker stop netnet-liq` (again: `docker start netnet-liq`) |

**Removing the wallet for good** is `docker volume rm netnet-liq`. Only after the user has withdrawn everything on the page and confirms they still have the 12 words. Ask first; it can't be undone.

## Troubleshooting

- Page doesn't open: is the container running? Use `http://localhost:8788` (not https), on the same computer or through the SSH tunnel.
- "Open this page at http://localhost:8788": the page only answers on localhost.
- Forgot the page password: it also encrypts the key, so it can't be reset. The user restores the wallet from the 12 words: stop the container, start a new one with a new volume name, and import the words on its page. Don't delete the old volume until the funds are confirmed in the new wallet.
- "Needs ETH for gas" when going live: the bot wallet has no ETH on Robinhood Chain. A little ETH must be sent there (not on Ethereum or another chain).
- "RPC problem" or balances not showing: the page says what the RPC answered. The public Robinhood Chain RPC is shared and rate-limited; the user can paste their own (Chainstack, QuickNode, Blockdaemon, dRPC, Validation Cloud, GlobalStake) in Settings → Speed. That needs their page password, so it's their step.
- "NetNet Intel API not reachable" in the log: harmless. The bot finds the loans on chain instead (a minute on the public RPC).
- Telegram link lost: make a new code with /liquidator and paste it in Settings → Telegram.

Source and full README: https://github.com/nodecattel/netnetintel-liquidator
