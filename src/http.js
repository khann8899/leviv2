// Levi Urgent 2.0 - HTTP Client with Retry & Backoff
const axios = require('axios');

// Request queue to prevent rate limiting
const requestQueue = [];
let isProcessing = false;
const MIN_REQUEST_INTERVAL = 200; // 200ms between requests

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const { resolve, reject, fn } = requestQueue.shift();
    try {
      const result = await fn();
      resolve(result);
    } catch (e) {
      reject(e);
    }
    await sleep(MIN_REQUEST_INTERVAL);
  }

  isProcessing = false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function queueRequest(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ resolve, reject, fn });
    processQueue();
  });
}

// Exponential backoff retry
async function withRetry(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, i);
        console.log(`⚠️ Request failed (attempt ${i + 1}/${maxRetries}), retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

// GET request with retry and queue
async function get(url, options = {}) {
  return queueRequest(() => withRetry(async () => {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      ...options,
    });
    return response.data;
  }));
}

// POST request with retry and queue
async function post(url, data, options = {}) {
  return queueRequest(() => withRetry(async () => {
    const response = await axios.post(url, data, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    return response.data;
  }));
}

module.exports = { get, post, sleep, withRetry };
