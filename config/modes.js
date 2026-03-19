// Levi Urgent 2.0 - Strategy Modes

const MODES = {
  1: {
    name: "Safe Filter Swing",
    emoji: "🟢",
    filters: {
      minLiquidityUSD: 50000,
      minAgeMinutes: 15,
      maxAgeMinutes: 120,
      mustHaveNoMintAuthority: true,
      minScore: 5,
    },
    takeProfits: [
      { multiplier: 1.5, sellPercent: 50 },
      { multiplier: 3.0, sellPercent: 30 },
    ],
    trailingStopPercent: 15,
    stopLossPercent: 25,
  },
  2: {
    name: "Momentum Riding",
    emoji: "🟡",
    filters: {
      minLiquidityUSD: 30000,
      minAgeMinutes: 30,
      maxAgeMinutes: 60,
      mustHaveNoMintAuthority: true,
      minScore: 5,
    },
    takeProfits: [
      { multiplier: 2.0, sellPercent: 50 },
      { multiplier: 5.0, sellPercent: 25 },
    ],
    trailingStopPercent: 20,
    stopLossPercent: 40,
  },
  3: {
    name: "Early Launch Snipe",
    emoji: "🟠",
    filters: {
      minLiquidityUSD: 10000,
      minAgeMinutes: 1,
      maxAgeMinutes: 10,
      mustHaveNoMintAuthority: true,
      minScore: 4,
    },
    takeProfits: [
      { multiplier: 3.0, sellPercent: 40 },
      { multiplier: 10.0, sellPercent: 30 },
    ],
    trailingStopPercent: 25,
    stopLossPercent: 50,
  },
  4: {
    name: "Degen First-Minute Snipe",
    emoji: "🔴",
    filters: {
      minLiquidityUSD: 5000,
      minAgeMinutes: 0,
      maxAgeMinutes: 1,
      mustHaveNoMintAuthority: false,
      minScore: 3,
    },
    takeProfits: [
      { multiplier: 5.0, sellPercent: 40 },
      { multiplier: 20.0, sellPercent: 30 },
    ],
    trailingStopPercent: 30,
    stopLossPercent: 60,
  },
};

// Autobet always uses these settings regardless of mode
const AUTOBET_CONFIG = {
  minScore: 7,
  takeProfits: [
    { multiplier: 1.7, sellPercent: 50 },  // 70% growth
    { multiplier: 2.0, sellPercent: 50 },  // 100% growth
  ],
  stopLossPercent: 25,
  trailingStopPercent: 20,
};

module.exports = { MODES, AUTOBET_CONFIG };
