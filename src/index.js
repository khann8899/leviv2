// Levi Urgent 2.0 - Main Entry Point
require('dotenv').config();

const { state, loadState, saveState, createPosition } = require('./state');
const { MODES, AUTOBET_CONFIG } = require('../config/modes');
const { fetchNewTokens, getSOLPrice } = require('./data');
const { analyzeCoin } = require('./strategy');
const { initWallet, getSOLBalance, buyToken, sellToken, getConnection } = require('./execution');
const { monitorAllPositions, closeAllAutoPositions, closeAllManualPositions } = require('./monitor');
const { initBot, getBot, send, sendStartup, sendCoinAlert, removeButtons, isAuthorized } = require('./telegram');
const { sleep } = require('./http');

function validateEnv() {
  ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'WALLET_PRIVATE_KEY', 'SOLANA_RPC_URL'].forEach(k => {
    if (!process.env[k]) throw new Error(`Missing: ${k}`);
  });
}

async function main() {
  validateEnv();
  loadState();

  const wallet = initWallet();
  console.log(`✅ Wallet: ${wallet.publicKey.toString()}`);

  const solBalance = await getSOLBalance(wallet.publicKey);
  const solPrice = await getSOLPrice();
  state.weekStartBalance = solBalance * solPrice;
  if (state.betSizeUSD === 3) {
    state.betSizeUSD = parseFloat((solBalance * solPrice / 4).toFixed(2));
  }

  console.log(`💰 Balance: ${solBalance.toFixed(4)} SOL ($${(solBalance * solPrice).toFixed(2)})`);
  console.log(`🎯 Bet size: $${state.betSizeUSD}`);

  const bot = initBot();
  await sleep(3000);
  await sendStartup(solBalance, solPrice);

  // ==================== COMMAND HANDLERS ====================

  // Mode switching
  for (let i = 1; i <= 4; i++) {
    bot.onText(new RegExp(`^/mode${i}$`), async (msg) => {
      if (!isAuthorized(msg)) return;
      const prev = state.currentMode;
      const prevStats = state.sessionStats;
      state.currentMode = i;
      state.sessionStats = { mode: i, trades: 0, netPnlPercent: 0, startTime: new Date().toISOString() };
      saveState();
      const mode = MODES[i];
      await send(
        `📊 Mode ${prev} session: ${prevStats.trades} trades | ${prevStats.netPnlPercent >= 0 ? '+' : ''}${prevStats.netPnlPercent.toFixed(1)}%\n\n` +
        `Switched to ${mode.emoji} *Mode ${i} — ${mode.name}*`
      );
    });
  }

  // Pause/Resume
  bot.onText(/^\/pause$/, async (msg) => {
    if (!isAuthorized(msg)) return;
    state.isPaused = true; saveState();
    await send('⏸️ *Paused* — No new alerts. Use /resume to restart.');
  });

  bot.onText(/^\/resume$/, async (msg) => {
    if (!isAuthorized(msg)) return;
    state.isPaused = false; saveState();
    await send('▶️ *Resumed* — Scanning for coins...');
  });

  // Paper / Real mode
  bot.onText(/^\/paper$/, async (msg) => {
    if (!isAuthorized(msg)) return;
    state.isPaperMode = true; saveState();
    await send(`📝 *Paper Trading Mode ON*\n\nAll trades are simulated.\nPaper balance: $${state.paperBalance.toFixed(2)}\nUse /real to switch back.`);
  });

  bot.onText(/^\/real$/, async (msg) => {
    if (!isAuthorized(msg)) return;
    state.isPaperMode = false; saveState();
    await send('💰 *Real Trading Mode ON*\n\nLive trades enabled. Be careful!');
  });

  // Betsize
  bot.onText(/^\/betsize (.+)$/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const amount = parseFloat(match[1].replace('$', ''));
    if (isNaN(amount) || amount <= 0) { await send('❌ Example: /betsize 3'); return; }
    state.betSizeUSD = amount; saveState();
    await send(`✅ Bet size: *$${amount}* per trade`);
  });

  // Set TP
  bot.onText(/^\/settp (.+)$/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    await send(
      `⚙️ *Set Take Profits*\n\nCurrent TPs for Mode ${state.currentMode}:\n` +
      `TP1: ${MODES[state.currentMode].takeProfits[0].multiplier}x → sell ${MODES[state.currentMode].takeProfits[0].sellPercent}%\n` +
      `TP2: ${MODES[state.currentMode].takeProfits[1].multiplier}x → sell ${MODES[state.currentMode].takeProfits[1].sellPercent}%\n\n` +
      `Format: /settp 2x50 5x25\n(TP1: 2x sell 50%, TP2: 5x sell 25%)`
    );
  });

  // Set SL
  bot.onText(/^\/setstoploss (.+)$/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const sl = parseFloat(match[1].replace('%', ''));
    if (isNaN(sl) || sl <= 0 || sl > 100) { await send('❌ Example: /setstoploss 25'); return; }
    MODES[state.currentMode].stopLossPercent = sl;
    await send(`✅ Stop loss set to *-${sl}%* for Mode ${state.currentMode}`);
  });

  // Close all
  bot.onText(/^\/closeall$/, async (msg) => {
    if (!isAuthorized(msg)) return;
    const manualCount = Object.keys(state.manualPositions).length;
    const autoCount = Object.keys(state.autoPositions).length;
    if (manualCount + autoCount === 0) { await send('📭 No open positions.'); return; }
    await send(`⏳ Closing ${manualCount + autoCount} positions...`);
    const [manualUSD, autoUSD] = await Promise.all([
      closeAllManualPositions(wallet, send),
      closeAllAutoPositions(wallet, send),
    ]);
    await send(`🔴 *All Positions Closed*\n\nManual: $${manualUSD.toFixed(2)}\nAuto: $${autoUSD.toFixed(2)}\nTotal: $${(manualUSD + autoUSD).toFixed(2)}`);
  });

  // Autobet
  bot.onText(/^\/autobet pause$/, async (msg) => {
    if (!isAuthorized(msg)) return;
    state.autobetPaused = true; saveState();
    await send('⏸️ *Autobet Paused*\n\nNo new auto trades. Existing positions will finish naturally.');
  });

  bot.onText(/^\/autobet (\d+)$/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const slots = parseInt(match[1]);
    if (slots < 1 || slots > 20) { await send('❌ Slots must be between 1 and 20'); return; }
    state.autobetActive = true;
    state.autobetPaused = false;
    state.autobetSlots = slots;
    saveState();
    await send(
      `🤖 *Autobet ACTIVATED*\n\n` +
      `Slots: ${slots}\n` +
      `Bet size: $${state.betSizeUSD} per trade\n` +
      `Min score: 7/10\n` +
      `TP1: +70% → sell 50%\n` +
      `TP2: +100% → sell 50%\n` +
      `Stop Loss: -25%\n\n` +
      `Bot will trade autonomously 24/7.\n` +
      `Use /stopautobet to stop.`
    );
  });

  bot.onText(/^\/stopautobet$/, async (msg) => {
    if (!isAuthorized(msg)) return;
    state.autobetActive = false;
    state.autobetPaused = false;
    saveState();
    const count = Object.keys(state.autoPositions).length;
    if (count > 0) {
      await send(`⏳ Stopping autobet and closing ${count} auto positions...`);
      const totalUSD = await closeAllAutoPositions(wallet, send);
      await send(`🔴 *Autobet Stopped*\n\nClosed ${count} positions → $${totalUSD.toFixed(2)} SOL`);
    } else {
      await send('🔴 *Autobet Stopped*\n\nNo open auto positions.');
    }
  });

  // Add paper balance
  bot.onText(/^\/addpaper (.+)$/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const amount = parseFloat(match[1].replace('$', ''));
    if (isNaN(amount) || amount <= 0) { await send('❌ Example: /addpaper 100'); return; }
    state.paperBalance += amount;
    saveState();
    await send(`📝 *Paper Balance Updated*\n\nAdded: $${amount}\nNew balance: $${state.paperBalance.toFixed(2)}`);
  });

  // Set autobet take profits
  bot.onText(/^\/setautotp (.+)$/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    // Format: /setautotp 1.7x50 2x50
    const parts = match[1].trim().split(' ');
    if (parts.length !== 2) {
      await send('❌ Format: /setautotp 1.7x50 2x50\n(TP1: 1.7x sell 50%, TP2: 2x sell 50%)');
      return;
    }
    try {
      const [m1, s1] = parts[0].split('x').map(Number);
      const [m2, s2] = parts[1].split('x').map(Number);
      if (!m1 || !s1 || !m2 || !s2) throw new Error('Invalid format');
      state.autobetTakeProfits = [
        { multiplier: m1, sellPercent: s1 },
        { multiplier: m2, sellPercent: s2 },
      ];
      saveState();
      await send(
        `✅ *Autobet TPs Updated*\n\n` +
        `TP1: ${m1}x → sell ${s1}%\n` +
        `TP2: ${m2}x → sell ${s2}%\n\n` +
        `Applies to both real and paper autobet.`
      );
    } catch {
      await send('❌ Format: /setautotp 1.7x50 2x50');
    }
  });

  // Set autobet stop loss
  bot.onText(/^\/setautosl (.+)$/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const sl = parseFloat(match[1].replace('%', ''));
    if (isNaN(sl) || sl <= 0 || sl > 100) { await send('❌ Example: /setautosl 25'); return; }
    state.autobetStopLoss = sl;
    saveState();
    await send(`✅ *Autobet Stop Loss: -${sl}%*\n\nApplies to both real and paper autobet.`);
  });


  // Martingale toggle
  bot.onText(/^\/martingale$/, async (msg) => {
    if (!isAuthorized(msg)) return;
    state.martingaleActive = !state.martingaleActive;
    if (!state.martingaleActive && state.martingaleOriginalBet) {
      state.betSizeUSD = state.martingaleOriginalBet;
      state.martingaleOriginalBet = null;
      state.martingaleCurrentBet = null;
    }
    saveState();
    await send(
      `📈 *Martingale: ${state.martingaleActive ? 'ON ✅' : 'OFF ❌'}*\n\n` +
      `Multiplier: ${state.martingaleMultiplier}x after each SL\n` +
      `Resets to original bet after TP\n\n` +
      `Use /setmartingale 1.5 to change multiplier`
    );
  });

  bot.onText(/^\/setmartingale (.+)$/, async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const mult = parseFloat(match[1]);
    if (isNaN(mult) || mult <= 1 || mult > 3) {
      await send('❌ Must be between 1.1 and 3\nExample: /setmartingale 1.3');
      return;
    }
    state.martingaleMultiplier = mult;
    saveState();
    await send(`✅ Martingale multiplier: *${mult}x*`);
  });

  bot.onText(/^\/autostatus$/, async (msg) => {
    if (!isAuthorized(msg)) return;
    const s = state.autobetStats;
    const positions = Object.values(state.autoPositions);
    const total = s.wins + s.losses;
    await send(
      `🤖 *Autobet Status*\n\n` +
      `Active: ${state.autobetActive ? `✅ ${state.autobetSlots} slots` : '❌ Off'}\n` +
      `Open positions: ${positions.length}\n\n` +
      `Total trades: ${total}\n` +
      `Wins: ${s.wins} | Losses: ${s.losses}\n` +
      `Win rate: ${total > 0 ? ((s.wins / total) * 100).toFixed(1) : 0}%\n` +
      `Net P&L: ${s.netPnlUSD >= 0 ? '+' : ''}$${s.netPnlUSD.toFixed(2)}\n` +
      `Best trade: ${s.bestMultiplier.toFixed(2)}x`
    );
  });

  // Portfolio
  bot.onText(/^\/portfolio$/, async (msg) => {
    if (!isAuthorized(msg)) return;
    const manual = Object.values(state.manualPositions);
    const auto = Object.values(state.autoPositions);
    const paper = Object.values(state.paperPositions);

    if (manual.length + auto.length + paper.length === 0) {
      await send('📭 No open positions.');
      return;
    }

    let message = `📋 *Portfolio*\n\n`;

    if (manual.length > 0) {
      message += `👤 *Manual (${manual.length})*\n`;
      for (const p of manual) {
        const mult = p.entryPrice > 0 ? p.currentPrice / p.entryPrice : 1;
        const pnl = (mult - 1) * 100;
        message += `${pnl >= 0 ? '🟢' : '🔴'} $${p.symbol} | ${mult.toFixed(2)}x | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%\n`;
      }
      message += '\n';
    }

    if (auto.length > 0) {
      message += `🤖 *Auto Real (${auto.length})*\n`;
      for (const p of auto) {
        const mult = p.entryPrice > 0 ? p.currentPrice / p.entryPrice : 1;
        const pnl = (mult - 1) * 100;
        message += `${pnl >= 0 ? '🟢' : '🔴'} $${p.symbol} | ${mult.toFixed(2)}x | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%\n`;
      }
      message += '\n';
    }

    if (paper.length > 0) {
      message += `📝 *Paper (${paper.length})*\n`;
      for (const p of paper) {
        const mult = p.entryPrice > 0 ? p.currentPrice / p.entryPrice : 1;
        const pnl = (mult - 1) * 100;
        message += `${pnl >= 0 ? '🟢' : '🔴'} $${p.symbol} | ${mult.toFixed(2)}x | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%\n`;
      }
      message += `\nPaper balance: $${state.paperBalance.toFixed(2)}`;
    }

    await send(message);
  });

  // Status
  bot.onText(/^\/status$/, async (msg) => {
    if (!isAuthorized(msg)) return;
    const mode = MODES[state.currentMode];
    const solBal = await getSOLBalance(wallet.publicKey);
    const solPriceNow = await getSOLPrice();
    await send(
      `📡 *Bot Status*\n\n` +
      `Mode: ${mode.emoji} ${mode.name}\n` +
      `Trading: ${state.isPaperMode ? '📝 Paper' : '💰 Real'}\n` +
      `Status: ${state.isPaused ? '⏸️ Paused' : '▶️ Active'}\n` +
      `Autobet: ${state.autobetActive ? `🤖 ${state.autobetSlots} slots` : '❌ Off'}\n\n` +
      `Manual positions: ${Object.keys(state.manualPositions).length}\n` +
      `Auto positions: ${Object.keys(state.autoPositions).length}\n\n` +
      `Bet size: $${state.betSizeUSD}\n` +
      `Balance: ${solBal.toFixed(4)} SOL ($${(solBal * solPriceNow).toFixed(2)})`
    );
  });

  // Report
  bot.onText(/^\/report$/, async (msg) => {
    if (!isAuthorized(msg)) return;
    const s = state.weeklyStats[state.currentMode];
    const mode = MODES[state.currentMode];
    const solBal = await getSOLBalance(wallet.publicKey);
    const solPriceNow = await getSOLPrice();
    const total = s.wins + s.losses;
    await send(
      `📊 *Weekly Report — ${mode.emoji} ${mode.name}*\n\n` +
      `Trades: ${total} | Wins: ${s.wins} | Losses: ${s.losses}\n` +
      `Win Rate: ${total > 0 ? ((s.wins / total) * 100).toFixed(1) : 0}%\n` +
      `Best: ${s.bestMultiplier.toFixed(2)}x | Worst: ${s.worstMultiplier.toFixed(2)}x\n` +
      `Net: ${s.netPnlPercent >= 0 ? '+' : ''}${s.netPnlPercent.toFixed(1)}%\n\n` +
      `💼 Balance: ${solBal.toFixed(4)} SOL ($${(solBal * solPriceNow).toFixed(2)})`
    );
  });

  // Paper status
  bot.onText(/^\/paperstatus$/, async (msg) => {
    if (!isAuthorized(msg)) return;
    const s = state.paperStats;
    const total = s.wins + s.losses;
    await send(
      `📝 *Paper Trading Stats*\n\n` +
      `Balance: $${state.paperBalance.toFixed(2)}\n` +
      `Trades: ${total} | Wins: ${s.wins} | Losses: ${s.losses}\n` +
      `Win Rate: ${total > 0 ? ((s.wins / total) * 100).toFixed(1) : 0}%\n` +
      `Net P&L: ${s.netPnlUSD >= 0 ? '+' : ''}$${s.netPnlUSD.toFixed(2)}\n` +
      `Best trade: ${s.bestMultiplier.toFixed(2)}x`
    );
  });

  // ==================== APPROVAL HANDLERS ====================

  bot.on('callback_query', async (query) => {
    if (query.message.chat.id.toString() !== process.env.TELEGRAM_CHAT_ID) return;
    await bot.answerCallbackQuery(query.id);
    const data = query.data;

    if (data.startsWith('approve_')) {
      const mintAddress = data.replace('approve_', '');
      const pending = state.pendingApprovals[mintAddress];
      if (!pending) { await send('⏰ Alert expired.'); return; }

      clearTimeout(pending.timeout);
      delete state.pendingApprovals[mintAddress];
      await removeButtons(query.message.message_id);

      if (state.isPaperMode) {
        // Paper trade
        if (state.paperBalance < state.betSizeUSD) {
          await send('❌ Insufficient paper balance.');
          return;
        }
        state.paperBalance -= state.betSizeUSD;
        const position = createPosition(pending.coin, pending.coin.priceUSD, state.betSizeUSD, state.currentMode, false, true);
        position.tokensHeld = state.betSizeUSD / pending.coin.priceUSD;
        state.paperPositions[mintAddress] = position;
        saveState();
        await send(`📝 *Paper Trade Opened*\n\n$${pending.coin.symbol} | $${state.betSizeUSD}\nPaper balance: $${state.paperBalance.toFixed(2)}`);
        return;
      }

      await send(`⏳ Buying $${pending.coin.symbol}...`);
      const result = await buyToken(mintAddress, state.betSizeUSD, wallet);

      if (result.success) {
        const position = createPosition(pending.coin, pending.coin.priceUSD, state.betSizeUSD, state.currentMode, false, false);
        position.tokensHeld = result.tokensReceived;
        state.manualPositions[mintAddress] = position;
        saveState();
        await send(
          `🟢 *Trade Opened!*\n\n` +
          `👤 MANUAL | $${pending.coin.symbol}\n` +
          `Invested: $${state.betSizeUSD}\n` +
          `TX: [View](https://solscan.io/tx/${result.txid})`
        );
      } else {
        await send(`❌ Trade failed: ${result.error}`);
      }
    }

    if (data.startsWith('skip_')) {
      const mintAddress = data.replace('skip_', '');
      const pending = state.pendingApprovals[mintAddress];
      if (pending) { clearTimeout(pending.timeout); delete state.pendingApprovals[mintAddress]; }
      await removeButtons(query.message.message_id);
      await send('⏭️ Skipped.');
    }
  });

  // ==================== SCAN LOOP ====================

  async function scanForCoins() {
    if (state.isPaused) return;

    try {
      const newTokens = await fetchNewTokens();
      console.log(`🔎 ${newTokens.length} new tokens to check`);

      for (const token of newTokens) {
        if (state.isPaused) break;
        if (state.pendingApprovals[token.mintAddress]) continue;
        if (state.manualPositions[token.mintAddress]) continue;
        if (state.autoPositions[token.mintAddress]) continue;
        if (state.paperPositions[token.mintAddress]) continue; // prevent duplicate paper trades

        const modeConfig = MODES[state.currentMode];
        console.log(`🔍 Analyzing ${token.symbol} (${token.mintAddress.slice(0, 8)}...)`);

        const analysis = await analyzeCoin(token, modeConfig.filters, getConnection());
        if (!analysis) continue;

        console.log(`📊 ${token.symbol} score: ${analysis.score}/10 | passes: ${analysis.passesFilters}`);

        // AUTOBET: auto-execute if score >= 7 and slots available
        const paperSlotCount = Object.keys(state.paperPositions).length;
        const realSlotCount = Object.keys(state.autoPositions).length;
        const currentSlotCount = state.isPaperMode ? paperSlotCount : realSlotCount;

        if (
          state.autobetActive &&
          !state.autobetPaused &&
          analysis.score >= AUTOBET_CONFIG.minScore &&
          !analysis.honeypot?.isHoneypot &&
          currentSlotCount < state.autobetSlots
        ) {
          console.log(`🤖 Autobet triggered for ${token.symbol} (${currentSlotCount}/${state.autobetSlots} slots)`);
          await executeAutobetTrade(analysis, wallet);
          continue;
        }

        // MANUAL: send alert if passes mode filters
        if (analysis.passesFilters) {
          console.log(`✅ ${token.symbol} passed! Sending alert...`);
          const messageId = await sendCoinAlert(analysis, modeConfig);

          const timeout = setTimeout(async () => {
            if (state.pendingApprovals[token.mintAddress]) {
              delete state.pendingApprovals[token.mintAddress];
              await removeButtons(messageId);
              await send(`⏰ Auto-skipped $${token.symbol}`);
            }
          }, 10 * 60 * 1000);

          state.pendingApprovals[token.mintAddress] = { coin: analysis, timeout, messageId };
        }
      }
    } catch (e) {
      console.error('Scan error:', e.message);
    }
  }

  async function executeAutobetTrade(coin, wallet) {
    if (state.isPaperMode) {
      if (state.paperBalance < state.betSizeUSD) return;
      state.paperBalance -= state.betSizeUSD;
      const position = createPosition(coin, coin.priceUSD, state.betSizeUSD, state.currentMode, true, true);
      position.tokensHeld = coin.priceUSD > 0 ? state.betSizeUSD / coin.priceUSD : 1;
      state.paperPositions[coin.mintAddress] = position;
      saveState();
      await send(`📝🤖 *Paper Autobet Opened*\n\n$${coin.symbol} | Score: ${coin.score}/10 | $${state.betSizeUSD}\nPaper balance: $${state.paperBalance.toFixed(2)}`);
      return;
    }

    const result = await buyToken(coin.mintAddress, state.betSizeUSD, wallet);
    if (result.success) {
      const position = createPosition(coin, coin.priceUSD, state.betSizeUSD, state.currentMode, true, false);
      position.tokensHeld = result.tokensReceived;
      state.autoPositions[coin.mintAddress] = position;
      saveState();
      await send(
        `🤖 *Autobet Trade Opened*\n\n` +
        `$${coin.symbol} | Score: ${coin.score}/10\n` +
        `Invested: $${state.betSizeUSD}\n` +
        `Slots used: ${Object.keys(state.autoPositions).length}/${state.autobetSlots}\n` +
        `TX: [View](https://solscan.io/tx/${result.txid})`
      );
    } else {
      console.error(`Autobet trade failed for ${coin.symbol}: ${result.error}`);
    }
  }

  // ==================== WEEKLY REPORT ====================

  function scheduleWeeklyReport() {
    const now = new Date();
    const nextSunday = new Date(now);
    nextSunday.setDate(now.getDate() + (7 - now.getDay()));
    nextSunday.setHours(20, 0, 0, 0);
    setTimeout(async () => {
      const solBal = await getSOLBalance(wallet.publicKey);
      const solPriceNow = await getSOLPrice();
      const s = state.weeklyStats[state.currentMode];
      const mode = MODES[state.currentMode];
      const total = s.wins + s.losses;
      await send(
        `📊 *Weekly Report — ${mode.emoji} ${mode.name}*\n\n` +
        `Trades: ${total} | Wins: ${s.wins} | Losses: ${s.losses}\n` +
        `Net: ${s.netPnlPercent >= 0 ? '+' : ''}${s.netPnlPercent.toFixed(1)}%\n` +
        `Balance: ${solBal.toFixed(4)} SOL ($${(solBal * solPriceNow).toFixed(2)})`
      );
      state.weeklyStats[state.currentMode] = { trades: 0, wins: 0, losses: 0, bestMultiplier: 0, worstMultiplier: 0, netPnlPercent: 0 };
      scheduleWeeklyReport();
    }, nextSunday - now);
  }

  // ==================== START ====================

  scheduleWeeklyReport();
  setInterval(scanForCoins, 45000);
  setInterval(() => monitorAllPositions(wallet, send), 30000);
  await scanForCoins();

  console.log('🚀 Levi Urgent 2.0 is running!');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });