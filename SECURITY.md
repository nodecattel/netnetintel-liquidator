# Security

The bot holds a hot wallet's key, so set it up as you would any hot wallet.

**Use a wallet made for the bot.** The page makes one. Fund it with only the USDG you're willing to liquidate with and a
little ETH for gas, keep your main funds elsewhere, and save your main wallet on the page so seized wsNET moves there
after each liquidation.

**The key.** It is kept as a standard Ethereum keystore (scrypt), encrypted with your page password, in the data
volume, readable only by its owner. The recovery phrase is shown once and is never saved in readable form. After a
restart the key stays locked until you log in, unless you turn on *Stay unlocked after restarts*. That stores the
password in the volume (owner-only), so anyone who can copy the volume can then open the key. Use it only on a
machine you trust.

**The page.** It listens on port 8788 inside the container; publish it to `127.0.0.1` only. It answers only to
`localhost` (a check against DNS rebinding), refuses requests from other sites (Origin check, a SameSite=Strict
session cookie), loads nothing from the internet (a strict Content-Security-Policy), and limits wrong passwords to five
a minute. Changing your main wallet address and withdrawing both ask for the password again, and withdrawals only go to
that saved address. The page never shows your RPC key back.

**What the bot can sign.** Only these: `liquidate()` on Morpho Blue `0x9D53…1010` for the Loopback market, `approve`
on USDG for Morpho (your spending limit, never unlimited), and `transfer` of USDG, wsNET or ETH to your saved main
wallet. It refuses to start if the market's parameters on chain aren't Loopback's (USDG loan, wsNET collateral, 62.5%
LLTV).

**Telegram.** A pairing code from `/liquidator` links the bot to @netnetintel_bot. NetNet Intel keeps only the code's
hash. Through it the bot sends reports, and the only thing it reads back is whether you paused it. Telegram can't
change limits, switch live on, or move funds. Unlink any time from the page or the chat.

**What leaves your machine.** JSON-RPC calls to your RPC (and the public RPC when yours fails); signed transactions
to the RPC and to Robinhood Chain's sequencer; reads of NetNet Intel's public API (the open loans and the market:
nothing about you is sent, `INTEL_API=off` turns it off); reports to netnetintel.com when Telegram is linked (amounts,
deposits, loan addresses, transaction hashes, a status line); and Telegram messages if you set your own bot token. No
analytics. Your key, phrase and password never leave the machine.

**What it trusts.** Only the chain. NetNet Intel's loan list decides which loans are read first, never an amount: the
bot reads each loan, the price and the wallet from the chain before it sizes or sends anything. A wrong or hostile
list can't make it send more, or anywhere else.

**Funds that leave on their own.** If a balance drops and the bot didn't send anything, the page and Telegram say so
at once. If that wasn't you, treat the key as exposed and withdraw what's left.

**AI assistants.** An assistant can install Docker and start the container. It never needs your key, phrase,
password or pairing code; if one was pasted into a chat, treat it as exposed (see AGENTS.md).

**Recovery.** The 12 words restore the wallet in any Ethereum wallet app, or on a fresh install of this bot (import).
A forgotten page password can't be reset because it encrypts the key: restore from the words.

Found a problem? Open an issue without the details and ask for a private channel. Never post keys, passwords or
keystore files.
