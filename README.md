# NetNet Loop liquidator

A small bot you run on your own computer or server. It watches every loan on **Loop** (Loopback: NetNet's wsNET/USDG
market on Morpho Blue, Robinhood Chain). When a loan falls past the 62.5% line, it repays it from **your wallet's
USDG** and takes the borrower's wsNET collateral, worth about **12.7% more** than the USDG repaid (Morpho's
liquidation bonus).

- **Your wallet, on your machine.** The key is encrypted with your page password and never leaves the computer.
- **A page to run it**, at http://localhost:8788: make the wallet, fund it, set limits, link Telegram, go live.
- **Dry run by default.** It finds and simulates liquidations and sends nothing until you press *Go live*.
- **Telegram**, through @netnetintel_bot: deposits, each liquidation, misses, failures, low gas, funds that leave the
  wallet without the bot sending them, every restart, two minutes of failing checks (and the recovery), and, from
  the bot's side, a liquidator that stops checking in for 15 minutes (computer asleep, Docker closed). Pause/resume
  from your phone. Telegram can't change limits, switch live on or move funds.
- **Starts in seconds.** It loads the open Loop loans from [NetNet Intel's API](https://netnetintel.com/api/v1) and
  reads the wallet right away, then scans the whole chain in the background for anything the list missed. The API is
  only a head start: every amount the bot acts on is read from the chain.
- **Sees what it does.** The page lists the wallet (ETH, USDG, wsNET, NET, sNET), each deposit, every transaction it
  sent (with status, block and fee) and a short activity feed; the terminal has the full log.
- It sends only three kinds of transaction: Morpho `liquidate()` on the Loopback market, a USDG approval for Morpho
  (your spending limit, never unlimited), and transfers to **your own saved address**.

Setting it up with an AI assistant? Point it at [AGENTS.md](AGENTS.md). It will start the bot and hand the wallet
steps to you.

## Quick start

You need Docker (Docker Desktop on Mac or Windows) and, on Robinhood Chain, **USDG** to liquidate with plus **a
little ETH for gas** (0.0005 ETH covers about 100 liquidations).

**Mac or Linux:** paste this into Terminal. It starts (or updates) the bot and opens its page:

```sh
curl -fsSL https://raw.githubusercontent.com/nodecattel/netnetintel-liquidator/main/starter/start.sh | sh
```

**Windows:** download [`starter/start.bat`](starter/start.bat) and double-click it.

**Or with Docker directly:**

```sh
docker run -d --name netnet-liq --restart unless-stopped -p 127.0.0.1:8788:8788 \
  -v netnet-liq:/data ghcr.io/nodecattel/netnetintel-liquidator
```

Then open **http://localhost:8788** and follow the page:

1. **Password.** It protects the page and encrypts the bot's key. There is no reset, so keep it in a password manager.
2. **Wallet.** Make a new one (write the 12 words on paper; the page checks three before saving it), or import a
   wallet made just for the bot.
3. **Fund.** On Robinhood Chain, send the bot's address (the page shows it with a QR code) **ETH for gas** (every
   transaction pays a little: the one-time USDG approval and each liquidation) and **USDG** to liquidate with. Coming
   from another chain? The page links bridges: Across (USDC arrives as USDG), Relay and Jumper. The page shows how many
   liquidations the ETH covers, and won't go live without both.
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

**Timed bids.** Most Loopback liquidations happen because interest alone pushes a loan over the line, at a second that
can be worked out in advance, and other bots fire at that second. So for a loan due to cross within 90 seconds, the bot
builds the bid ahead (nonce, fees, a fixed gas limit) and sends it the moment the chain's clock reaches that second,
with no simulation first. If another bot lands first, the bid reverts and costs only its gas (a fraction of a cent).
After 3 lost in a row on one borrower it leaves that loan alone for 10 minutes. Lost races are summed up once an hour
on Telegram and in the feed.

These figures were checked to the unit against a real Loopback liquidation (block 84,602,814): the bot's repaid and
seized amounts equal the Liquidate event's.

## Good to know

- **The oracle guard.** While the NET/USDG pool sits more than 15% under the TWAP, the Loopback oracle holds
  liquidations. The bot waits and resumes on its own.
- **Profit is in wsNET.** The 12.7% bonus is valued at the oracle price, which credits wsNET at 90% of the NET TWAP.
  What it is worth later depends on NET's price.
- **Competition.** Other liquidators watch the same market. Your own RPC (Settings → Speed) helps, and every signed
  transaction also goes straight to Robinhood Chain's sequencer. A miss costs nothing: the simulation catches it
  before sending.
- **Gas.** Paid in ETH. A liquidation costs about 0.000005 ETH at Robinhood Chain's usual 0.02 gwei, so 0.0005 ETH lasts
  about 100. The page shows how many your ETH covers; Telegram warns when it runs low.

## Speed: RPC endpoints

The bot starts on Robinhood Chain's public endpoints. They are shared and rate-limited, fine for a dry run, not
ideal when racing other liquidators. For live use, get your own RPC from a provider (most have a free tier) and paste
it in **Settings → Speed**:

| Provider | Sign up / docs |
|---|---|
| Chainstack | https://chainstack.com/build-better-with-robinhood-chain/ |
| QuickNode | https://www.quicknode.com/chains/robinhood |
| Blockdaemon | https://docs.blockdaemon.com/docs/how-to-connect-to-robinhood |
| dRPC | https://drpc.org/chainlist/robinhood-testnet-rpc |
| Validation Cloud | https://www.validationcloud.io/robinhood |
| GlobalStake | https://globalstake.io |

Paste the provider's **https://** address (the bot doesn't need wss://). If your RPC stops answering, the bot reads
through the public one until it is back (and says so on the page and in the log). Finding borrowers (a history scan)
stays on the public RPC by default: it allows large ranges, while most providers cap them (QuickNode: 10,000 blocks).

Public endpoints (mainnet):

| Endpoint | URL | Used by the bot |
|---|---|---|
| RPC | `https://rpc.mainnet.chain.robinhood.com` | the default, and the fallback |
| Sequencer | `https://sequencer.mainnet.chain.robinhood.com` | every signed transaction is also sent here (`SEQUENCER_URL=off` to stop) |
| Sequencer feed | `wss://feed.mainnet.chain.robinhood.com` | no |
| Sequencer feed, delayed backup (~500 ms behind) | `wss://delayed-feed.mainnet.chain.robinhood.com` | no |

## Logs

- **The page** keeps it short: the wallet, transactions, the last few events, and the recent log behind *Full log*.
- **The terminal** has everything: `docker logs -f netnet-liq`. Each transaction shows when it is sent and when it
  confirms (block and fee). Add `-e LOG_LEVEL=debug` to the `docker run` line for a line per check (block, loans read,
  timings, which RPC answered) and the chain scan's progress.

## Everyday commands

| Task | Command |
|---|---|
| Recent log | `docker logs --tail 50 netnet-liq` |
| Follow the log | `docker logs -f netnet-liq` |
| Update | Run the starter again (or `docker pull …` then the `docker run` line again). The volume keeps everything |
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
