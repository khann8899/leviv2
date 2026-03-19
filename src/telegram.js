// Levi Urgent 2.0 - Telegram Interface
const TelegramBot = require('node-telegram-bot-api');
const { state } = require('./state');
const { MODES, AUTOBET_CONFIG } = require('../config/modes');

let bot;

function initBot() {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  bot.deleteWebHook().then(() => {
    bot.startPolling({ restart: false, params: { timeout: 10 } });
    console.log('✅ Telegram bot initialized');
  }).catch(() => {
    bot.startPolling({ restart: false, params: { timeout: 10 } });
  });
  return bot;
}

function getBot() { return bot; }

const chatId = () => process.env.TELEGRAM_CHAT_ID;

function isAuthorized(msg) {
  return msg.chat.id.toString() === process.env.TELEGRAM_CHAT_ID;
}

async function send(text, extra = {}) {
  try {
    return await bot.sendMessage(chatId(), text, { parse_mode: 'Markdown', ...extra });
  } catch (e) {
    console.error('Telegram send error:', e.message);
  }
}

async function sendStartup(solBalance, solPrice) {
  const mode = MODES[state.currentMode];
  const modeStr = state.isPaperMode ? '📝 PAPER MODE' : `${mode.emoji} Mode ${state.currentMode} — ${mode.name}`;
  await send(
    `🤖 *Levi Urgent 2.0 is LIVE!*\n\n` +
    `${modeStr}\n` +
    `Bet Size: $${state.betSizeUSD}\n` +
    `Balance: ${solBalance.toFixed(4)} SOL ($${(solBalance * solPrice).toFixed(2)})\n` +
    `Autobet: ${state.autobetActive ? `✅ ${state.autobetSlots} slots` : '❌ Off'}\n\n` +
    `Commands:\n` +
    `/mode1 /mode2 /mode3 /mode4\n` +
    `/autobet [slots] | /stopautobet\n` +
    `/paper | /real\n` +
    `/pause | /resume | /closeall\n` +
    `/portfolio | /report | /status\n` +
    `/betsize [amount] | /settp | /setstoploss`
  );
}

async function sendCoinAlert(coin, modeConfig, isAutobet = false) {
  const scoreEmoji = coin.score >= 8 ? '🔥' : coin.score >= 6 ? '✅' : coin.score >= 4 ? '⚠️' : '❌';
  const manualCount = Object.keys(state.manualPositions).length;
  const autoCount = Object.keys(state.autoPositions).length;

  const tps = modeConfig.takeProfits;
  const message =
    `${scoreEmoji} *New Coin Alert${isAutobet ? ' 🤖 AUTO' : ''}*\n\n` +
    `*$${coin.symbol}* — ${coin.name}\n` +
    `Score: *${coin.score}/10*\n\n` +
    `💧 Liquidity: $${Math.round(coin.liquidityUSD).toLocaleString()}\n` +
    `📈 1h Change: ${coin.priceChangeH1 >= 0 ? '+' : ''}${coin.priceChangeH1.toFixed(1)}%\n` +
    `🔄 Txns/hr: ${coin.txnsH1} (${coin.buysH1}B/${coin.sellsH1}S)\n` +
    `⏱️ Age: ${Math.round(coin.ageMinutes)} mins\n` +
    `🔒 Mint Auth: ${coin.authorities?.hasMintAuthority ? '⚠️ Yes' : '✅ No'}\n` +
    `🍯 Honeypot: ${coin.honeypot?.isHoneypot ? '🚫 YES' : '✅ No'}\n\n` +
    (coin.positives?.length > 0 ? `${coin.positives.join('\n')}\n\n` : '') +
    (coin.flags?.length > 0 ? `${coin.flags.join('\n')}\n\n` : '') +
    `💰 Bet: $${state.betSizeUSD}\n` +
    `🎯 TP1: ${tps[0].multiplier}x → ${tps[0].sellPercent}% | TP2: ${tps[1].multiplier}x → ${tps[1].sellPercent}%\n` +
    `🛑 SL: -${modeConfig.stopLossPercent}%\n\n` +
    `Positions: ${manualCount} manual | ${autoCount} auto\n` +
    `⏳ Auto-skip in 10 mins\n\n` +
    `[DexScreener](${coin.url})`;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ APPROVE', callback_data: `approve_${coin.mintAddress}` },
      { text: '❌ SKIP', callback_data: `skip_${coin.mintAddress}` },
    ]]
  };

  const sent = await bot.sendMessage(chatId(), message, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
    disable_web_page_preview: true,
  });

  return sent?.message_id;
}

async function removeButtons(messageId) {
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId(),
      message_id: messageId,
    });
  } catch {}
}

module.exports = { initBot, getBot, send, sendStartup, sendCoinAlert, removeButtons, isAuthorized };
