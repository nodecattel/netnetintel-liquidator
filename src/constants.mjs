// Fixed addresses for the Loopback market on Robinhood Chain. Everything here is public on chain; the bot re-reads the
// market's parameters at start and refuses to run if they don't match.
export const CHAIN_ID = 4663;                                                    // Robinhood Chain
// Robinhood Chain's public endpoints: free and rate-limited, fine to start with. Your own RPC from a provider (below) is
// faster and not shared with everyone else, which matters when other liquidators race for the same loan.
export const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const PUBLIC_SEQUENCER = 'https://sequencer.mainnet.chain.robinhood.com';      // takes signed transactions only
export const PUBLIC_FEED = 'wss://feed.mainnet.chain.robinhood.com';                   // the sequencer feed (not used by the bot)
export const PUBLIC_FEED_DELAYED = 'wss://delayed-feed.mainnet.chain.robinhood.com';   // its backup, about 500 ms behind
export const RPC_PROVIDERS = [
  ['Chainstack', 'https://chainstack.com/build-better-with-robinhood-chain/'],
  ['QuickNode', 'https://www.quicknode.com/chains/robinhood'],
  ['Blockdaemon', 'https://docs.blockdaemon.com/docs/how-to-connect-to-robinhood'],
  ['dRPC', 'https://drpc.org/chainlist/robinhood-testnet-rpc'],
  ['Validation Cloud', 'https://www.validationcloud.io/robinhood'],
  ['GlobalStake', 'https://globalstake.io'],
];
// NetNet Intel's public API: the open Loop loans (so the bot starts in seconds, not after a scan of the whole chain)
// and the market around it. Only ever a hint: every amount the bot acts on is read from the chain.
export const INTEL_API = 'https://netnetintel.com/api/v1';
export const EXPLORER_TX = 'https://robin.etherscan.io/tx/';
export const EXPLORER_ADDR = 'https://robin.etherscan.io/address/';

export const MORPHO = '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010';             // Morpho Blue
export const MARKET_ID = '0xaa586d26a6fe62d9c0f0948fede6e2130500ac7a655587447e2d4a37e6330589';   // Loopback: wsNET collateral, USDG loan
export const MARKET_FROM_BLOCK = 16_676_769;                                     // the market's first block
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';               // loan token, 6 decimals
export const WSNET = '0x63C12667638f2Ae6fC6ae09B43D98Ec84a8586eA';              // collateral token, 18 decimals
export const NET = '0xCA9c78Dd337A67F6e0077F65F5E9218719d30eDf';                // NET, 9 decimals (shown, never spent)
export const SNET = '0xb773ec2C326B7f98a5a83fc098825492F020a4c7';               // staked NET, 9 decimals (shown, never spent)
export const LLTV = 625_000_000_000_000_000n;                                    // 62.5%
export const ORACLE = '0xCDE9599059f8Ae6D6B9F33A0aF7877827ec75F16';             // the market's oracle
export const IRM = '0x2bd3d5965b26b51814ac95127b2b80dd6ccc0fa1';                // the market's interest rate model
// The market's parameters, pinned. liquidate() is always built from these, never from what an RPC returns: Morpho
// picks the market from the parameters it is given, so a lying RPC could otherwise point the bot's USDG at a market of
// its own. keccak256(abi.encode(MARKET_PARAMS)) must equal MARKET_ID (checked at start and in the tests).
export const MARKET_PARAMS = Object.freeze({ loanToken: USDG, collateralToken: WSNET, oracle: ORACLE, irm: IRM, lltv: LLTV });

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
