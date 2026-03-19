// Levi Urgent 2.0 - Execution Layer (PumpPortal + Raydium fallback)
const { Connection, PublicKey, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');
const { getSOLPrice } = require('./data');
const { withRetry, sleep } = require('./http');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Multiple RPC endpoints with failover
const RPC_ENDPOINTS = [
  process.env.SOLANA_RPC_URL,
  'https://api.mainnet-beta.solana.com',
].filter(Boolean);

let currentRpcIndex = 0;

function getConnection() {
  return new Connection(RPC_ENDPOINTS[currentRpcIndex], 'confirmed');
}

function rotateRpc() {
  currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length;
  console.log(`🔄 Switching RPC to: ${RPC_ENDPOINTS[currentRpcIndex].slice(0, 40)}...`);
  return getConnection();
}

function initWallet() {
  if (!process.env.WALLET_PRIVATE_KEY) throw new Error('WALLET_PRIVATE_KEY not set');
  const decoded = bs58.decode(process.env.WALLET_PRIVATE_KEY);
  return Keypair.fromSecretKey(new Uint8Array(decoded));
}

async function getSOLBalance(publicKey) {
  return withRetry(async () => {
    try {
      const balance = await getConnection().getBalance(new PublicKey(publicKey));
      return balance / 1e9;
    } catch {
      const balance = await rotateRpc().getBalance(new PublicKey(publicKey));
      return balance / 1e9;
    }
  });
}

// Execute trade via PumpPortal local API
async function executePumpPortalTrade(action, mintAddress, amountSOL, wallet) {
  return withRetry(async () => {
    console.log(`📡 PumpPortal: ${action} ${mintAddress.slice(0, 8)}... ${amountSOL} SOL`);

    const response = await axios.post(
      'https://pumpportal.fun/api/trade-local',
      {
        publicKey: wallet.publicKey.toString(),
        action,
        mint: mintAddress,
        denominatedInSol: 'true',
        amount: amountSOL,
        slippage: 15,
        priorityFee: 0.0005,
        pool: 'auto',
      },
      {
        headers: { 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 15000,
      }
    );

    if (response.status !== 200) {
      throw new Error(`PumpPortal error: ${response.status}`);
    }

    // Deserialize and sign transaction
    const txBuffer = Buffer.from(response.data);

    let transaction;
    try {
      transaction = VersionedTransaction.deserialize(txBuffer);
      transaction.sign([wallet]);
    } catch {
      transaction = Transaction.from(txBuffer);
      transaction.sign(wallet);
    }

    // Send transaction
    const connection = getConnection();
    const txid = await connection.sendRawTransaction(
      transaction instanceof VersionedTransaction ? transaction.serialize() : transaction.serialize(),
      { skipPreflight: true, maxRetries: 3 }
    );

    console.log(`⏳ Waiting for confirmation: ${txid}`);
    const confirmation = await connection.confirmTransaction(txid, 'confirmed');

    if (confirmation.value?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    console.log(`✅ Transaction confirmed: ${txid}`);
    return { success: true, txid };

  }, 3, 2000);
}

// Execute sell via PumpPortal using percentage
async function executePumpPortalSell(mintAddress, percentToSell, wallet) {
  return withRetry(async () => {
    console.log(`📡 PumpPortal SELL: ${percentToSell}% of ${mintAddress.slice(0, 8)}...`);

    const response = await axios.post(
      'https://pumpportal.fun/api/trade-local',
      {
        publicKey: wallet.publicKey.toString(),
        action: 'sell',
        mint: mintAddress,
        denominatedInSol: 'false',
        amount: `${percentToSell}%`,
        slippage: 15,
        priorityFee: 0.0005,
        pool: 'auto',
      },
      {
        headers: { 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 15000,
      }
    );

    if (response.status !== 200) {
      throw new Error(`PumpPortal sell error: ${response.status}`);
    }

    const txBuffer = Buffer.from(response.data);

    let transaction;
    try {
      transaction = VersionedTransaction.deserialize(txBuffer);
      transaction.sign([wallet]);
    } catch {
      transaction = Transaction.from(txBuffer);
      transaction.sign(wallet);
    }

    const connection = getConnection();
    const txid = await connection.sendRawTransaction(
      transaction instanceof VersionedTransaction ? transaction.serialize() : transaction.serialize(),
      { skipPreflight: true, maxRetries: 3 }
    );

    const confirmation = await connection.confirmTransaction(txid, 'confirmed');
    if (confirmation.value?.err) throw new Error(`Sell failed: ${JSON.stringify(confirmation.value.err)}`);

    console.log(`✅ Sell confirmed: ${txid}`);
    return { success: true, txid };

  }, 3, 2000);
}

async function buyToken(mintAddress, amountUSD, wallet) {
  try {
    const solPrice = await getSOLPrice();
    const solAmount = parseFloat((amountUSD / solPrice).toFixed(6));

    console.log(`💱 BUY $${mintAddress.slice(0, 8)}... | $${amountUSD} | ${solAmount} SOL`);

    const result = await executePumpPortalTrade('buy', mintAddress, solAmount, wallet);

    return {
      success: true,
      txid: result.txid,
      tokensReceived: 0, // PumpPortal doesn't return token amount directly
      solSpent: solAmount,
      usdSpent: amountUSD,
    };
  } catch (e) {
    console.error(`Buy failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function sellToken(mintAddress, percentToSell, tokensHeld, wallet) {
  try {
    console.log(`💱 SELL ${percentToSell}% of $${mintAddress.slice(0, 8)}...`);

    const result = await executePumpPortalSell(mintAddress, percentToSell, wallet);

    // Estimate USD received from SOL balance change
    const solPrice = await getSOLPrice();

    return {
      success: true,
      txid: result.txid,
      tokensSold: tokensHeld * (percentToSell / 100),
      solReceived: 0,
      usdReceived: 0, // Will be updated by monitor from balance check
    };
  } catch (e) {
    console.error(`Sell failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function getTokenPrice(mintAddress) {
  try {
    const axios2 = require('axios');
    const response = await axios2.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
      { timeout: 5000 }
    );
    const pairs = response.data?.pairs?.filter(p => p.chainId === 'solana');
    if (!pairs || pairs.length === 0) return null;
    const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return parseFloat(best.priceUsd) || null;
  } catch {
    return null;
  }
}

module.exports = { initWallet, getSOLBalance, buyToken, sellToken, getTokenPrice, getConnection, getSOLPrice };