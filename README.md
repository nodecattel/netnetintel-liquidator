# NetNet Loop liquidator

A small bot you run on your own computer or server. It watches every loan on **Loop** (Loopback: NetNet's wsNET/USDG
market on Morpho Blue, Robinhood Chain). When a loan falls past the 62.5% line, it repays it from **your wallet's
USDG** and takes the borrower's wsNET collateral, worth about **12.7% more** than the USDG repaid (Morpho's
liquidation bonus).

- **Your wallet, on your machine.** The key is encrypted with your page password and never leaves the computer.
- **A page to run it**, at http://localhost:8788: make the wallet, fund it, set limits, link Telegram, go live.
- **Dry run by default.** It finds and simulates liquidations and sends nothing until you press *Go live*.
- **Telegram**, through @netnetintel_bot: each liquidation, misses, low gas, and pause/resume from your phone.
  Telegram can't change limits, switch live on or move funds.
- It sends only three kinds of transaction: Morpho `liquidate()` on the Loopback market, a USDG approval for Morpho
  (your spending limit, never unlimited), and transfers to **your own saved address**.

Setting it up with an AI assistant? Point it at [AGENTS.md](AGENTS.md). It will start the bot and hand the wallet
steps to you.

## Quick start

You need Docker (Docker Desktop on Mac or Windows).

```sh
docker run -d --name netnet-liq --restart unless-stopped -p 127.0.0.1:8788:8788 \
  -v netnet-liq:/data ghcr.io/nodecattel/netnetintel-liquidator
```

Open **http://localhost:8788** and follow the page:

1. **Password.** It protects the page and encrypts the bot's key. There is no reset, so keep it in a password manager.
2. **Wallet.** Make a new one (write the 12 words on paper; the page checks three before saving it), or import a
   wallet made just for the bot.
3. **Fund.** Send it USDG to liquidate with and about 0.001 ETH for gas, on Robinhood Chain.
4. **Limits.** The most one liquidation may repay, a reserve, the minimum profit, and your main wallet (seized wsNET
   and withdrawals go only there).
5. **Telegram** (optional). In @netnetintel_bot send `/liquidator`, tap *Make a pairing code*, paste it on the page.
6. **Go.** Watch the dry run, then press *Go live* and type LIVE.

**On a server** without a browser, run the same command there and reach the page through an SSH tunnel from your
computer: `ssh -N -L 8788:127.0.0.1:8788 you@server`, then open http://localhost:8788. Don't open the port to the internet.

**After a restart** (a reboot, an update) the wallet stays locked until you log in on the page, and Telegram tells you.
On a server you trust you can turn on *Stay unlocked after restarts* in Settings.

## How it decides

Every tick it reads the market, the oracle price, the interest rate and the loans near the line in one batch. It
accrues interest to the current second and computes each loan the way Morpho will (`position()`, virtual shares,
`_isHealthy`). Health is (collateral × oracle price × 62.5%) ÷ debt. Under 1.000, anyone can liquidate.

For a liquidatable loan, it sizes a bid with Morpho's own `liquidate()` arithmetic:

1. **Full:** repay all of the loan's borrow shares when the wallet can, and seize debt × 1.1268 ÷ price.
2. **Bad debt:** if the collateral is worth less than that, seize all of it; Morpho writes off the rest.
3. **Partial:** repay as many shares as the wallet's budget buys (can be turned off).

Interest keeps accruing until the bid lands, so bids and the approval are sized on the debt a minute later: Morpho
never pulls more than planned. It simulates the call right before sending. If another liquidator got there first,
Morpho says "position is healthy" and nothing is sent.

These figures were checked to the unit against a real Loopback liquidation (block 84,602,814): the bot's repaid and
seized amounts equal the Liquidate event's.

## Good to know

- **The oracle guard.** While the NET/USDG pool sits more than 15% under the TWAP, the Loopback oracle holds
  liquidations. The bot waits and resumes on its own.
- **Profit is in wsNET.** The 12.7% bonus is valued at the oracle price, which credits wsNET at 90% of the NET TWAP.
  What it is worth later depends on NET's price.
- **Competition.** Other liquidators watch the same market. Your own RPC (Settings → Speed) helps. A miss costs
  nothing: the simulation catches it before sending.
- **Gas.** Robinhood Chain gas is cheap, but the wallet needs some ETH. The bot warns below 0.00005 ETH.

## Everyday commands

| Task | Command |
|---|---|
| Recent log | `docker logs --tail 50 netnet-liq` |
| Update | `docker pull ghcr.io/nodecattel/netnetintel-liquidator && docker rm -f netnet-liq`, then the `docker run` line again (the volume keeps everything) |
| Stop / start | `docker stop netnet-liq` / `docker start netnet-liq` |

The page does everything else. For headless setups there are still commands (`scan`, `status`, `new-wallet`,
`import-key`, `withdraw`) and environment settings: see `.env.example`. Environment values win over the page.

## Files

Everything lives in the `/data` volume, owner-only: `keystore.json` (the key, encrypted with your page password),
`auth.json` (the password's hash), `settings.json`, `state.json` (borrowers found and your liquidations), and
`.unlock` only if you turned on *Stay unlocked after restarts*.

Run without Docker: `npm ci && DATA_DIR=./data node src/main.mjs` with Node 22 or newer.

MIT licence. Fan-made and independent; not affiliated with NetNet Capital or Morpho. Liquidating is your own decision
and your own risk. Start in dry run, start small, and read [SECURITY.md](SECURITY.md).
