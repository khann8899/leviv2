// Levi Urgent 2.0 - Position Monitor
const { state, saveState } = require('./state');
const { MODES, AUTOBET_CONFIG } = require('../config/modes');
const { getTokenPrice } = require('./data');
const { sellToken } = require('./execution');

async function monitorAllPositions(wallet, sendMessage) {
  const allPositions = [
    ...Object.values(state.manualPositions),
    ...Object.values(state.autoPositions),
  ];

  for (const position of allPositions) {
    if (position.isPaper) continue; // Paper positions handled separately
    try {
      await checkPosition(position, wallet, sendMessage);
    } catch (e) {
      console.error(`Monitor error for ${position.symbol}: ${e.message}`);
    }
  }
}

async function checkPosition(position, wallet, sendMessage) {
  const currentPrice = await getTokenPrice(position.mintAddress);
  if (!currentPrice || currentPrice <= 0) return;

  position.currentPrice = currentPrice;
  if (currentPrice > position.peakPrice) position.peakPrice = currentPrice;

  const multiplier = currentPrice / position.entryPrice;
  const dropFromPeak = ((position.peakPrice - currentPrice) / position.peakPrice) * 100;
  const dropFromEntry = ((position.entryPrice - currentPrice) / position.entryPrice) * 100;

  const config = position.isAuto ? AUTOBET_CONFIG : MODES[position.mode];
  const takeProfits = config.takeProfits;

  // Check take profits
  if (position.takeProfitIndex < takeProfits.length) {
    const nextTP = takeProfits[position.takeProfitIndex];
    if (multiplier >= nextTP.multiplier) {
      await executeTakeProfit(position, nextTP, multiplier, wallet, sendMessage);
      return;
    }
  }

  // Trailing stop (only after price went up 20%+)
  if (position.peakPrice > position.entryPrice * 1.2) {
    if (dropFromPeak >= config.trailingStopPercent) {
      await closePosition(position, 'Trailing Stop 📉', multiplier, wallet, sendMessage);
      return;
    }
  }

  // Hard stop loss
  if (dropFromEntry >= config.stopLossPercent) {
    await closePosition(position, 'Stop Loss 🛑', multiplier, wallet, sendMessage);
    return;
  }
}

async function executeTakeProfit(position, tp, multiplier, wallet, sendMessage) {
  const sellPercent = tp.sellPercent;
  const tokensToSell = position.tokensHeld * (sellPercent / 100) * (position.remainingPercent / 100);

  const result = await sellToken(position.mintAddress, sellPercent, tokensToSell, wallet);

  if (result.success) {
    position.remainingPercent -= (sellPercent * position.remainingPercent / 100);
    position.takeProfitIndex += 1;

    await sendMessage(
      `💰 *Take Profit ${position.takeProfitIndex} Hit!*\n\n` +
      `${position.isAuto ? '🤖 AUTO' : '👤 MANUAL'} | $${position.symbol}\n` +
      `Hit ${multiplier.toFixed(2)}x | Sold ${sellPercent}%\n` +
      `Received: $${result.usdReceived.toFixed(2)}\n` +
      `Remaining: ${position.remainingPercent.toFixed(0)}%`
    );

    updateStats(position, result.usdReceived, position.amountUSD * (sellPercent / 100), multiplier, false);
    saveState();
  }
}

async function closePosition(position, reason, multiplier, wallet, sendMessage) {
  const remainingTokens = position.tokensHeld * (position.remainingPercent / 100);
  const result = await sellToken(position.mintAddress, 100, remainingTokens, wallet);

  if (result.success) {
    const originalBet = position.amountUSD * (position.remainingPercent / 100);
    const pnl = result.usdReceived - originalBet;
    const isWin = pnl > 0;

    await sendMessage(
      `${isWin ? '🏆' : '🔴'} *Position Closed — ${reason}*\n\n` +
      `${position.isAuto ? '🤖 AUTO' : '👤 MANUAL'} | $${position.symbol}\n` +
      `${multiplier.toFixed(2)}x | P&L: ${isWin ? '+' : ''}$${pnl.toFixed(2)}\n` +
      `Duration: ${Math.round((Date.now() - new Date(position.openedAt)) / 1000 / 60)} mins`
    );

    updateStats(position, result.usdReceived, originalBet, multiplier, true);

    // Remove from positions
    if (position.isAuto) {
      delete state.autoPositions[position.mintAddress];
    } else {
      delete state.manualPositions[position.mintAddress];
    }

    saveState();
  }
}

// Close all auto positions
async function closeAllAutoPositions(wallet, sendMessage) {
  const positions = Object.values(state.autoPositions);
  let totalUSD = 0;

  for (const position of positions) {
    try {
      const remainingTokens = position.tokensHeld * (position.remainingPercent / 100);
      const result = await sellToken(position.mintAddress, 100, remainingTokens, wallet);
      if (result.success) {
        totalUSD += result.usdReceived;
        delete state.autoPositions[position.mintAddress];
      }
    } catch (e) {
      console.error(`Failed to close auto position ${position.symbol}: ${e.message}`);
    }
  }

  saveState();
  return totalUSD;
}

// Close all manual positions
async function closeAllManualPositions(wallet, sendMessage) {
  const positions = Object.values(state.manualPositions);
  let totalUSD = 0;

  for (const position of positions) {
    try {
      const remainingTokens = position.tokensHeld * (position.remainingPercent / 100);
      const result = await sellToken(position.mintAddress, 100, remainingTokens, wallet);
      if (result.success) {
        totalUSD += result.usdReceived;
        delete state.manualPositions[position.mintAddress];
      }
    } catch (e) {
      console.error(`Failed to close manual position ${position.symbol}: ${e.message}`);
    }
  }

  saveState();
  return totalUSD;
}

function updateStats(position, usdReceived, usdInvested, multiplier, isFinal) {
  if (!isFinal) return;

  const isWin = usdReceived > usdInvested;
  const pnlPercent = ((usdReceived - usdInvested) / usdInvested) * 100;

  if (position.isAuto) {
    const s = state.autobetStats;
    s.trades += 1;
    if (isWin) s.wins += 1; else s.losses += 1;
    s.netPnlUSD += usdReceived - usdInvested;
    if (multiplier > s.bestMultiplier) s.bestMultiplier = multiplier;
  } else {
    const s = state.weeklyStats[position.mode];
    s.trades += 1;
    if (isWin) s.wins += 1; else s.losses += 1;
    s.netPnlPercent += pnlPercent;
    if (multiplier > s.bestMultiplier) s.bestMultiplier = multiplier;
    if (s.worstMultiplier === 0 || multiplier < s.worstMultiplier) s.worstMultiplier = multiplier;
  }
}

module.exports = { monitorAllPositions, closeAllAutoPositions, closeAllManualPositions };
