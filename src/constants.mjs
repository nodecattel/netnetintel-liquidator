// Fixed addresses for the Loopback market on Robinhood Chain. Everything here is public on chain; the bot re-reads the
// market's parameters at start and refuses to run if they don't match.
export const CHAIN_ID = 4663;                                                    // Robinhood Chain
export const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const EXPLORER_TX = 'https://robin.etherscan.io/tx/';
export const EXPLORER_ADDR = 'https://robin.etherscan.io/address/';

export const MORPHO = '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010';             // Morpho Blue
export const MARKET_ID = '0xaa586d26a6fe62d9c0f0948fede6e2130500ac7a655587447e2d4a37e6330589';   // Loopback: wsNET collateral, USDG loan
export const MARKET_FROM_BLOCK = 16_676_769;                                     // the market's first block
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';               // loan token, 6 decimals
export const WSNET = '0x63C12667638f2Ae6fC6ae09B43D98Ec84a8586eA';              // collateral token, 18 decimals
export const LLTV = 625_000_000_000_000_000n;                                    // 62.5%

// Morpho Blue event topics
export const TOPIC_BORROW = '0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43';     // Borrow(id, caller, onBehalf ← topic2, receiver, assets, shares)

// Defaults for the owner's settings (README → Settings)
export const DEFAULTS = {
  tickSeconds: 2,            // how often the bot checks the loans close to the line
  fullEverySeconds: 30,      // how often it re-reads every loan with debt
  hotHealth: 1.10,           // loans under this health are checked every tick
  minProfitUsdg: 0.25,       // skip a bid that earns less than this at the oracle price
  reserveUsdg: 0,            // USDG always left in the wallet
  maxRepayUsdg: null,        // the most one bid repays (empty: whatever the wallet holds)
  allowPartial: true,        // bid with what the wallet holds when it can't repay a whole loan
  gasFloorEth: 0.00005,      // warn below this much ETH for gas
  logRange: 2_000_000,       // blocks per eth_getLogs request when finding borrowers (halved on error)
  minLogRange: 5_000,
};
