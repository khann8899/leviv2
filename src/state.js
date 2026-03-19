// Levi Urgent 2.0 - State Management
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../data/state.json');

const defaultState = {
  // Trading mode
  currentMode: 1,
  isPaused: false,
  isPaperMode: false,

  // Bet size
  betSizeUSD: 3,

  // Manual positions (user approved)
  manualPositions: {},

  // Auto positions (autobet)
  autoPositions: {},
  autobetActive: false,
  autobetPaused: false,
  autobetSlots: 5,

  // Paper trading
  paperBalance: 100,
  paperPositions: {},
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

  // Autobet stats
  autobetStats: {
    trades: 0, wins: 0, losses: 0,
    netPnlUSD: 0, bestMultiplier: 0
  },

  // Session stats
  sessionStats: { mode: 1, trades: 0, netPnlPercent: 0, startTime: new Date().toISOString() },

  // Pending approvals
  pendingApprovals: {},

  // Week tracking
  weekStartTime: new Date().toISOString(),
  weekStartBalance: 0,
};

let state = { ...defaultState };

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      // Merge saved state with defaults (in case new fields added)
      state = { ...defaultState, ...saved };
      // Clear pending approvals on restart
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
    // Don't save pending approvals
    const toSave = { ...state, pendingApprovals: {} };
    fs.writeFileSync(STATE_FILE, JSON.stringify(toSave, null, 2));
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

// Auto-save every 30 seconds
setInterval(saveState, 30000);

function createPosition(coin, entryPrice, amountUSD, mode, isAuto = false, isPaper = false) {
  return {
    mintAddress: coin.mintAddress,
    symbol: coin.symbol,
    name: coin.name,
    entryPrice,
    currentPrice: entryPrice,
    peakPrice: entryPrice,
    amountUSD,
    tokensHeld: 0,
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
