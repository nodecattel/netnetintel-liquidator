# Security

The bot holds a hot wallet's key, so set it up as you would any hot wallet.

**Use a wallet made for the bot only.** `new-wallet` makes one. Fund it with only the USDG you're willing to bid and a
little ETH for gas. Keep your main funds elsewhere, and use `PAYOUT_ADDRESS` so seized wsNET moves to your main wallet
right after each liquidation.

**Where the key is.** The keystore (`/data/keystore.json`) is encrypted with scrypt (the standard Ethereum keystore
format) and readable only by its owner. Anyone with both the volume and the password has the key. Choose a strong
password; with Compose, keep it in a file passed as a Docker secret, not in `.env` or your shell history. A raw
`PRIVATE_KEY` is never written to disk, but it shows in `docker inspect`, so prefer the keystore (`import-key`
converts a key).

**What the bot can sign.** Only these: `liquidate()` on Morpho Blue `0x9D53…1010` for the Loopback market, `approve`
on USDG for Morpho (the amount it may spend, never unlimited), and `transfer` of USDG or wsNET to your
`PAYOUT_ADDRESS` or the address you give `withdraw`. It refuses to start if the market's parameters on chain aren't
Loopback's (USDG loan, wsNET collateral, 62.5% LLTV).

**What leaves your machine.** JSON-RPC calls to `RPC_URL` and `LOGS_RPC_URL`, and Telegram messages if you set a bot
token. No analytics and no calls home. Your RPC provider sees your wallet's address and transactions, as any wallet's
RPC does.

**Recovery.** Write down the recovery phrase that `new-wallet` shows once. It restores the wallet in any Ethereum
wallet app. The keystore file also imports into most wallets (with its password).

**Run it where you trust the machine.** A server you control, or your own computer. Don't run it on a shared host.

Found a problem? Open an issue without the details and ask for a private channel. Never post keys, passwords or
keystore files.
