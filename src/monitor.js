// Levi Urgent 2.0 - Position Monitor
const { state, saveState } = require(’./state’);
const { MODES, getAutobetConfig } = require(’../config/modes’);
const { getTokenPrice } = require(’./data’);
const { sellToken } = require(’./execution’);

async function monitorAllPositions(wallet, sendMessage) {
// Monitor real positions
const realPositions = [
…Object.values(state.manualPositions),
…Object.values(state.autoPositions),
];

// Monitor paper positions
const paperPositions = Object.values(state.paperPositions);

for (const position of realPositions) {
try {
await checkRealPosition(position, wallet, sendMessage);
} catch (e) {
console.error(`Monitor error for ${position.symbol}: ${e.message}`);
}
}

for (const position of paperPositions) {
try {
await checkPaperPosition(position, sendMessage);
} catch (e) {
console.error(`Paper monitor error for ${position.symbol}: ${e.message}`);
}
}
}

async function checkRealPosition(position, wallet, sendMessage) {
const currentPrice = await getTokenPrice(position.mintAddress);
if (!currentPrice || currentPrice <= 0) return;

position.currentPrice = currentPrice;
if (currentPrice > position.peakPrice) position.peakPrice = currentPrice;

const multiplier = currentPrice / position.entryPrice;
const dropFromPeak = ((position.peakPrice - currentPrice) / position.peakPrice) * 100;
const dropFromEntry = ((position.entryPrice - currentPrice) / position.entryPrice) * 100;

const config = position.isAuto ? getAutobetConfig() : MODES[position.mode];

// Check take profits
if (position.takeProfitIndex < config.takeProfits.length) {
const nextTP = config.takeProfits[position.takeProfitIndex];
if (multiplier >= nextTP.multiplier) {
await executeRealTakeProfit(position, nextTP, multiplier, wallet, sendMessage);
return;
}
}

// Trailing stop
if (position.peakPrice > position.entryPrice * 1.2) {
if (dropFromPeak >= config.trailingStopPercent) {
await closeRealPosition(position, ‘Trailing Stop 📉’, multiplier, wallet, sendMessage);
return;
}
}

// Hard stop loss
if (dropFromEntry >= config.stopLossPercent) {
await closeRealPosition(position, ‘Stop Loss 🛑’, multiplier, wallet, sendMessage);
}
}

async function checkPaperPosition(position, sendMessage) {
const currentPrice = await getTokenPrice(position.mintAddress);
if (!currentPrice || currentPrice <= 0) return;

position.currentPrice = currentPrice;
if (currentPrice > position.peakPrice) position.peakPrice = currentPrice;

const multiplier = currentPrice / position.entryPrice;
const dropFromPeak = ((position.peakPrice - currentPrice) / position.peakPrice) * 100;
const dropFromEntry = ((position.entryPrice - currentPrice) / position.entryPrice) * 100;

const config = getAutobetConfig();

// Check take profits
if (position.takeProfitIndex < config.takeProfits.length) {
const nextTP = config.takeProfits[position.takeProfitIndex];
if (multiplier >= nextTP.multiplier) {
await executePaperTakeProfit(position, nextTP, multiplier, sendMessage);
return;
}
}

// Trailing stop
if (position.peakPrice > position.entryPrice * 1.2) {
if (dropFromPeak >= config.trailingStopPercent) {
await closePaperPosition(position, ‘Trailing Stop 📉’, multiplier, sendMessage);
return;
}
}

// Hard stop loss
if (dropFromEntry >= config.stopLossPercent) {
await closePaperPosition(position, ‘Stop Loss 🛑’, multiplier, sendMessage);
}
}

// ==================== PAPER FUNCTIONS ====================

async function executePaperTakeProfit(position, tp, multiplier, sendMessage) {
const sellPercent = tp.sellPercent;
const portionBet = position.amountUSD * (position.remainingPercent / 100);
const usdReceived = portionBet * (sellPercent / 100) * multiplier;

position.remainingPercent -= (position.remainingPercent * sellPercent / 100);
position.takeProfitIndex += 1;
state.paperBalance += usdReceived;

// Reset martingale on TP
if (position.isAuto && state.martingaleActive) {
if (state.martingaleOriginalBet) {
state.betSizeUSD = state.martingaleOriginalBet;
state.martingaleCurrentBet = null;
state.martingaleOriginalBet = null;
console.log(`🔄 Martingale reset to $${state.betSizeUSD}`);
}
}

await sendMessage(
`📝💰 *Paper TP Hit! +55%*\n\n` +
`$${position.symbol} hit ${multiplier.toFixed(2)}x\n` +
`Received: $${usdReceived.toFixed(2)}\n` +
`Paper balance: $${state.paperBalance.toFixed(2)}\n` +
`Bet size reset to: $${state.betSizeUSD.toFixed(2)}`
);
saveState();
}

async function closePaperPosition(position, reason, multiplier, sendMessage) {
const originalBet = position.amountUSD * (position.remainingPercent / 100);
const usdReceived = originalBet * multiplier;
const pnl = usdReceived - originalBet;
const isWin = pnl > 0;

state.paperBalance += usdReceived;
state.paperStats.trades += 1;
if (isWin) state.paperStats.wins += 1; else state.paperStats.losses += 1;
state.paperStats.netPnlUSD += pnl;
if (multiplier > state.paperStats.bestMultiplier) state.paperStats.bestMultiplier = multiplier;

// Martingale on SL
let martingaleMsg = ‘’;
if (!isWin && position.isAuto && state.martingaleActive) {
if (!state.martingaleOriginalBet) {
state.martingaleOriginalBet = state.betSizeUSD;
}
const newBet = parseFloat((state.betSizeUSD * state.martingaleMultiplier).toFixed(2));
state.betSizeUSD = newBet;
state.martingaleCurrentBet = newBet;
martingaleMsg = `\n📈 Martingale: next bet → $${newBet.toFixed(2)}`;
console.log(`📈 Martingale triggered: $${state.betSizeUSD}`);
}

await sendMessage(
`📝${isWin ? '🏆' : '🔴'} *Paper Closed — ${reason}*\n\n` +
`$${position.symbol} | ${multiplier.toFixed(2)}x\n` +
`P&L: ${isWin ? '+' : ''}$${pnl.toFixed(2)}\n` +
`Paper balance: $${state.paperBalance.toFixed(2)}${martingaleMsg}`
);

delete state.paperPositions[position.mintAddress];
saveState();
}

// ==================== REAL FUNCTIONS ====================

async function executeRealTakeProfit(position, tp, multiplier, wallet, sendMessage) {
const sellPercent = tp.sellPercent;
const tokensToSell = Math.floor(position.tokensHeld * (position.remainingPercent / 100) * (sellPercent / 100));

const result = await sellToken(position.mintAddress, sellPercent, tokensToSell, wallet);

if (result.success) {
position.remainingPercent -= (position.remainingPercent * sellPercent / 100);
position.takeProfitIndex += 1;

```
// Reset martingale on TP hit
let martingaleMsg = '';
if (position.isAuto && state.martingaleActive && state.martingaleOriginalBet) {
  state.betSizeUSD = state.martingaleOriginalBet;
  state.martingaleCurrentBet = null;
  state.martingaleOriginalBet = null;
  martingaleMsg = `\n🔄 Martingale reset to $${state.betSizeUSD.toFixed(2)}`;
}

await sendMessage(
  `💰 *Take Profit Hit! +55%*\n\n` +
  `${position.isAuto ? '🤖 AUTO' : '👤 MANUAL'} | $${position.symbol}\n` +
  `Hit ${multiplier.toFixed(2)}x${martingaleMsg}`
);

updateRealStats(position, multiplier, true);
saveState();
```

}
}

async function closeRealPosition(position, reason, multiplier, wallet, sendMessage) {
const tokensToSell = Math.floor(position.tokensHeld * (position.remainingPercent / 100));
const result = await sellToken(position.mintAddress, 100, tokensToSell, wallet);

if (result.success) {
const pnl = result.usdReceived - (position.amountUSD * position.remainingPercent / 100);
const isWin = pnl > 0;

```
// Martingale on real autobet SL
let martingaleMsg = '';
if (!isWin && position.isAuto && state.martingaleActive) {
  if (!state.martingaleOriginalBet) state.martingaleOriginalBet = state.betSizeUSD;
  const newBet = parseFloat((state.betSizeUSD * state.martingaleMultiplier).toFixed(2));
  state.betSizeUSD = newBet;
  state.martingaleCurrentBet = newBet;
  martingaleMsg = `\n📈 Martingale: next bet → $${newBet.toFixed(2)}`;
}

// Reset martingale on win
if (isWin && position.isAuto && state.martingaleActive && state.martingaleOriginalBet) {
  state.betSizeUSD = state.martingaleOriginalBet;
  state.martingaleCurrentBet = null;
  state.martingaleOriginalBet = null;
  martingaleMsg = `\n🔄 Martingale reset to $${state.betSizeUSD.toFixed(2)}`;
}

await sendMessage(
  `${isWin ? '🏆' : '🔴'} *Position Closed — ${reason}*\n\n` +
  `${position.isAuto ? '🤖 AUTO' : '👤 MANUAL'} | $${position.symbol}\n` +
  `${multiplier.toFixed(2)}x | P&L: ${isWin ? '+' : ''}$${pnl.toFixed(2)}\n` +
  `Duration: ${Math.round((Date.now() - new Date(position.openedAt)) / 1000 / 60)} mins${martingaleMsg}`
);

updateRealStats(position, multiplier, true);

if (position.isAuto) delete state.autoPositions[position.mintAddress];
else delete state.manualPositions[position.mintAddress];

saveState();
```

}
}

async function closeAllAutoPositions(wallet, sendMessage) {
const positions = Object.values(state.autoPositions);
let totalUSD = 0;

for (const position of positions) {
try {
const tokensToSell = Math.floor(position.tokensHeld * (position.remainingPercent / 100));
const result = await sellToken(position.mintAddress, 100, tokensToSell, wallet);
if (result.success) {
totalUSD += result.usdReceived;
delete state.autoPositions[position.mintAddress];
}
} catch (e) {
console.error(`Failed to close ${position.symbol}: ${e.message}`);
}
}

// Also close paper positions if in paper mode
const paperPositions = Object.values(state.paperPositions);
for (const position of paperPositions) {
const usdBack = position.amountUSD * (position.remainingPercent / 100);
state.paperBalance += usdBack;
totalUSD += usdBack;
delete state.paperPositions[position.mintAddress];
}

saveState();
return totalUSD;
}

async function closeAllManualPositions(wallet, sendMessage) {
const positions = Object.values(state.manualPositions);
let totalUSD = 0;

for (const position of positions) {
try {
const tokensToSell = Math.floor(position.tokensHeld * (position.remainingPercent / 100));
const result = await sellToken(position.mintAddress, 100, tokensToSell, wallet);
if (result.success) {
totalUSD += result.usdReceived;
delete state.manualPositions[position.mintAddress];
}
} catch (e) {
console.error(`Failed to close ${position.symbol}: ${e.message}`);
}
}

saveState();
return totalUSD;
}

function updateRealStats(position, multiplier, isFinal) {
if (!isFinal) return;
if (position.isAuto) {
const s = state.autobetStats;
s.trades += 1;
if (multiplier >= 1) s.wins += 1; else s.losses += 1;
if (multiplier > s.bestMultiplier) s.bestMultiplier = multiplier;
} else {
const s = state.weeklyStats[position.mode];
s.trades += 1;
if (multiplier >= 1) s.wins += 1; else s.losses += 1;
if (multiplier > s.bestMultiplier) s.bestMultiplier = multiplier;
if (s.worstMultiplier === 0 || multiplier < s.worstMultiplier) s.worstMultiplier = multiplier;
}
}

module.exports = { monitorAllPositions, closeAllAutoPositions, closeAllManualPositions };