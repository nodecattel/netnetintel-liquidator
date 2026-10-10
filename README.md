# NetNet Loopback liquidator

A small bot you run on your own computer or server. It watches every loan on **Loopback**, NetNet's wsNET/USDG market
on Morpho Blue (Robinhood Chain). When a loan falls past the 62.5% line, the bot repays it from **your wallet's USDG**
and takes the borrower's wsNET collateral, worth about **12.7% more** than the USDG repaid (Morpho's liquidation bonus).

- Your wallet, on your machine. The key is kept in an encrypted keystore in a Docker volume. Nothing is sent anywhere
  except to the RPC you choose.
- **Dry run by default.** The bot finds and simulates liquidations but sends nothing until you set `LIVE=1`.
- It sends only three kinds of transaction: Morpho `liquidate()` on the Loopback market, a USDG approval for Morpho
  (exactly the amount you allow, never unlimited), and wsNET transfers to your own `PAYOUT_ADDRESS`.
- The seized wsNET stays in the bot wallet, or goes to your `PAYOUT_ADDRESS`. It is staked NET and keeps earning the
  rebase. The bot never sells.

## Quick start (Docker)

You need Docker (Docker Desktop on Mac or Windows).

**1. Make the bot's wallet.** It's encrypted with a password you choose, and the recovery phrase is shown once.

```sh
docker run --rm -it -v netnet-liq:/data ghcr.io/nodecattel/netnetintel-liquidator new-wallet
```

To use a wallet you already have, run `import-key` instead of `new-wallet` and paste the key when asked (it's hidden).
Use a wallet made for this bot only.

**2. Fund it.** Send the address the USDG it may bid with and a little ETH for gas on Robinhood Chain. About 0.001 ETH
covers hundreds of liquidations.

**3. Watch it in dry run first.**

```sh
docker run -d --name netnet-liq --restart unless-stopped -v netnet-liq:/data \
  -e KEYSTORE_PASSWORD='your password' \
  ghcr.io/nodecattel/netnetintel-liquidator
docker logs -f netnet-liq
```

The first start reads every borrower since the market opened (a minute or two). Then you'll see lines like
`[dry run] full bid on 0x847f…42f3: repay 203.69 USDG, seize 0.3132 wsNET (229.51 USDG at the oracle, +25.82)`.

**4. Go live.**

```sh
docker rm -f netnet-liq
docker run -d --name netnet-liq --restart unless-stopped -v netnet-liq:/data \
  -e KEYSTORE_PASSWORD='your password' -e LIVE=1 -e MAX_REPAY_USDG=500 \
  ghcr.io/nodecattel/netnetintel-liquidator
```

To keep the password out of your shell history, use Docker Compose with a password file: copy `.env.example` to `.env`,
follow the notes in `docker-compose.yml`, then `docker compose up -d`.

## Commands

| Command | What it does |
|---|---|
| `run` (default) | Watch the market and liquidate (dry run unless `LIVE=1`) |
| `scan` | List every open loan by health. No wallet needed |
| `status` | The bot wallet's balances and the 10 loans closest to the line |
| `new-wallet` | Make a fresh wallet, saved as an encrypted keystore in `/data` |
| `import-key` | Encrypt an existing private key into the keystore |
| `withdraw <address> [usdg\|wsnet\|all]` | Send the bot wallet's USDG and/or wsNET to your own address |

With Docker: `docker run --rm -it -v netnet-liq:/data -e KEYSTORE_PASSWORD=… ghcr.io/nodecattel/netnetintel-liquidator status`

## Settings

Set these as `-e NAME=value`, or in `.env` with Compose.

| Setting | Default | Meaning |
|---|---|---|
| `LIVE` | `0` | `1` sends liquidations; anything else is a dry run |
| `KEYSTORE_PASSWORD` / `KEYSTORE_PASSWORD_FILE` | | The keystore's password, or a file holding it (a Docker secret) |
| `PRIVATE_KEY` / `PRIVATE_KEY_FILE` | | A raw key instead of a keystore (a keystore takes precedence) |
| `MAX_REPAY_USDG` | all it holds | The most one bid repays |
| `RESERVE_USDG` | `0` | USDG always left in the wallet |
| `MIN_PROFIT_USDG` | `0.25` | Skip bids that earn less than this, valued at the oracle price |
| `ALLOW_PARTIAL` | `1` | When the wallet can't repay a whole loan, repay what it can |
| `PAYOUT_ADDRESS` | | Send each liquidation's wsNET here (your own wallet) |
| `RPC_URL` | public RPC | Your own Robinhood Chain RPC is faster and has no shared rate limits |
| `LOGS_RPC_URL` | `RPC_URL` | An RPC for finding borrowers. It needs wide `eth_getLogs` ranges, which the public RPC allows |
| `RPC_BATCH` | `40` | Calls per JSON-RPC batch (the public RPC takes up to about 50) |
| `TICK_SECONDS` | `2` | How often loans near the line are checked |
| `FULL_EVERY_SECONDS` | `30` | How often every loan is re-read |
| `HOT_HEALTH` | `1.10` | Loans under this health are checked every tick |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | | Alerts for liquidations, failures and low gas |
| `LOG_JSON` | `0` | One JSON object per log line |

## How it decides

Every tick it reads the market, the oracle price, the interest rate and the loans near the line in one batch. It
accrues interest to the current second and computes each loan the way Morpho will (`position()`, virtual shares,
`_isHealthy`). Health is (collateral × oracle price × 62.5%) ÷ debt. Under 1.000, anyone can liquidate.

For a liquidatable loan, it sizes a bid with Morpho's own `liquidate()` arithmetic:

1. **Full:** repay all of the loan's borrow shares when the wallet can, and seize debt × 1.1268 ÷ price.
2. **Bad debt:** if the collateral is worth less than that, seize all of it; Morpho writes off the rest.
3. **Partial:** with `ALLOW_PARTIAL=1`, repay as many shares as the wallet's budget buys.

Interest keeps accruing until the bid lands, so bids and the USDG approval are sized on the debt as it will be a
minute later: Morpho never pulls more than planned. It simulates the call (`eth_call`, then `estimateGas` when live)
right before sending. If another liquidator got there
first, Morpho says "position is healthy" and nothing is sent.

These figures were checked to the unit against a real Loopback liquidation (block 84,602,814): the bot's repaid and
seized amounts equal the Liquidate event's.

## Good to know

- **The oracle guard.** While the NET/USDG pool sits more than 15% under the TWAP, the Loopback oracle holds
  liquidations. The bot waits and resumes on its own.
- **Profit is in wsNET.** The 12.7% bonus is valued at the oracle price, which credits wsNET at 90% of the NET TWAP.
  What it is worth later depends on NET's price. Selling NET through the pool pays the 5% exchange levy.
- **Competition.** Other liquidators watch the same market, and loans are often taken within minutes. Your own RPC
  (`RPC_URL`) and a short `TICK_SECONDS` help. A miss costs nothing: the simulation catches it before sending.
- **Gas.** Robinhood Chain gas is cheap, but the wallet needs some ETH. The bot warns below 0.00005 ETH.

## Files

Everything lives in the `/data` volume: `keystore.json` (encrypted, owner-only), `state.json` (the borrowers found, the
scan cursor, and the last 500 liquidations), and `heartbeat` (the health check).

Run without Docker: `npm ci && node src/main.mjs` with Node 22 or newer, and `DATA_DIR=./data`.

MIT licence. Fan-made and independent; not affiliated with NetNet Capital or Morpho. Liquidating is your own decision
and your own risk. Start in dry run, start small, and read SECURITY.md.
