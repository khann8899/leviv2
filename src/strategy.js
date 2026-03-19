// Levi Urgent 2.0 - Strategy Layer
const { get } = require('./http');

async function checkHoneypot(mintAddress) {
  try {
    const data = await get(
      `https://api.honeypot.is/v2/IsHoneypot?address=${mintAddress}&chainID=solana`
    );
    return {
      isHoneypot: data.honeypotResult?.isHoneypot || false,
      sellTax: data.simulationResult?.sellTax || 0,
      buyTax: data.simulationResult?.buyTax || 0,
    };
  } catch {
    return { isHoneypot: false, sellTax: 0, buyTax: 0 };
  }
}

async function checkAuthorities(mintAddress, connection) {
  try {
    const { PublicKey } = require('@solana/web3.js');
    const info = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
    const parsed = info?.value?.data?.parsed?.info;
    if (!parsed) return { hasMintAuthority: false, hasFreezeAuthority: false };
    return {
      hasMintAuthority: parsed.mintAuthority !== null,
      hasFreezeAuthority: parsed.freezeAuthority !== null,
    };
  } catch {
    return { hasMintAuthority: false, hasFreezeAuthority: false };
  }
}

function scoreCoin(coin, honeypot, authorities) {
  let score = 5;
  const flags = [];
  const positives = [];

  // Instant disqualifiers
  if (honeypot.isHoneypot) return { score: 0, flags: ['🚫 HONEYPOT'], positives: [] };
  if (honeypot.sellTax > 10) return { score: 0, flags: [`🚫 Sell tax: ${honeypot.sellTax}%`], positives: [] };

  // Liquidity
  if (coin.liquidityUSD > 100000) { score += 2; positives.push(`💧 Strong liquidity: $${Math.round(coin.liquidityUSD).toLocaleString()}`); }
  else if (coin.liquidityUSD > 30000) { score += 1; positives.push(`💧 Liquidity: $${Math.round(coin.liquidityUSD).toLocaleString()}`); }
  else if (coin.liquidityUSD > 5000) { positives.push(`💧 Low liquidity: $${Math.round(coin.liquidityUSD).toLocaleString()}`); }
  else { score -= 2; flags.push(`⚠️ Very low liquidity: $${Math.round(coin.liquidityUSD).toLocaleString()}`); }

  // Volume
  if (coin.volumeH1 > 50000) { score += 1; positives.push(`📈 High volume: $${Math.round(coin.volumeH1).toLocaleString()}`); }
  else if (coin.volumeH1 > 10000) { positives.push(`📈 Volume: $${Math.round(coin.volumeH1).toLocaleString()}`); }

  // Transaction activity
  if (coin.txnsH1 > 200) { score += 1; positives.push(`🔄 Very active: ${coin.txnsH1} txns/hr`); }
  else if (coin.txnsH1 > 50) { positives.push(`🔄 Active: ${coin.txnsH1} txns/hr`); }
  else if (coin.txnsH1 < 10) { score -= 1; flags.push(`⚠️ Low activity: ${coin.txnsH1} txns/hr`); }

  // Buy/sell ratio (more buys than sells is good)
  if (coin.buysH1 > coin.sellsH1 * 1.5) { score += 1; positives.push(`🟢 Buy pressure: ${coin.buysH1}B/${coin.sellsH1}S`); }
  else if (coin.sellsH1 > coin.buysH1 * 2) { score -= 1; flags.push(`🔴 Sell pressure: ${coin.buysH1}B/${coin.sellsH1}S`); }

  // Price momentum
  if (coin.priceChangeH1 > 50) { score += 1; positives.push(`🚀 Price up ${coin.priceChangeH1.toFixed(1)}% in 1h`); }
  else if (coin.priceChangeH1 < -30) { score -= 1; flags.push(`📉 Price down ${Math.abs(coin.priceChangeH1).toFixed(1)}% in 1h`); }

  // Mint authority
  if (authorities.hasMintAuthority) { score -= 1; flags.push('⚠️ Mint authority active'); }
  else { positives.push('✅ No mint authority'); }

  // Age bonus
  if (coin.ageMinutes < 30) { positives.push(`⚡ Very new: ${Math.round(coin.ageMinutes)} mins`); }

  score = Math.max(1, Math.min(10, score));
  return { score, flags, positives };
}

async function analyzeCoin(coin, modeFilters, connection) {
  try {
    const [honeypot, authorities] = await Promise.all([
      checkHoneypot(coin.mintAddress).catch(() => ({ isHoneypot: false, sellTax: 0, buyTax: 0 })),
      connection ? checkAuthorities(coin.mintAddress, connection).catch(() => ({ hasMintAuthority: false, hasFreezeAuthority: false })) : Promise.resolve({ hasMintAuthority: false, hasFreezeAuthority: false }),
    ]);

    const { score, flags, positives } = scoreCoin(coin, honeypot, authorities);

    const scoreOk = score >= modeFilters.minScore;
    const notHoneypot = !honeypot.isHoneypot;
    const liqOk = coin.liquidityUSD >= modeFilters.minLiquidityUSD;
    const ageMinOk = coin.ageMinutes >= modeFilters.minAgeMinutes;
    const ageMaxOk = coin.ageMinutes <= modeFilters.maxAgeMinutes;
    const mintOk = !modeFilters.mustHaveNoMintAuthority || !authorities.hasMintAuthority;

console.log(`🔎 ${coin.symbol}: score=${scoreOk}(${score}>=${modeFilters.minScore}) liq=${liqOk}($${Math.round(coin.liquidityUSD)}/$${modeFilters.minLiquidityUSD}) age=${ageMinOk&&ageMaxOk}(${Math.round(coin.ageMinutes)}m) mint=${mintOk}`);

const passesFilters = scoreOk && notHoneypot && liqOk && mintOk;

    return {
      ...coin,
      honeypot,
      authorities,
      score,
      flags,
      positives,
      passesFilters,
    };
  } catch (e) {
    console.error(`Analysis error for ${coin.symbol}: ${e.message}`);
    return null;
  }
}

module.exports = { analyzeCoin };