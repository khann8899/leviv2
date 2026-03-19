// Levi Urgent 2.0 - Data Layer
const { get } = require('./http');

let seenTokens = new Set();
let lastReset = Date.now();
let urlIndex = 0;

const SCAN_URLS = [
  'https://api.dexscreener.com/latest/dex/search?q=pump.fun&chainIds=solana',
  'https://api.dexscreener.com/latest/dex/search?q=raydium&chainIds=solana',
  'https://api.dexscreener.com/latest/dex/search?q=moonshot&chainIds=solana',
  'https://api.dexscreener.com/latest/dex/search?q=pumpswap&chainIds=solana',
];

const SKIP_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

const SKIP_SYMBOLS = new Set(['SOL', 'WSOL', 'USDC', 'USDT', 'WETH', 'BTC', 'WBTC']);

// Reset seen tokens every 5 minutes
function maybeResetSeen() {
  if (Date.now() - lastReset > 5 * 60 * 1000) {
    seenTokens = new Set();
    lastReset = Date.now();
    console.log('🔄 Reset seen tokens');
  }
}

async function fetchNewTokens() {
  maybeResetSeen();

  const url = SCAN_URLS[urlIndex % SCAN_URLS.length];
  urlIndex++;

  try {
    const data = await get(url);
    const pairs = data?.pairs || [];
    const newCoins = [];
    const now = Date.now();

    const sorted = pairs.sort((a, b) => b.pairCreatedAt - a.pairCreatedAt);

    for (const pair of sorted) {
      const mint = pair.baseToken?.address;
      if (!mint) continue;
      if (SKIP_MINTS.has(mint)) continue;
      if (SKIP_SYMBOLS.has(pair.baseToken?.symbol)) continue;
      if (seenTokens.has(mint)) continue;

      const ageMinutes = (now - pair.pairCreatedAt) / 1000 / 60;
      if (ageMinutes > 1440 || ageMinutes < 0) continue;

      seenTokens.add(mint);

      newCoins.push({
        mintAddress: mint,
        symbol: pair.baseToken.symbol || 'UNKNOWN',
        name: pair.baseToken.name || 'Unknown',
        priceUSD: parseFloat(pair.priceUsd) || 0,
        liquidityUSD: pair.liquidity?.usd || 0,
        volumeH1: pair.volume?.h1 || 0,
        priceChangeH1: pair.priceChange?.h1 || 0,
        txnsH1: (pair.txns?.h1?.buys || 0) + (pair.txns?.h1?.sells || 0),
        buysH1: pair.txns?.h1?.buys || 0,
        sellsH1: pair.txns?.h1?.sells || 0,
        ageMinutes,
        url: pair.url || `https://dexscreener.com/solana/${mint}`,
        dexId: pair.dexId || '',
        pairAddress: pair.pairAddress || '',
      });
    }

    const query = url.split('q=')[1]?.split('&')[0] || 'unknown';
    console.log(`📡 DexScreener [${query}] → ${pairs.length} pairs, ${newCoins.length} new`);
    return newCoins;

  } catch (e) {
    console.error(`Fetch error: ${e.message}`);
    return [];
  }
}

async function getTokenPrice(mintAddress) {
  try {
    const data = await get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
    const pairs = data?.pairs?.filter(p => p.chainId === 'solana');
    if (!pairs || pairs.length === 0) return null;
    const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return parseFloat(best.priceUsd) || null;
  } catch {
    return null;
  }
}

async function getSOLPrice() {
  try {
    const data = await get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    return data?.solana?.usd || 150;
  } catch {
    return 150;
  }
}

module.exports = { fetchNewTokens, getTokenPrice, getSOLPrice };
