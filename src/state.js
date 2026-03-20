// Levi Urgent 2.0 - State Management
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../data/state.json');

const defaultState = {
  currentMode: 1,
  isPaused: false,
  isPaperMode: false,
  betSizeUSD: 3,

  // Manual positions (user approved, real money)
  manualPositions: {},

  // Auto positions (autobet, real money only)
  autoPositions: {},
  autobetActive: false,
  autobetPaused: false,
  autobetSlots: 3,
  autobetTakeProfits: [
    { multiplier: 1.55, sellPercent: 100 },
  ],
  autobetStopLoss: 25,

  // Martingale
  martingaleActive: true,
  martingaleMultiplier: 1.3,
  martingaleCurrentBet: null, // null means use betSizeUSD
  martingaleOriginalBet: null,

  // Paper positions (all paper trades regardless of manual/auto)
  paperPositions: {},
  paperAutobetSlots: 3,
  paperBalance: 100,
  paperStats: {
    trades: 0, wins: 0, losses: 0,
    netPnlUSD: 0, bestMultiplier: 0
  },

  // Weekly stats per mode
  weeklyStats: {
    1: { trades: 0, wins: 0, losses: 0, bestMultiplier: 0, worstMultiplier: 0, netPnlPercent: 0 },
    2: { trades: 0, wins: 0, losses: 0, bestMultiplier: 0, worstMultiplier: 0, netPnlPercent: 0 },
    3: { trades: 0, wins: 0, losses: 0, bestMultiplier: 0, worstMultiplier: 0, netPnlPercent: 0 },
    4: { trades: 0, wins: 0, losses: 0, bestMultiplier: 0, worstMultiplier: 0, netPnlPercent: 0 },
  },

  autobetStats: {
    trades: 0, wins: 0, losses: 0,
    netPnlUSD: 0, bestMultiplier: 0
  },

  sessionStats: { mode: 1, trades: 0, netPnlPercent: 0, startTime: new Date().toISOString() },
  pendingApprovals: {},
  weekStartTime: new Date().toISOString(),
  weekStartBalance: 0,
};

let state = { ...defaultState };

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state = { ...defaultState, ...saved };
      state.pendingApprovals = {};
      console.log('✅ State loaded from disk');
    }
  } catch (e) {
    console.log('⚠️ Could not load state, using defaults');
  }
}

function saveState() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const toSave = { ...state, pendingApprovals: {} };
    fs.writeFileSync(STATE_FILE, JSON.stringify(toSave, null, 2));
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

setInterval(saveState, 30000);

function createPosition(coin, entryPrice, amountUSD, mode, isAuto = false, isPaper = false) {
  return {
    mintAddress: coin.mintAddress,
    symbol: coin.symbol,
    name: coin.name,
    entryPrice: entryPrice || 0.000001,
    currentPrice: entryPrice || 0.000001,
    peakPrice: entryPrice || 0.000001,
    amountUSD,
    tokensHeld: entryPrice > 0 ? amountUSD / entryPrice : 0,
    mode,
    isAuto,
    isPaper,
    openedAt: new Date().toISOString(),
    takeProfitIndex: 0,
    remainingPercent: 100,
    status: 'open',
  };
}

module.exports = { state, loadState, saveState, createPosition };