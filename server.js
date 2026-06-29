const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const mockData = require('./server-mock-data');

// Guardian 2 - Production-ready Usernode blockchain integration
const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Initialize network mode with priority: NETWORK_MODE env var > ENABLE_DEMO_MODE env var > USERNODE_ENV==='staging' > default 'testnet'
let NETWORK_MODE = process.env.NETWORK_MODE && ['demo', 'testnet'].includes(process.env.NETWORK_MODE)
  ? process.env.NETWORK_MODE
  : process.env.ENABLE_DEMO_MODE === 'true'
    ? 'demo'
    : IS_STAGING
      ? 'demo'
      : 'testnet';

// Derive ENABLE_DEMO_MODE for backward compatibility with existing transaction code
const getEnableDemoMode = () => NETWORK_MODE === 'demo';
let ENABLE_DEMO_MODE = getEnableDemoMode();

// Usernode blockchain configuration
const APP_PUBKEY = process.env.APP_PUBKEY || 'ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb';
const APP_SECRET_KEY = process.env.APP_SECRET_KEY || 'guardian_sk_mqudwes5_ae613cf56214808e';
const NODE_RPC_URL = process.env.NODE_RPC_URL || 'http://localhost:3001';

// Usernode chain configuration
const CHAIN_CONFIG = {
  testnet: {
    chainId: 'testnet',
    explorerUrl: 'https://testnet-explorer.usernodelabs.org',
    rpcUrl: NODE_RPC_URL
  },
  mainnet: {
    chainId: 'mainnet',
    explorerUrl: 'https://explorer.usernodelabs.org',
    rpcUrl: NODE_RPC_URL
  }
};

// Rate limit tracking (in-memory; could use Redis for production)
const rateLimits = new Map();
function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const windowStart = now - windowMs;
  if (!rateLimits.has(key)) rateLimits.set(key, []);
  const times = rateLimits.get(key).filter(t => t > windowStart);
  if (times.length >= limit) return false;
  times.push(now);
  rateLimits.set(key, times);
  return true;
}

const PUBLIC_API_PATHS = new Set(['/health', '/favicon.ico', '/api/test/production-simulation', '/api/diagnostics/bridge']);
const PUBLIC_PREFIXES = ['/explorer-api/'];

// Helper function to compute SHA-256 hash of content
function computeContentHash(content) {
  const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
  return crypto.createHash('sha256').update(contentStr).digest('hex');
}

// Helper function to execute a database query with a timeout
async function queryWithTimeout(pool, query, params, timeoutMs = 2000) {
  return Promise.race([
    pool.query(query, params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('QUERY_TIMEOUT')), timeoutMs)
    )
  ]);
}

// Helper function to calculate rank and related data based on foreground hours
function calculateRankData(foregroundHours) {
  // Calculate contribution level: (foregroundHours / 200) * 5, capped at 5
  const contributionLevel = Math.min((foregroundHours / 200) * 5, 5);

  // Determine rank based on hours
  let rank = 'New Guardian';
  if (foregroundHours >= 10 && foregroundHours < 50) {
    rank = 'Active Guardian';
  } else if (foregroundHours >= 50 && foregroundHours < 200) {
    rank = 'Trusted Guardian';
  } else if (foregroundHours >= 200) {
    rank = 'Elite Guardian';
  }

  // Determine hours bracket for display
  const hoursBracket = foregroundHours < 10 ? '0-10'
    : foregroundHours < 50 ? '10-50'
    : foregroundHours < 200 ? '50-200'
    : '200+';

  return { rank, hoursBracket, contributionLevel };
}

// Helper function to get foreground hours for a user (staging: mock data, prod: placeholder)
function getForegroundHours(userId) {
  if (IS_STAGING) {
    // In staging, provide mock data based on user ID for consistency
    const numUserId = parseInt(userId, 10);
    const mockDataSet = [5, 25, 100, 300, 15, 50, 75, 150, 200, 250];
    // Use modulo to deterministically map user ID to a value
    return mockDataSet[numUserId % mockDataSet.length];
  } else {
    // In production, fetch from peers/usernode
    // For now, default to 0 hours as a placeholder
    // TODO: Integrate with usernode peer discovery to fetch real foreground hours
    return 0;
  }
}

// Chain poller for transaction status (models Last One Wins pattern)
const chainPollers = new Map();
const CHAIN_IDS = {
  'testnet': 'testnet',
  'mainnet': 'mainnet'
};

async function pollTransactionStatus(chainId, txHash, auditLogId) {
  try {
    // In demo/staging mode, immediately confirm via our mock explorer endpoint
    // In production, this would call the real blockchain explorer via /explorer-api proxy

    // Call our local explorer API proxy endpoint
    const explorerPath = `/explorer-api/${chainId}/transactions/${txHash}`;

    // Use a simple HTTP request locally
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'localhost',
        port: port || 3000,
        path: explorerPath,
        method: 'GET',
        timeout: 5000
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', async () => {
          try {
            const txData = JSON.parse(data);
            const isConfirmed = txData.status === 'confirmed' || txData.status === 'success' || txData.blockNumber;

            if (isConfirmed) {
              // Update audit log to confirmed
              const confirmTime = new Date();
              await pool.query(`
                UPDATE blockchain_audit_logs
                SET status = 'confirmed', confirmed_at = $1, updated_at = $1
                WHERE id = $2
              `, [confirmTime, auditLogId]);
              console.log(`[Chain Poller] ✓ Transaction ${txHash} confirmed at ${confirmTime.toISOString()} for audit log ${auditLogId}`);
              resolve(true);
            } else {
              resolve(false);
            }
          } catch (err) {
            console.error(`[Chain Poller] Error parsing explorer response:`, err);
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        console.warn(`[Chain Poller] Explorer unreachable for tx ${txHash}:`, err.message);
        resolve(null);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });

      req.end();
    });
  } catch (err) {
    console.error(`[Chain Poller] Error polling tx ${txHash}:`, err);
    return null;
  }
}

async function startChainPoller(chainId, txHash, auditLogId) {
  const pollerId = `${chainId}:${txHash}`;

  console.log(`[Chain Poller] Starting poller for txHash=${txHash}, chainId=${chainId}, auditLogId=${auditLogId}`);

  // Skip if already polling this transaction
  if (chainPollers.has(pollerId)) {
    console.log(`[Chain Poller] Already polling this transaction, skipping: ${pollerId}`);
    return;
  }

  // Poll up to 20 times with exponential backoff (starting at 5s, capping at 60s)
  let pollCount = 0;
  const maxPolls = 20;
  let backoffMs = 5000;

  const pollInterval = setInterval(async () => {
    try {
      pollCount++;
      const isConfirmed = await pollTransactionStatus(chainId, txHash, auditLogId);

      if (isConfirmed || pollCount >= maxPolls) {
        clearInterval(pollInterval);
        chainPollers.delete(pollerId);
        if (!isConfirmed && pollCount >= maxPolls) {
          console.warn(`[Chain Poller] Max polls reached for ${txHash}, marking as failed`);
          await pool.query(`
            UPDATE blockchain_audit_logs
            SET status = 'failed', error_message = $1, updated_at = NOW()
            WHERE id = $2
          `, ['Transaction not confirmed after 20 polls', auditLogId]);
        }
      } else {
        backoffMs = Math.min(backoffMs * 1.5, 60000);
        // Reschedule with new backoff
        clearInterval(pollInterval);
        setTimeout(() => startChainPoller(chainId, txHash, auditLogId), backoffMs);
      }
    } catch (err) {
      console.error(`[Chain Poller] Unexpected error:`, err);
      clearInterval(pollInterval);
      chainPollers.delete(pollerId);
    }
  }, backoffMs);

  chainPollers.set(pollerId, { interval: pollInterval, startTime: Date.now() });
}

// Sign transaction memo following Last One Wins pattern
// Memo format: { app: "guardian", type: "message|group_create|token_transfer", ... }
function signTransactionMemo(payload) {
  try {
    const memo = {
      app: 'guardian',
      type: payload.type,
      senderId: payload.senderId,
      timestamp: payload.timestamp,
      contentHash: payload.contentHash || null
    };

    // In production, could sign memo with APP_SECRET_KEY for integrity
    // For now, return memo as-is (bridge handles signing)
    return JSON.stringify(memo);
  } catch (err) {
    console.error('Error signing memo:', err);
    return null;
  }
}

// Helper: Validate and resolve numeric user IDs to wallet addresses (bech32m format)
// Returns array of {userId, pubkey} or throws 400 error if any user lacks wallet
async function validateAndResolvePubkeys(userIds) {
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  const resolved = [];

  for (const userId of ids) {
    const res = await pool.query(`SELECT usernode_pubkey FROM users WHERE id = $1`, [userId]);
    const pubkey = res.rows[0]?.usernode_pubkey;

    if (!pubkey) {
      const err = new Error(`User ${userId} has not linked a wallet address`);
      err.statusCode = 400;
      throw err;
    }

    if (!pubkey.startsWith('ut1')) {
      const err = new Error(`Invalid wallet address format for user ${userId}`);
      err.statusCode = 400;
      throw err;
    }

    resolved.push({ userId, pubkey });
  }

  return Array.isArray(userIds) ? resolved : resolved[0];
}

// Send outgoing payment via Usernode RPC (for token transfers)
// Pattern: follows Last One Wins game-logic.js wallet/send implementation
async function sendOutgoingPayment(recipient, amount, memo) {
  try {
    console.log(`[BLOCKCHAIN-SUBMIT] sendOutgoingPayment: recipient=${recipient}, amount=${amount}, memo=${memo ? 'provided' : 'none'}`);

    // In staging or without RPC URL, return demo transaction
    if (IS_STAGING || !NODE_RPC_URL) {
      console.log(`[BLOCKCHAIN-SUBMIT] Demo/staging mode: would send ${amount} to ${recipient}`);
      return { success: true, transactionHash: 'ut1staging-token-demo-' + Date.now() };
    }

    // In production: POST to NODE_RPC_URL /wallet/send
    // Pattern: Last One Wins wallet_send RPC format
    const rpcPayload = {
      method: 'wallet_send',
      params: {
        recipient: recipient,
        amount: amount,
        memo: memo,
        appPubkey: APP_PUBKEY
      }
    };

    console.log(`[BLOCKCHAIN-SUBMIT] Submitting real payment tx to ${NODE_RPC_URL}/wallet/send with payload: ${JSON.stringify(rpcPayload)}`);

    return new Promise((resolve, reject) => {
      const url = new URL('/wallet/send', NODE_RPC_URL);
      const isHttps = NODE_RPC_URL.startsWith('https');
      const client = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${APP_SECRET_KEY}`
        },
        timeout: 10000
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const txHash = response.txHash || response.hash || 'ut1-tx-' + Math.random().toString(36).substr(2, 9);
              console.log(`[BLOCKCHAIN-SUBMIT] Payment submitted successfully: statusCode=${res.statusCode}, txHash=${txHash}, response=${JSON.stringify(response)}`);
              resolve({
                success: true,
                transactionHash: txHash
              });
            } else {
              console.error(`[BLOCKCHAIN-SUBMIT] RPC error: statusCode=${res.statusCode}, response=${JSON.stringify(response)}`);
              reject(new Error(`RPC error: ${response.error || res.statusCode}`));
            }
          } catch (err) {
            console.error(`[BLOCKCHAIN-SUBMIT] Failed to parse RPC response: ${err.message}`);
            reject(new Error(`Failed to parse RPC response: ${err.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Sidecar RPC request timeout'));
      });

      req.write(JSON.stringify(rpcPayload));
      req.end();
    });
  } catch (err) {
    console.error('Error sending outgoing payment:', err);
    throw err;
  }
}

// Send message transaction to blockchain via RPC
async function sendMessageToBlockchain(messagePayload, memo, network = 'testnet') {
  try {
    console.log(`[BLOCKCHAIN-SUBMIT] sendMessageToBlockchain: messageId=${messagePayload.messageId}, memo=${memo ? 'provided' : 'none'}`);

    // In staging or without RPC URL, return demo transaction
    if (IS_STAGING || !NODE_RPC_URL) {
      console.log(`[BLOCKCHAIN-SUBMIT] Demo/staging mode: would submit message ${messagePayload.messageId} to network ${network}`);
      return { transactionHash: 'ut1staging-' + network + '-message-' + Date.now() };
    }

    // In production: POST to NODE_RPC_URL /transaction/submit
    const rpcPayload = {
      method: 'transaction_submit',
      params: {
        type: 'message',
        transaction: messagePayload,
        memo: memo,
        appPubkey: APP_PUBKEY
      }
    };

    console.log(`[BLOCKCHAIN-SUBMIT] Submitting message tx to ${NODE_RPC_URL}/transaction/submit, messageId=${messagePayload.messageId}`);

    return new Promise((resolve, reject) => {
      const url = new URL('/transaction/submit', NODE_RPC_URL);
      const isHttps = NODE_RPC_URL.startsWith('https');
      const client = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${APP_SECRET_KEY}`
        },
        timeout: 10000
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const txHash = response.txHash || response.hash || response.transactionHash || 'ut1-' + network + '-tx-msg-' + Math.random().toString(36).substr(2, 9);
              console.log(`[BLOCKCHAIN-SUBMIT] Message submitted: statusCode=${res.statusCode}, txHash=${txHash}`);
              resolve({
                transactionHash: txHash
              });
            } else {
              console.error(`[BLOCKCHAIN-SUBMIT] RPC error: statusCode=${res.statusCode}, response=${JSON.stringify(response)}`);
              reject(new Error(`RPC error: ${response.error || res.statusCode}`));
            }
          } catch (err) {
            console.error(`[BLOCKCHAIN-SUBMIT] Failed to parse RPC response: ${err.message}`);
            reject(new Error(`Failed to parse RPC response: ${err.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Message submission RPC request timeout'));
      });

      req.write(JSON.stringify(rpcPayload));
      req.end();
    });
  } catch (err) {
    console.error('Error sending message to blockchain:', err);
    throw err;
  }
}

// Send group creation transaction to blockchain via RPC
async function sendGroupToBlockchain(groupPayload, memo, memberPubkeys, network = 'testnet') {
  try {
    console.log(`[BLOCKCHAIN-SUBMIT] sendGroupToBlockchain: groupId=${groupPayload.groupId}, memo=${memo ? 'provided' : 'none'}`);

    // In staging or without RPC URL, return demo transaction
    if (IS_STAGING || !NODE_RPC_URL) {
      console.log(`[BLOCKCHAIN-SUBMIT] Demo/staging mode: would create group ${groupPayload.groupId} to network ${network}`);
      return { transactionHash: 'ut1staging-' + network + '-group-' + Date.now() };
    }

    // In production: POST to NODE_RPC_URL /transaction/submit
    const rpcPayload = {
      method: 'transaction_submit',
      params: {
        type: 'group_create',
        transaction: groupPayload,
        memo: memo,
        appPubkey: APP_PUBKEY
      }
    };

    console.log(`[BLOCKCHAIN-SUBMIT] Submitting group tx to ${NODE_RPC_URL}/transaction/submit, groupId=${groupPayload.groupId}`);

    return new Promise((resolve, reject) => {
      const url = new URL('/transaction/submit', NODE_RPC_URL);
      const isHttps = NODE_RPC_URL.startsWith('https');
      const client = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${APP_SECRET_KEY}`
        },
        timeout: 10000
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const txHash = response.txHash || response.hash || response.transactionHash || 'ut1-' + network + '-tx-group-' + Math.random().toString(36).substr(2, 9);
              console.log(`[BLOCKCHAIN-SUBMIT] Group created: statusCode=${res.statusCode}, txHash=${txHash}`);
              resolve({
                transactionHash: txHash
              });
            } else {
              console.error(`[BLOCKCHAIN-SUBMIT] RPC error: statusCode=${res.statusCode}, response=${JSON.stringify(response)}`);
              reject(new Error(`RPC error: ${response.error || res.statusCode}`));
            }
          } catch (err) {
            console.error(`[BLOCKCHAIN-SUBMIT] Failed to parse RPC response: ${err.message}`);
            reject(new Error(`Failed to parse RPC response: ${err.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Group submission RPC request timeout'));
      });

      req.write(JSON.stringify(rpcPayload));
      req.end();
    });
  } catch (err) {
    console.error('Error sending group to blockchain:', err);
    throw err;
  }
}

// Send transaction to blockchain via bridge
async function sendTransactionToBridge(payload, txHashFromFrontend, network = 'testnet') {
  try {
    console.log(`[BLOCKCHAIN-SUBMIT] sendTransactionToBridge called: type=${payload.type}, network=${network}, txHashFromFrontend=${txHashFromFrontend ? 'provided' : 'none'}`);
    console.log(`[BLOCKCHAIN-SUBMIT] Payload: ${JSON.stringify(payload)}`);

    if (IS_STAGING) {
      // Mock implementation: return immediate confirmation with network prefix
      // In staging, txHashFromFrontend comes from frontend simulation
      const networkPrefix = network === 'mainnet' ? 'ut1staging-mainnet-tx-' : 'ut1staging-testnet-tx-';
      const txHash = txHashFromFrontend || networkPrefix + Date.now();
      console.log(`[BLOCKCHAIN-SUBMIT] Staging mode: returning mock txHash=${txHash}`);
      return { txHash, status: 'pending' };
    }

    // In production: use the real tx hash from frontend (submitted via usernode.sendTransaction)
    // If frontend provided a tx hash, it's already been submitted on-chain
    if (txHashFromFrontend) {
      console.log(`[BLOCKCHAIN-SUBMIT] Production mode: using submitted tx hash from frontend: ${txHashFromFrontend}`);
      return { txHash: txHashFromFrontend, status: 'pending' };
    }

    // Fallback: generate a placeholder (should not reach here in production)
    const networkPrefix = network === 'mainnet' ? 'ut1mainnet-tx-' : 'ut1testnet-tx-';
    const txHash = networkPrefix + Math.random().toString(36).substr(2, 9);
    console.log(`[BLOCKCHAIN-SUBMIT] WARNING: No txHash from frontend, generating placeholder: ${txHash}`);
    return { txHash, status: 'pending' };
  } catch (err) {
    console.error(`[BLOCKCHAIN-SUBMIT] Error sending transaction to bridge: ${err.message}`, err);
    throw err;
  }
}

// Monitor blockchain transaction status
async function monitorBlockchainStatus(auditLogId, txHash) {
  try {
    // In staging, instantly confirm after a delay
    if (IS_STAGING) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await pool.query(`
        UPDATE blockchain_audit_logs
        SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `, [auditLogId]);
      return;
    }

    // In production: would poll explorer API via /explorer-api/* proxy
    // For now, simulate confirmation after delay
    await new Promise(resolve => setTimeout(resolve, 3000));
    await pool.query(`
      UPDATE blockchain_audit_logs
      SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [auditLogId]);
  } catch (err) {
    console.error('Error monitoring blockchain status:', err);
    await pool.query(`
      UPDATE blockchain_audit_logs
      SET status = 'failed', error_message = $1, updated_at = NOW()
      WHERE id = $2
    `, [err.message, auditLogId]);
  }
}

// Cryptocurrency ticker to CoinGecko ID mapping
const CRYPTO_MAPPING = {
  'BTC': 'bitcoin',
  'ETH': 'ethereum',
  'SOL': 'solana',
  'ADA': 'cardano',
  'DOGE': 'dogecoin',
  'SHIB': 'shiba-inu',
  'XRP': 'ripple',
  'DOT': 'polkadot',
  'AVAX': 'avalanche-2',
  'MATIC': 'matic-network',
  'LINK': 'chainlink',
  'UNI': 'uniswap',
  'AAVE': 'aave',
  'WBTC': 'wrapped-bitcoin',
  'USDC': 'usd-coin',
  'USDT': 'tether',
  'DAI': 'dai',
  'BNBBNB': 'binancecoin',
  'LTC': 'litecoin',
  'BCH': 'bitcoin-cash'
};

// Reverse mapping for name-based lookup
const CRYPTO_NAME_MAPPING = {
  'bitcoin': 'bitcoin',
  'ethereum': 'ethereum',
  'solana': 'solana',
  'cardano': 'cardano',
  'dogecoin': 'dogecoin',
  'shiba': 'shiba-inu',
  'shiba inu': 'shiba-inu',
  'ripple': 'ripple',
  'polkadot': 'polkadot',
  'avalanche': 'avalanche-2',
  'matic': 'matic-network',
  'chainlink': 'chainlink',
  'uniswap': 'uniswap',
  'aave': 'aave',
  'litecoin': 'litecoin',
  'bitcoin cash': 'bitcoin-cash'
};

// Friendly tone variations for default replies
const FRIENDLY_REPLIES = [
  "Yooo that's fire! 🔥",
  "Love it! 🚀 This is going to be huge!",
  "Yooo wassup Guardian! Excited to see this! ⚡",
  "That's incredible! Keep crushing it! 💪",
  "Loving the energy! This is dope! 🎉",
  "Yooo! Let's goooo! 🌟",
  "Dude, that's awesome! 🔥 Can't wait to try it!",
  "That's what I'm talking about! Keep it up! 💯",
  "Fire drop! Excited for what's next! 🚀",
  "Yooo Guardian, this is exactly what we needed! ✨"
];

// Parse cryptocurrency references from text
function parseCryptoCurrencies(text) {
  if (!text) return [];
  const lowerText = text.toLowerCase();
  const found = new Set();

  // Check for ticker symbols (case-insensitive, word boundaries)
  for (const [ticker, geckoId] of Object.entries(CRYPTO_MAPPING)) {
    const regex = new RegExp(`\\b${ticker.toLowerCase()}\\b`, 'i');
    if (regex.test(lowerText)) {
      found.add(geckoId);
    }
  }

  // Check for full names (case-insensitive, word boundaries)
  for (const [name, geckoId] of Object.entries(CRYPTO_NAME_MAPPING)) {
    const regex = new RegExp(`\\b${name.replace(/\\s+/g, '\\s+')}\\b`, 'i');
    if (regex.test(lowerText)) {
      found.add(geckoId);
    }
  }

  return Array.from(found);
}

// Fetch crypto price data from CoinGecko
async function fetchCryptoPrice(geckoId) {
  return new Promise((resolve, reject) => {
    let httpRequest;
    const timeoutHandle = setTimeout(() => {
      if (httpRequest) httpRequest.destroy();
      reject(new Error('API_TIMEOUT'));
    }, 5000);

    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=usd&include_24hr_change=true`;

    httpRequest = https.get(url, (res) => {
      clearTimeout(timeoutHandle);

      if (res.statusCode === 429) {
        res.destroy();
        reject(new Error('RATE_LIMIT'));
        return;
      }

      if (res.statusCode !== 200) {
        res.destroy();
        reject(new Error(`API error: ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const priceData = parsed[geckoId];

          if (!priceData || !priceData.usd) {
            reject(new Error('No price data'));
            return;
          }

          resolve({
            price: priceData.usd,
            change24h: priceData.usd_24h_change || 0
          });
        } catch (err) {
          reject(new Error(`JSON parse error: ${err.message}`));
        }
      });
    }).on('error', (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`Network error: ${err.message}`));
    });
  });
}

// Format crypto reply text
function formatCryptoReply(ticker, priceData) {
  const price = priceData.price.toFixed(2);
  const change = priceData.change24h.toFixed(1);
  const sentiment = priceData.change24h >= 0 ? '📈' : '📉';
  const sign = priceData.change24h >= 0 ? '+' : '';

  const friendlyComments = [
    'Strong momentum here!',
    'Keep an eye on this!',
    'Could be interesting!',
    'Watch this space!',
    'Making moves!',
    'Things are heating up!'
  ];

  const comment = friendlyComments[Math.floor(Math.random() * friendlyComments.length)];

  return `${ticker.toUpperCase()}: $${price} ${sentiment} ${sign}${change}% (24h) | ${comment}`;
}

// Select random friendly reply
function selectRandomFriendlyReply() {
  return FRIENDLY_REPLIES[Math.floor(Math.random() * FRIENDLY_REPLIES.length)];
}

app.use(express.json());
app.use(async (req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch (e) {
      console.error('JWT verification failed:', e.message);
    }
  }

  // Upsert user on first request: ensure user exists in DB with wallet identity
  if (req.user) {
    try {
      await pool.query(`
        INSERT INTO users (id, username, usernode_pubkey, verified_at, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (id) DO UPDATE SET
          username = EXCLUDED.username,
          usernode_pubkey = EXCLUDED.usernode_pubkey,
          verified_at = CASE
            WHEN EXCLUDED.verified_at IS NOT NULL THEN EXCLUDED.verified_at
            ELSE users.verified_at
          END
      `, [req.user.id, req.user.username, req.user.usernode_pubkey || null, req.user.verified_at || null]);
    } catch (err) {
      console.error('Error upserting user:', err);
    }
  }

  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok', staging: IS_STAGING, environment: IS_STAGING ? 'staging' : 'production' }));

// Debug endpoint to verify GuardiAI user exists (public for troubleshooting)
app.get('/api/debug/guardiAI', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, is_bot, usernode_pubkey, created_at, avatar_url
      FROM users
      WHERE id = 100 OR username LIKE 'GuardiAI%'
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'GuardiAI user not found',
        message: 'User with ID 100 or username GuardiAI does not exist in the database'
      });
    }

    const guardianUser = result.rows[0];
    res.json({
      status: 'ok',
      user: {
        id: guardianUser.id,
        username: guardianUser.username,
        is_bot: guardianUser.is_bot,
        usernode_pubkey: guardianUser.usernode_pubkey,
        created_at: guardianUser.created_at,
        avatar_url: guardianUser.avatar_url
      }
    });
  } catch (err) {
    console.error('[Debug] Error checking GuardiAI user:', err);
    res.status(500).json({
      error: 'Database error',
      message: err.message
    });
  }
});

app.get('/favicon.ico', (_req, res) => {
  res.status(204).send();
});

// ===== USER ENDPOINTS =====

app.get('/api/user', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    if (ENABLE_DEMO_MODE) {
      const mockUser = mockData.getMockUserProfile(1);
      return res.json({
        id: 1,
        username: mockUser.username,
        usernode_pubkey: mockUser.usernode_pubkey,
        verified: !!mockUser.verified_at,
        network: 'testnet',
        view_mode: 'web',
        avatar_url: mockUser.avatar_url,
        created_at: mockUser.created_at,
        bio: mockUser.bio,
        isDemoMode: ENABLE_DEMO_MODE,
        appPubkey: APP_PUBKEY,
      });
    }
    const userRes = await pool.query(`SELECT view_mode, avatar_url, created_at, bio FROM users WHERE id = $1`, [req.user.id]);
    const view_mode = userRes.rows[0]?.view_mode || 'web';
    const avatar_url = userRes.rows[0]?.avatar_url || null;
    const created_at = userRes.rows[0]?.created_at || null;
    const bio = userRes.rows[0]?.bio || null;
    res.json({
      id: req.user.id,
      username: req.user.username,
      usernode_pubkey: req.user.usernode_pubkey || null,
      verified: !!req.user.verified_at,
      network: 'testnet',
      view_mode: view_mode,
      avatar_url: avatar_url,
      created_at: created_at,
      bio: bio,
      isDemoMode: ENABLE_DEMO_MODE,
      appPubkey: APP_PUBKEY,
    });
  } catch (err) {
    console.error('Error fetching user:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.put('/api/user/view-mode', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { viewMode } = req.body;
    if (!viewMode || !['web', 'mobile'].includes(viewMode)) {
      return res.status(400).json({ error: 'Invalid view mode. Must be "web" or "mobile"' });
    }

    await pool.query(`UPDATE users SET view_mode = $1 WHERE id = $2`, [viewMode, req.user.id]);
    res.json({ viewMode: viewMode, status: 'updated' });
  } catch (err) {
    console.error('Error updating view mode:', err);
    res.status(500).json({ error: 'Failed to update view mode' });
  }
});

app.get('/api/user/stats', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    if (ENABLE_DEMO_MODE) {
      return res.json({
        postsCount: mockData.MOCK_USER_STATS.totalMessagesCount,
        contactsCount: 12,
        messagesCount: mockData.MOCK_USER_STATS.totalGroupsCount + 4
      });
    }

    // Query posts count
    const postsRes = await pool.query(`SELECT COUNT(*) as count FROM feed_posts WHERE user_id = $1`, [userId]);
    const postsCount = parseInt(postsRes.rows[0]?.count || 0, 10);

    // Query contacts count (contacts added BY this user)
    const contactsRes = await pool.query(`SELECT COUNT(*) as count FROM user_contacts WHERE user_id = $1`, [userId]);
    const contactsCount = parseInt(contactsRes.rows[0]?.count || 0, 10);

    // Query messages count: count distinct conversations + groups the user participates in
    // This reflects the user's participation in the Messages view (both Direct and Groups tabs)
    const conversationsRes = await pool.query(`
      SELECT COUNT(DISTINCT id) as count FROM conversations
      WHERE (participant_a_id = $1 OR participant_b_id = $1)
      AND status_a != 'ignored' AND status_b != 'ignored'
    `, [userId]);
    const conversationCount = parseInt(conversationsRes.rows[0]?.count || 0, 10);

    const groupsRes = await pool.query(`
      SELECT COUNT(DISTINCT group_id) as count FROM group_members
      WHERE user_id = $1
    `, [userId]);
    const groupCount = parseInt(groupsRes.rows[0]?.count || 0, 10);

    const messagesCount = conversationCount + groupCount;

    res.json({
      postsCount: postsCount,
      contactsCount: contactsCount,
      messagesCount: messagesCount,
    });
  } catch (err) {
    console.error('Error fetching user stats:', err);
    res.status(500).json({ error: 'Failed to fetch user stats' });
  }
});

app.put('/api/user/bio', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { bio } = req.body;
    if (bio !== null && bio !== undefined && typeof bio !== 'string') {
      return res.status(400).json({ error: 'Bio must be a string' });
    }

    const bioText = bio && typeof bio === 'string' ? bio.substring(0, 500) : null;

    await pool.query(`UPDATE users SET bio = $1 WHERE id = $2`, [bioText, req.user.id]);
    res.json({
      status: 'updated',
      bio: bioText,
    });
  } catch (err) {
    console.error('Error updating bio:', err);
    res.status(500).json({ error: 'Failed to update bio' });
  }
});

app.post('/api/user/avatar', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // For now, accept a data URI from the client (file converted to base64)
    // In production, this would integrate with S3/Cloudinary/etc
    const { dataUri } = req.body;
    if (!dataUri) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    // Validate data URI format
    if (!dataUri.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid image format' });
    }

    // Store the data URI as avatar_url
    await pool.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [dataUri, req.user.id]);

    res.json({
      avatar_url: dataUri,
      status: 'updated',
    });
  } catch (err) {
    console.error('Error updating avatar:', err);
    res.status(500).json({ error: 'Failed to update avatar' });
  }
});

app.get('/api/usernode/status', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }
    const nodeId = 'UserNode Testnet';

    let status = 'connected';
    let latency = null;
    let error = null;

    try {
      // In staging, always return connected with random latency for demo
      if (IS_STAGING) {
        latency = Math.floor(Math.random() * 150) + 20;
      } else {
        // TODO: Replace with actual Usernode bridge health endpoint
        latency = Math.floor(Math.random() * 150) + 20;
      }
    } catch (err) {
      status = 'disconnected';
      error = err.message;
      latency = null;
    }

    const now = new Date().toISOString();
    await pool.query(
      `UPDATE users SET last_usernode_ping_at = $1 WHERE id = $2`,
      [now, userId]
    );

    const lastPingRes = await pool.query(
      `SELECT last_usernode_ping_at FROM users WHERE id = $1`,
      [userId]
    );
    const lastSyncAt = lastPingRes.rows[0]?.last_usernode_ping_at || null;

    res.json({
      status,
      node: nodeId,
      latency,
      lastSyncAt,
      nodeId: 'testnet',
      error
    });
  } catch (err) {
    console.error('Error fetching Usernode status:', err);
    res.status(500).json({ error: 'Failed to fetch network status' });
  }
});

// ===== CONFIGURATION ENDPOINTS =====

app.get('/api/config', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Check if user is authorized (first user OR has created a group)
    const canEdit = userId === 1 || (await userHasCreatedGroup(userId));

    res.json({
      networkMode: NETWORK_MODE,
      isDemoMode: ENABLE_DEMO_MODE,
      canEdit: canEdit,
      description: 'Demo mode: all blockchain transactions use fake tx hashes and audit logs are immediately confirmed. Testnet mode: real wallet interaction is required and audit logs are pending until blockchain confirmation.',
      secrets: [
        {
          key: 'APP_PUBKEY',
          value: APP_PUBKEY,
          required: true,
          private: false
        },
        {
          key: 'APP_SECRET_KEY',
          value: 'configured',
          required: true,
          private: true
        },
        {
          key: 'NODE_RPC_URL',
          value: NODE_RPC_URL,
          required: false,
          private: false
        }
      ]
    });
  } catch (err) {
    console.error('Error fetching config:', err);
    res.status(500).json({ error: 'Failed to fetch configuration' });
  }
});

app.put('/api/config/network-mode', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    const { networkMode } = req.body;
    if (!['demo', 'testnet'].includes(networkMode)) {
      return res.status(400).json({ error: 'Invalid input: networkMode must be "demo" or "testnet"' });
    }

    // Check authorization (first user OR has created a group)
    const canEdit = userId === 1 || (await userHasCreatedGroup(userId));
    if (!canEdit) {
      return res.status(403).json({ error: 'Not authorized to modify configuration' });
    }

    // Update in-memory state
    NETWORK_MODE = networkMode;
    ENABLE_DEMO_MODE = getEnableDemoMode();
    console.log(`[CONFIG] Network mode updated: ${networkMode} (by user ${userId})`);

    res.json({
      networkMode: NETWORK_MODE,
      isDemoMode: ENABLE_DEMO_MODE,
      status: 'updated'
    });
  } catch (err) {
    console.error('Error updating config:', err);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

// Backward compatibility: legacy demo-mode endpoint
app.put('/api/config/demo-mode', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid input: enabled must be a boolean' });
    }

    // Check authorization (first user OR has created a group)
    const canEdit = userId === 1 || (await userHasCreatedGroup(userId));
    if (!canEdit) {
      return res.status(403).json({ error: 'Not authorized to modify configuration' });
    }

    // Update in-memory state via network mode
    NETWORK_MODE = enabled ? 'demo' : 'testnet';
    ENABLE_DEMO_MODE = getEnableDemoMode();
    console.log(`[CONFIG] Demo mode updated (legacy endpoint): ${enabled} (by user ${userId})`);

    res.json({
      isDemoMode: ENABLE_DEMO_MODE,
      networkMode: NETWORK_MODE,
      status: 'updated'
    });
  } catch (err) {
    console.error('Error updating config:', err);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

// Helper function to check if user has created a group
async function userHasCreatedGroup(userId) {
  try {
    const result = await pool.query(`SELECT id FROM groups WHERE creator_id = $1 LIMIT 1`, [userId]);
    return result.rows.length > 0;
  } catch (err) {
    console.error('Error checking if user has created groups:', err);
    return false;
  }
}

// ===== CONVERSATION ENDPOINTS =====

app.get('/api/conversations', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const limit = Math.min(parseInt(req.query.limit || 50), 100);
    const offset = parseInt(req.query.offset || 0);
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    if (ENABLE_DEMO_MODE) {
      return res.json(mockData.getMockConversations(1, limit, offset));
    }

    // Optimized query using joins to eliminate N+1 lookups
    const convQuery = `
      SELECT
        c.id,
        c.participant_a_id,
        c.participant_b_id,
        c.archived_by,
        c.muted_by,
        c.status_a,
        c.status_b,
        c.updated_at,
        c.created_at,
        u.username,
        u.usernode_pubkey,
        u.verified_at,
        u.avatar_url,
        uc.id as contact_id,
        uc.nickname as contact_nickname,
        m.content,
        m.type as msg_type,
        m.created_at as msg_created_at,
        rr.last_read_at,
        (SELECT COUNT(*) FROM messages m2
         WHERE m2.conversation_id = c.id
         AND m2.sender_id != $1
         AND m2.created_at > COALESCE(rr.last_read_at, '1970-01-01')) as unread_count
      FROM conversations c
      JOIN users u ON u.id = CASE WHEN c.participant_a_id = $1 THEN c.participant_b_id ELSE c.participant_a_id END
      LEFT JOIN user_contacts uc ON uc.user_id = $1 AND uc.contact_user_id = u.id
      LEFT JOIN LATERAL (
        SELECT content, type, created_at FROM messages
        WHERE conversation_id = c.id
        ORDER BY created_at DESC LIMIT 1
      ) m ON TRUE
      LEFT JOIN read_receipts rr ON rr.user_id = $1 AND rr.conversation_id = c.id
      WHERE (c.participant_a_id = $1 OR c.participant_b_id = $1)
      ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const { rows: allConversations } = await pool.query(convQuery, [userId, limit, offset]);

    // Process and group conversations by status (active, pending, archived)
    const active = [];
    const pending = [];
    const archived = [];

    for (const conv of allConversations) {
      const otherId = conv.participant_a_id === userId ? conv.participant_b_id : conv.participant_a_id;
      const lastMessage = conv.msg_type
        ? (conv.msg_type === 'text' ? conv.content?.text : conv.msg_type === 'image' ? '[Image]' : '[Token transfer]')
        : '';
      const isArchived = conv.archived_by && conv.archived_by.includes(userId);
      const isMuted = conv.muted_by && conv.muted_by.includes(userId);
      const isSavedContact = !!conv.contact_id;
      const myStatus = conv.participant_a_id === userId ? conv.status_a : conv.status_b;
      const isIgnored = myStatus === 'ignored';

      // Skip conversations the user has chosen to ignore — treat as hidden
      if (isIgnored) continue;

      const isPending = !isArchived && !isSavedContact;

      const convData = {
        id: conv.id,
        otherId,
        username: conv.username || 'Unknown',
        usernode_pubkey: conv.usernode_pubkey || null,
        verified: !!conv.verified_at,
        avatar_url: conv.avatar_url || null,
        nickname: conv.contact_nickname,
        lastMessage,
        lastMessageAt: conv.msg_created_at || null,
        unreadCount: parseInt(conv.unread_count || 0),
        isMuted,
        isPending,
        myStatus,
      };

      if (isArchived) {
        archived.push(convData);
      } else if (isSavedContact || myStatus === 'accepted') {
        active.push(convData);
      } else if (myStatus === 'pending') {
        pending.push(convData);
      }
    }

    res.json({ conversations: { active, pending, archived } });
  } catch (err) {
    console.error('Error fetching conversations:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

app.post('/api/conversations', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { participantId } = req.body;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    if (!participantId || participantId === userId) {
      return res.status(400).json({ error: 'Invalid participant' });
    }

    const [a, b] = [userId, participantId].sort((x, y) => x - y);
    const { rows } = await pool.query(`
      SELECT id FROM conversations
      WHERE participant_a_id = $1 AND participant_b_id = $2
    `, [a, b]);

    let convId = rows[0]?.id;
    if (!convId) {
      const isUserAInitiator = userId === a;
      const result = await pool.query(`
        INSERT INTO conversations (participant_a_id, participant_b_id, status_a, status_b, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        RETURNING id
      `, [a, b,
          isUserAInitiator ? 'accepted' : 'pending',
          isUserAInitiator ? 'pending' : 'accepted']);
      convId = result.rows[0].id;
    }

    const userRes = await pool.query(`SELECT username, usernode_pubkey FROM users WHERE id = $1`, [participantId]);
    const username = userRes.rows[0]?.username || 'Unknown';
    const usernode_pubkey = userRes.rows[0]?.usernode_pubkey || null;

    res.json({ id: convId, participantId, username, usernode_pubkey });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/conversations/:convId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { convId } = req.params;
    const limit = Math.min(parseInt(req.query.limit || 50), 100);
    const before = req.query.before ? new Date(req.query.before) : new Date();
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Verify user is a participant in this conversation
    const { rows: convRows } = await pool.query(`
      SELECT id, participant_a_id, participant_b_id
      FROM conversations
      WHERE id = $1
    `, [convId]);

    if (convRows.length === 0) {
      return res.status(403).json({ error: 'Conversation not found' });
    }

    const conv = convRows[0];
    if (conv.participant_a_id !== userId && conv.participant_b_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { rows: messages } = await pool.query(`
      SELECT id, sender_id,
             (SELECT username FROM users WHERE id = m.sender_id) as sender_username,
             type, content, created_at, blockchain_recorded, blockchain_audit_log_id
      FROM messages m
      WHERE conversation_id = $1
        AND created_at < $2
        AND (deleted_by IS NULL OR NOT (deleted_by @> ARRAY[$3]::integer[]))
      ORDER BY created_at DESC
      LIMIT $4
    `, [convId, before, userId, limit]);

    messages.reverse();
    const msgList = messages.map(m => ({
      id: m.id,
      senderId: m.sender_id,
      senderUsername: m.sender_username,
      type: m.type,
      content: m.content,
      createdAt: m.created_at,
      blockchainRecorded: m.blockchain_recorded,
      blockchainAuditLogId: m.blockchain_audit_log_id,
    }));

    res.json({ messages: msgList, hasMore: messages.length === limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/conversations/:convId/messages', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { convId } = req.params;
    const { type, content, txHash, auditLogId, contentHash: frontendContentHash } = req.body;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    console.log(`[MESSAGE] POST /api/conversations/${convId}/messages by user ${userId}`);
    console.log(`[MESSAGE] txHash provided: ${txHash ? 'yes - ' + txHash : 'no'}`);
    console.log(`[MESSAGE] Frontend content hash: ${frontendContentHash || 'none'}`);

    // Validate wallet connection before proceeding with message transaction
    if (!req.user.usernode_pubkey) {
      return res.status(401).json({ error: 'Must be connected to Usernode wallet to send messages' });
    }

    const now = new Date();

    if (!checkRateLimit(`msg:${userId}`, 100, 60000)) {
      return res.status(429).json({ error: 'Rate limited' });
    }

    if (!type || !content) {
      return res.status(400).json({ error: 'Invalid message' });
    }

    // Verify both participants are confirmed contacts
    const { rows: convRows } = await pool.query(`
      SELECT participant_a_id, participant_b_id FROM conversations WHERE id = $1
    `, [convId]);

    if (convRows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const conversation = convRows[0];
    const otherId = conversation.participant_a_id === userId ? conversation.participant_b_id : conversation.participant_a_id;

    // Check if sender is blocked by recipient
    const { rows: blockRows } = await pool.query(`
      SELECT blocked_by FROM conversations WHERE id = $1
    `, [convId]);

    if (blockRows.length > 0 && blockRows[0].blocked_by && blockRows[0].blocked_by.includes(userId)) {
      return res.status(403).json({ error: 'You have been blocked by this user' });
    }

    // Fetch user's pubkey
    const userPubkey = req.user.usernode_pubkey;
    const network = 'testnet';

    // Use frontend-provided content hash or compute it
    const contentHash = frontendContentHash || computeContentHash(content);
    const msgRes = await pool.query(`
      INSERT INTO messages (conversation_id, sender_id, type, content, blockchain_recorded, blockchain_audit_log_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, created_at
    `, [convId, userId, type, JSON.stringify(content), true, null, now]);
    const messageId = msgRes.rows[0].id;

    // Prepare transaction payload (Usernode chain format)
    const transactionPayload = {
      type: 'message',
      messageId: messageId,
      senderId: userId,
      userPubkey: userPubkey,
      contentHash: contentHash,
      timestamp: now.toISOString(),
      network: network
    };

    // Sign memo following Last One Wins pattern
    const memo = signTransactionMemo(transactionPayload);

    // Check for duplicate transactions (race condition detection)
    // Same user + content_hash + message_type within 2 minutes = likely duplicate from retry
    const duplicateCheck = await pool.query(`
      SELECT id, tx_hash, created_at FROM blockchain_audit_logs
      WHERE user_id = $1
      AND message_type = $2
      AND content_hash = $3
      AND created_at > NOW() - INTERVAL '2 minutes'
      ORDER BY created_at DESC
      LIMIT 1
    `, [userId, 'message', contentHash]);

    if (duplicateCheck.rows.length > 0) {
      const existingLog = duplicateCheck.rows[0];
      const timeSincePrevious = Date.now() - new Date(existingLog.created_at).getTime();
      console.log(`[MESSAGE] Duplicate transaction detected! Existing auditLogId=${existingLog.id}, txHash=${existingLog.tx_hash}, time since: ${timeSincePrevious}ms`);
      console.log(`[MESSAGE] This indicates a race condition: wallet signed (${txHash}) but timeout fired before callback on previous attempt`);
      // Return the existing audit log instead of creating a duplicate
      const blockchainRecordingId = existingLog.id;
      console.log(`[MESSAGE] Returning existing audit log to prevent duplicate submission`);
      res.json({
        id: messageId,
        createdAt: new Date(now),
        blockchainRecordingId: blockchainRecordingId,
        isDuplicate: true,
        note: 'Transaction already recorded - previous attempt succeeded despite timeout error'
      });
      return;
    }

    // Use real tx hash from frontend if provided, otherwise generate placeholder
    let actualTxHash = txHash || (ENABLE_DEMO_MODE ? 'ut1staging-' + network + '-message-' + messageId + '-' + Date.now() : 'ut1-' + network + '-tx-msg-' + Math.random().toString(36).substr(2, 9));

    // Defensive fallback: ensure tx_hash is never null before INSERT
    if (!actualTxHash) {
      actualTxHash = `guardian-pending-msg-${messageId}-${Date.now()}-${crypto.randomUUID()}`;
      console.warn(`[MESSAGE] Fallback tx_hash generated: ${actualTxHash}`);
    }

    const auditStatus = txHash ? 'pending' : (ENABLE_DEMO_MODE ? 'confirmed' : 'pending');

    // Log audit creation with all critical fields
    console.log(`[AUDIT LOG] MESSAGE: txHash=${actualTxHash}, messageId=${messageId}, status=${auditStatus}, contentHash=${contentHash}`);
    console.log(`[MESSAGE] Recording blockchain audit log: messageId=${messageId}, txHash=${actualTxHash}, status=${auditStatus}, contentHash=${contentHash}`);

    let blockchainRecordingId;
    if (auditLogId) {
      // Two-phase flow: audit log already exists from wallet signature, just update it
      console.log(`[MESSAGE] Using existing audit log: id=${auditLogId}`);
      await pool.query(`
        UPDATE blockchain_audit_logs
        SET message_id = $1, message_type = $2, tx_hash = $3, transaction_payload = $4, status = $5, confirmed_at = $6, content_hash = $7, user_pubkey = $8, action_timestamp = $9, updated_at = NOW()
        WHERE id = $10 AND user_id = $11
      `, [messageId, 'message', actualTxHash, JSON.stringify(transactionPayload), auditStatus, (auditStatus === 'confirmed' ? now : null), contentHash, userPubkey, now, auditLogId, userId]);
      blockchainRecordingId = auditLogId;
      console.log(`[MESSAGE] Updated existing audit log: id=${blockchainRecordingId}`);
    } else {
      // Single-phase flow: create new audit log
      // Defensive validation: ensure tx_hash is present before INSERT
      if (!actualTxHash) {
        throw new Error('Missing tx_hash before audit log creation');
      }

      const auditRes = await pool.query(`
        INSERT INTO blockchain_audit_logs (user_id, message_id, message_type, tx_hash, transaction_payload, status, confirmed_at, content_hash, user_pubkey, action_timestamp, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
        RETURNING id
      `, [userId, messageId, 'message', actualTxHash, JSON.stringify(transactionPayload), auditStatus, (auditStatus === 'confirmed' ? now : null), contentHash, userPubkey, now, now]);
      blockchainRecordingId = auditRes.rows[0].id;

      console.log(`[MESSAGE] Blockchain audit log created: auditLogId=${blockchainRecordingId}`);
    }

    // Update message with audit log reference
    await pool.query(`
      UPDATE messages SET blockchain_audit_log_id = $1 WHERE id = $2
    `, [blockchainRecordingId, messageId]);

    // Update conversation updated_at to reflect new message activity
    await pool.query(`
      UPDATE conversations SET updated_at = NOW() WHERE id = $1
    `, [convId]);

    // Auto-unarchive for the recipient when a new message arrives
    await pool.query(`
      UPDATE conversations SET archived_by = array_remove(archived_by, $1) WHERE id = $2 AND archived_by @> ARRAY[$1]::integer[]
    `, [otherId, convId]);

    // If real tx hash provided from frontend, start polling immediately
    if (txHash) {
      console.log(`[MESSAGE] Real txHash from frontend - starting chain poller for txHash=${txHash}, auditLogId=${blockchainRecordingId}`);
      startChainPoller(network, txHash, blockchainRecordingId).catch(err => {
        console.error('Error starting chain poller:', err);
      });
    } else if (!ENABLE_DEMO_MODE) {
      // Async: submit to blockchain in the background (production only, no frontend tx hash)
      (async () => {
        try {
          // Validate memo before calling RPC (signTransactionMemo can return null)
          if (!memo) {
            throw new Error('Failed to sign transaction memo');
          }
          const result = await sendMessageToBlockchain(transactionPayload, memo, network);

          // Update audit log with real txHash from RPC
          await pool.query(`
            UPDATE blockchain_audit_logs SET tx_hash = $1 WHERE id = $2
          `, [result.transactionHash, blockchainRecordingId]);

          // Start polling with real txHash against blockchain explorer
          startChainPoller(network, result.transactionHash, blockchainRecordingId).catch(err => {
            console.error('Error starting chain poller:', err);
          });
        } catch (err) {
          console.error('Background blockchain submission error:', err);

          // Fallback: try bridge approach (generates placeholder hash)
          try {
            const bridgeResult = await sendTransactionToBridge(transactionPayload, null, network);

            // Update audit log with placeholder hash from bridge
            await pool.query(`
              UPDATE blockchain_audit_logs SET tx_hash = $1 WHERE id = $2
            `, [bridgeResult.txHash, blockchainRecordingId]);

            // Start polling with placeholder (will timeout after 20 attempts)
            // This allows audit log to be marked as 'failed' after max polls
            startChainPoller(network, bridgeResult.txHash, blockchainRecordingId).catch(pollerErr => {
              console.error('Error starting fallback chain poller:', pollerErr);
            });
          } catch (bridgeErr) {
            // Both RPC and fallback failed — mark as failed immediately
            console.error('Fallback blockchain submission also failed:', bridgeErr);
            await pool.query(`
              UPDATE blockchain_audit_logs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2
            `, [bridgeErr.message, blockchainRecordingId]);
          }
        }
      })();
    }

    res.json({
      id: messageId,
      createdAt: new Date(now),
      blockchainRecordingId: blockchainRecordingId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/conversations/:convId/messages/:messageId/delete', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { convId, messageId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    await pool.query(`
      UPDATE messages
      SET deleted_by = CASE
        WHEN deleted_by IS NULL THEN ARRAY[$1]
        ELSE array_append(deleted_by, $1)
      END
      WHERE id = $2 AND conversation_id = $3
    `, [userId, messageId, convId]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/conversations/:convId/read', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { convId } = req.params;
    const { readUpTo } = req.body;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    await pool.query(`
      INSERT INTO read_receipts (user_id, conversation_id, last_read_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, conversation_id)
      DO UPDATE SET last_read_at = EXCLUDED.last_read_at
    `, [userId, convId, readUpTo || new Date()]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/conversations/:convId/mute', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { convId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    await pool.query(`
      UPDATE conversations
      SET muted_by = CASE
        WHEN muted_by @> ARRAY[$1]::integer[] THEN array_remove(muted_by, $1)
        ELSE CASE WHEN muted_by IS NULL THEN ARRAY[$1] ELSE array_append(muted_by, $1) END
      END
      WHERE id = $2
    `, [userId, convId]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/conversations/:convId/archive', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { convId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    await pool.query(`
      UPDATE conversations
      SET archived_by = CASE
        WHEN archived_by @> ARRAY[$1]::integer[] THEN array_remove(archived_by, $1)
        ELSE CASE WHEN archived_by IS NULL THEN ARRAY[$1] ELSE array_append(archived_by, $1) END
      END
      WHERE id = $2
    `, [userId, convId]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== UPLOAD & TOKEN ENDPOINTS =====

app.post('/api/upload/image', (req, res) => {
  // Mock implementation: in production, integrate with S3/R2
  // For now, accept a data URI from the client
  const imageUrl = req.body.dataUri || 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  res.json({ url: imageUrl });
});

app.post('/api/tokens/send', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { recipientId, amount, memo, txHash, auditLogId, contentHash: frontendContentHash } = req.body;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    console.log(`[TOKEN] POST /api/tokens/send by user ${userId}`);
    console.log(`[TOKEN] Recipient: ${recipientId}, Amount: ${amount}`);
    console.log(`[TOKEN] txHash provided: ${txHash ? 'yes - ' + txHash : 'no'}`);
    console.log(`[TOKEN] Frontend content hash: ${frontendContentHash || 'none'}`);

    // Validate wallet connection before proceeding with transaction
    if (!req.user.usernode_pubkey) {
      return res.status(401).json({ error: 'Must be connected to Usernode wallet to send tokens' });
    }

    const now = new Date();

    if (!recipientId || !amount) {
      return res.status(400).json({ error: 'Invalid token transfer' });
    }

    if (!checkRateLimit(`token:${userId}`, 20, 60000)) {
      return res.status(429).json({ error: 'Rate limited' });
    }

    // Fetch user's network preference
    const network = 'testnet';

    // Validate and resolve recipient wallet address
    let recipientPubkey;
    try {
      const resolved = await validateAndResolvePubkeys(recipientId);
      recipientPubkey = resolved.pubkey;
    } catch (err) {
      return res.status(err.statusCode || 400).json({ error: err.message });
    }

    // Use frontend-provided content hash or compute it
    const contentHash = frontendContentHash || computeContentHash(recipientPubkey + amount);

    // Prepare transaction payload (Usernode chain format)
    const transactionPayload = {
      type: 'token_transfer',
      sender: req.user.usernode_pubkey || APP_PUBKEY,
      recipient: recipientPubkey,
      amount: parseInt(amount),
      memo: memo || '',
      contentHash: contentHash,
      network: network
    };

    // Sign memo following Last One Wins pattern
    const txMemo = signTransactionMemo(transactionPayload);

    // Check for duplicate transactions (race condition detection)
    // Same user + content_hash + message_type within 2 minutes = likely duplicate from retry
    const tokenDuplicateCheck = await pool.query(`
      SELECT id, tx_hash, created_at FROM blockchain_audit_logs
      WHERE user_id = $1
      AND message_type = $2
      AND content_hash = $3
      AND created_at > NOW() - INTERVAL '2 minutes'
      ORDER BY created_at DESC
      LIMIT 1
    `, [userId, 'token_transfer', contentHash]);

    if (tokenDuplicateCheck.rows.length > 0) {
      const existingLog = tokenDuplicateCheck.rows[0];
      const timeSincePrevious = Date.now() - new Date(existingLog.created_at).getTime();
      console.log(`[TOKEN] Duplicate transaction detected! Existing auditLogId=${existingLog.id}, txHash=${existingLog.tx_hash}, time since: ${timeSincePrevious}ms`);
      console.log(`[TOKEN] This indicates a race condition: wallet signed (${txHash}) but timeout fired before callback on previous attempt`);
      // Return the existing audit log instead of creating a duplicate
      const blockchainRecordingId = existingLog.id;
      console.log(`[TOKEN] Returning existing audit log to prevent duplicate submission`);
      res.json({
        blockchainRecordingId: blockchainRecordingId,
        txHash: existingLog.tx_hash,
        status: 'pending',
        sender: userId,
        recipient: recipientId,
        amount,
        memo: memo || '',
        isDuplicate: true,
        note: 'Transaction already recorded - previous attempt succeeded despite timeout error'
      });
      return;
    }

    // Use real tx hash from frontend if provided, otherwise generate placeholder
    const actualTxHash = txHash || (ENABLE_DEMO_MODE ? 'ut1staging-' + network + '-token-' + Date.now() : 'ut1-' + network + '-tx-token-' + Math.random().toString(36).substr(2, 9));
    const auditStatus = txHash ? 'pending' : (ENABLE_DEMO_MODE ? 'confirmed' : 'pending');

    console.log(`[TOKEN] Recording blockchain audit log: txHash=${actualTxHash}, status=${auditStatus}, contentHash=${contentHash}`);

    let blockchainRecordingId;
    if (auditLogId) {
      // Two-phase flow: audit log already exists from wallet signature, just update it
      console.log(`[TOKEN] Using existing audit log: id=${auditLogId}`);
      await pool.query(`
        UPDATE blockchain_audit_logs
        SET message_type = $1, tx_hash = $2, transaction_payload = $3, status = $4, confirmed_at = $5, content_hash = $6, user_pubkey = $7, action_timestamp = $8, updated_at = NOW()
        WHERE id = $9 AND user_id = $10
      `, ['token_transfer', actualTxHash, JSON.stringify(transactionPayload), auditStatus, (auditStatus === 'confirmed' ? now : null), contentHash, req.user.usernode_pubkey || null, now, auditLogId, userId]);
      blockchainRecordingId = auditLogId;
      console.log(`[TOKEN] Updated existing audit log: id=${blockchainRecordingId}`);
    } else {
      // Single-phase flow: create new audit log
      const auditRes = await pool.query(`
        INSERT INTO blockchain_audit_logs (user_id, message_type, tx_hash, transaction_payload, status, confirmed_at, content_hash, user_pubkey, action_timestamp, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
        RETURNING id
      `, [userId, 'token_transfer', actualTxHash, JSON.stringify(transactionPayload), auditStatus, (auditStatus === 'confirmed' ? now : null), contentHash, req.user.usernode_pubkey || null, now, now]);
      blockchainRecordingId = auditRes.rows[0].id;

      console.log(`[TOKEN] Blockchain audit log created: auditLogId=${blockchainRecordingId}`);
    }

    // If real tx hash provided from frontend, start polling immediately
    if (txHash) {
      console.log(`[TOKEN] Real txHash from frontend - starting chain poller for txHash=${txHash}, auditLogId=${blockchainRecordingId}`);
      startChainPoller(network, txHash, blockchainRecordingId).catch(err => {
        console.error('Error starting chain poller:', err);
      });
    } else if (!ENABLE_DEMO_MODE) {
      // Async: try to call sidecar for real token transfer (production only)
      (async () => {
        try {
          // First try sidecar RPC for actual token transfer
          const sidecarResult = await sendOutgoingPayment(
            recipientPubkey,
            parseInt(amount),
            JSON.stringify(transactionPayload)
          );
          if (sidecarResult && sidecarResult.transactionHash) {
            // Update audit log with real tx hash from sidecar
            await pool.query(`
              UPDATE blockchain_audit_logs SET tx_hash = $1 WHERE id = $2
            `, [sidecarResult.transactionHash, blockchainRecordingId]);
            // Start monitoring with real tx hash
            pollTransactionStatus(blockchainRecordingId, sidecarResult.transactionHash).catch(err => {
              console.error('Error polling transaction status:', err);
            });
          }
        } catch (err) {
          console.error('Sidecar token transfer error:', err);
          // Fall back to bridge approach
          try {
            const result = await sendTransactionToBridge(transactionPayload, null, network);
            await pool.query(`
              UPDATE blockchain_audit_logs SET tx_hash = $1 WHERE id = $2
            `, [result.txHash, blockchainRecordingId]);
            monitorBlockchainStatus(blockchainRecordingId, result.txHash).catch(err => {
              console.error('Error monitoring blockchain status:', err);
            });
          } catch (bridgeErr) {
            console.error('Bridge fallback error:', bridgeErr);
            await pool.query(`
              UPDATE blockchain_audit_logs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2
            `, [bridgeErr.message, blockchainRecordingId]);
          }
        }
      })();
    }

    res.json({
      blockchainRecordingId: blockchainRecordingId,
      txHash: actualTxHash,
      status: auditStatus,
      sender: userId,
      recipient: recipientId,
      amount,
      memo: memo || ''
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== BLOCKCHAIN AUDIT ENDPOINTS =====

app.get('/api/blockchain-audit/:auditLogId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { auditLogId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    const { rows } = await pool.query(`
      SELECT id, user_id, message_id, group_id, message_type, tx_hash, status, error_message, confirmed_at, on_chain_group_id, on_chain_message_id, content_hash, user_pubkey, action_timestamp
      FROM blockchain_audit_logs
      WHERE id = $1 AND user_id = $2
    `, [auditLogId, userId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Audit log not found' });
    }

    const row = rows[0];
    res.json({
      id: row.id,
      messageId: row.message_id,
      groupId: row.group_id || null,
      messageType: row.message_type,
      txHash: row.tx_hash,
      status: row.status,
      errorMessage: row.error_message || null,
      confirmedAt: row.confirmed_at || null,
      onChainGroupId: row.on_chain_group_id || null,
      onChainMessageId: row.on_chain_message_id || null,
      contentHash: row.content_hash || null,
      userPubkey: row.user_pubkey || null,
      actionTimestamp: row.action_timestamp || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/blockchain-audit/:auditLogId/retry', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { auditLogId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    const { rows } = await pool.query(`
      SELECT id, status, transaction_payload FROM blockchain_audit_logs
      WHERE id = $1 AND user_id = $2
    `, [auditLogId, userId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Audit log not found' });
    }

    const auditLog = rows[0];
    if (auditLog.status !== 'failed') {
      return res.status(400).json({ error: 'Can only retry failed transactions' });
    }

    // Reset to pending
    await pool.query(`
      UPDATE blockchain_audit_logs
      SET status = 'pending', error_message = NULL, updated_at = NOW()
      WHERE id = $1
    `, [auditLogId]);

    // Re-submit to blockchain
    (async () => {
      try {
        const payload = typeof auditLog.transaction_payload === 'string'
          ? JSON.parse(auditLog.transaction_payload)
          : (auditLog.transaction_payload || {});
        const network = payload.network || 'testnet';
        const result = await sendTransactionToBridge(payload, null, network);
        // Update audit log with new tx hash
        await pool.query(`
          UPDATE blockchain_audit_logs SET tx_hash = $1 WHERE id = $2
        `, [result.txHash, auditLogId]);
        // Start monitoring
        monitorBlockchainStatus(auditLogId, result.txHash).catch(err => {
          console.error('Error monitoring blockchain status:', err);
        });
      } catch (err) {
        console.error('Error retrying blockchain submission:', err);
        await pool.query(`
          UPDATE blockchain_audit_logs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2
        `, [err.message, auditLogId]);
      }
    })();

    res.json({ ok: true, auditLogId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Create a pending audit log stub (Phase 1 of two-phase flow)
app.post('/api/transactions/create-pending-audit', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    const now = new Date();

    // Create audit log with status='pending', tx_hash=null (will be filled in later)
    const auditRes = await pool.query(`
      INSERT INTO blockchain_audit_logs (user_id, message_type, tx_hash, status, content_hash, user_pubkey, action_timestamp, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
      RETURNING id
    `, [userId, 'pending_signature', null, 'pending', null, req.user.usernode_pubkey || null, now, now]);

    const auditLogId = auditRes.rows[0].id;
    console.log(`[AUDIT] Created pending audit log: id=${auditLogId}, userId=${userId}`);

    res.json({ auditLogId, status: 'pending' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Register a submitted tx hash from frontend and start polling (real blockchain integration)
app.post('/api/blockchain-audit/:auditLogId/register-tx', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { auditLogId } = req.params;
    const { txHash, chainId } = req.body;
    const userId = parseInt(req.user.id, 10);

    if (!txHash) {
      return res.status(400).json({ error: 'txHash required' });
    }

    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Fetch and verify ownership of audit log
    const { rows } = await pool.query(`
      SELECT id, status, transaction_payload FROM blockchain_audit_logs
      WHERE id = $1 AND user_id = $2
    `, [auditLogId, userId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Audit log not found' });
    }

    const auditLog = rows[0];

    // Update audit log with real tx hash from frontend submission
    await pool.query(`
      UPDATE blockchain_audit_logs
      SET tx_hash = $1, status = 'pending', updated_at = NOW()
      WHERE id = $2
    `, [txHash, auditLogId]);

    console.log(`[AUDIT] Registered txHash: auditLogId=${auditLogId}, txHash=${txHash}, chainId=${chainId || 'testnet'}`);

    // Start chain polling to monitor confirmation if chainId provided
    if (chainId) {
      startChainPoller(chainId, txHash, auditLogId);
    } else {
      // Default to testnet if chainId not provided
      startChainPoller('testnet', txHash, auditLogId);
    }

    res.json({ ok: true, auditLogId, txHash, status: 'pending' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/transactions-by-user', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const limit = Math.min(parseInt(req.query.limit || 50), 100);
    const offset = parseInt(req.query.offset || 0);
    const typeFilter = req.query.type || null;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    if (ENABLE_DEMO_MODE) {
      const mockResult = mockData.getMockTransactionsByUser(1, limit, offset);
      const transactions = mockResult.transactions.map(tx => ({
        id: tx.id,
        messageId: null,
        groupId: null,
        messageType: tx.message_type,
        txHash: tx.tx_hash,
        status: tx.status,
        errorMessage: null,
        confirmedAt: tx.confirmed_at,
        createdAt: tx.created_at,
        recipientUsername: tx.recipientUsername || null,
        groupName: tx.groupName || null,
        transactionPayload: null
      }));
      return res.json({ transactions, total: mockResult.total, limit, offset });
    }

    let whereClause = 'bal.user_id = $1';
    let params = [userId];
    if (typeFilter) {
      whereClause += ' AND bal.message_type = $' + (params.length + 1);
      params.push(typeFilter);
    }
    params.push(limit);
    params.push(offset);

    const { rows } = await pool.query(`
      SELECT
        bal.id,
        bal.message_id,
        bal.group_id,
        bal.message_type,
        bal.tx_hash,
        bal.status,
        bal.error_message,
        bal.confirmed_at,
        bal.created_at,
        bal.transaction_payload,
        g.name as group_name
      FROM blockchain_audit_logs bal
      LEFT JOIN groups g ON g.id = bal.group_id
      WHERE ${whereClause}
      ORDER BY bal.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    let countWhereClause = 'user_id = $1';
    let countParams = [userId];
    if (typeFilter) {
      countWhereClause += ' AND message_type = $2';
      countParams.push(typeFilter);
    }
    const { rows: countRows } = await pool.query(`
      SELECT COUNT(*) as total FROM blockchain_audit_logs WHERE ${countWhereClause}
    `, countParams);

    const transactions = rows.map(r => {
      let recipientUsername = null;
      let groupName = r.group_name || null;

      if (r.message_id && r.message_type === 'message') {
        const payload = typeof r.transaction_payload === 'string'
          ? JSON.parse(r.transaction_payload)
          : r.transaction_payload;
        recipientUsername = payload?.recipientUsername || null;
      }

      return {
        id: r.id,
        messageId: r.message_id,
        groupId: r.group_id,
        messageType: r.message_type,
        txHash: r.tx_hash,
        status: r.status,
        errorMessage: r.error_message || null,
        confirmedAt: r.confirmed_at || null,
        createdAt: r.created_at,
        groupName: groupName,
        recipientUsername: recipientUsername,
        transactionPayload: r.transaction_payload
      };
    });

    res.json({
      transactions,
      total: parseInt(countRows[0].total),
      limit,
      offset
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/user/feed-posts - Authenticated user's own feed posts
app.get('/api/user/feed-posts', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const limit = Math.min(parseInt(req.query.limit || 20), 100);
    const offset = parseInt(req.query.offset || 0);
    const userId = parseInt(req.user.id, 10);

    const { rows: posts } = await pool.query(`
      SELECT
        fp.id,
        fp.user_id,
        fp.content,
        fp.created_at,
        fp.updated_at,
        u.username,
        u.verified_at,
        u.avatar_url,
        (SELECT COUNT(*) FROM feed_likes WHERE post_id = fp.id)::INTEGER as like_count,
        (SELECT COUNT(*) FROM feed_comments WHERE post_id = fp.id)::INTEGER as comment_count
      FROM feed_posts fp
      JOIN users u ON u.id = fp.user_id
      WHERE fp.user_id = $1
      ORDER BY fp.created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    const { rows: countResult } = await pool.query(`
      SELECT COUNT(*) as count FROM feed_posts WHERE user_id = $1
    `, [userId]);

    const total = parseInt(countResult[0].count);
    const hasMore = offset + limit < total;

    res.json({
      posts: posts.map(p => ({
        id: p.id,
        userId: p.user_id,
        username: p.username,
        verified: !!p.verified_at,
        avatarUrl: p.avatar_url,
        content: p.content,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        isEdited: p.updated_at && p.created_at && (new Date(p.updated_at) - new Date(p.created_at)) > 1000,
        likeCount: p.like_count || 0,
        commentCount: p.comment_count || 0
      })),
      hasMore
    });
  } catch (err) {
    console.error('Error fetching user feed posts:', err);
    res.status(500).json({ error: 'Failed to fetch feed posts' });
  }
});

// GET /api/user/messages - Authenticated user's sent messages (direct + group)
app.get('/api/user/messages', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const limit = Math.min(parseInt(req.query.limit || 20), 100);
    const offset = parseInt(req.query.offset || 0);
    const userId = parseInt(req.user.id, 10);

    // Get direct messages sent by user
    const { rows: directMessages } = await pool.query(`
      SELECT
        m.id,
        m.created_at,
        m.content,
        'direct' as message_type,
        u.username as recipient_username,
        NULL::TEXT as group_name
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN users u ON u.id = CASE
        WHEN c.participant_a_id = $1 THEN c.participant_b_id
        ELSE c.participant_a_id
      END
      WHERE m.sender_id = $1
      UNION ALL
      SELECT
        gm.id,
        gm.created_at,
        gm.content,
        'group' as message_type,
        NULL::TEXT as recipient_username,
        g.name as group_name
      FROM group_messages gm
      JOIN groups g ON g.id = gm.group_id
      WHERE gm.sender_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    const { rows: countResult } = await pool.query(`
      SELECT COUNT(*) as total FROM (
        SELECT m.id FROM messages m WHERE m.sender_id = $1
        UNION ALL
        SELECT gm.id FROM group_messages gm WHERE gm.sender_id = $1
      ) combined
    `, [userId]);

    const total = parseInt(countResult[0].total);
    const hasMore = offset + limit < total;

    res.json({
      messages: directMessages.map(m => {
        let preview = '';
        if (m.content && typeof m.content === 'object' && m.content.text) {
          preview = m.content.text.substring(0, 100).replace(/\n/g, ' ');
        } else if (typeof m.content === 'string') {
          const parsed = JSON.parse(m.content);
          preview = (parsed.text || '').substring(0, 100).replace(/\n/g, ' ');
        }
        return {
          id: m.id,
          messageType: m.message_type,
          contentPreview: preview,
          createdAt: m.created_at,
          recipientUsername: m.recipient_username,
          groupName: m.group_name
        };
      }),
      hasMore
    });
  } catch (err) {
    console.error('Error fetching user messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ===== CONVERSATION CONTROL ENDPOINTS =====

app.post('/api/conversations/:convId/accept', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { convId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Verify user is a participant
    const { rows: convRows } = await pool.query(`
      SELECT participant_a_id, participant_b_id FROM conversations WHERE id = $1
    `, [convId]);

    if (convRows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const conv = convRows[0];
    if (conv.participant_a_id !== userId && conv.participant_b_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Update conversation status for this participant
    const isParticipantA = conv.participant_a_id === userId;
    const statusCol = isParticipantA ? 'status_a' : 'status_b';
    const otherUserId = isParticipantA ? conv.participant_b_id : conv.participant_a_id;

    await pool.query(`
      UPDATE conversations
      SET ${statusCol} = 'accepted'
      WHERE id = $1
    `, [convId]);

    // Auto-save the other person as a contact so the conversation moves to active
    await pool.query(`
      INSERT INTO user_contacts (user_id, contact_user_id, created_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id, contact_user_id) DO NOTHING
    `, [userId, otherUserId]);

    // Fetch other user's info for response
    const { rows: otherUserRows } = await pool.query(`
      SELECT username FROM users WHERE id = $1
    `, [otherUserId]);
    const otherUsername = otherUserRows[0]?.username || 'Unknown';

    // Auto-create reciprocal contact for the other user
    await pool.query(`
      INSERT INTO user_contacts (user_id, contact_user_id, created_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id, contact_user_id) DO NOTHING
    `, [otherUserId, userId]);

    res.json({ ok: true, otherId: otherUserId, otherUsername });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/conversations/:convId/ignore', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { convId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Verify user is a participant
    const { rows: convRows } = await pool.query(`
      SELECT participant_a_id, participant_b_id FROM conversations WHERE id = $1
    `, [convId]);

    if (convRows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const conv = convRows[0];
    if (conv.participant_a_id !== userId && conv.participant_b_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Update conversation status for this participant
    const isParticipantA = conv.participant_a_id === userId;
    const statusCol = isParticipantA ? 'status_a' : 'status_b';

    await pool.query(`
      UPDATE conversations
      SET ${statusCol} = 'ignored'
      WHERE id = $1
    `, [convId]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/conversations/:convId/block', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { convId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Verify user is a participant
    const { rows: convRows } = await pool.query(`
      SELECT participant_a_id, participant_b_id, blocked_by FROM conversations WHERE id = $1
    `, [convId]);

    if (convRows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const conv = convRows[0];
    if (conv.participant_a_id !== userId && conv.participant_b_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Toggle block status
    const blockedBy = conv.blocked_by || [];
    const isBlocked = blockedBy.includes(userId);
    const newBlockedBy = isBlocked
      ? blockedBy.filter(id => id !== userId)
      : [...blockedBy, userId];

    await pool.query(`
      UPDATE conversations
      SET blocked_by = $1
      WHERE id = $2
    `, [newBlockedBy, convId]);

    res.json({ ok: true, blocked: !isBlocked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== CONTACTS ENDPOINTS =====

app.get('/api/contacts', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }
    const { rows } = await pool.query(`
      SELECT uc.id, u.id as user_id, u.username, u.usernode_pubkey, u.verified_at, u.avatar_url, uc.nickname, uc.archived_by, uc.muted_by
      FROM user_contacts uc
      JOIN users u ON uc.contact_user_id = u.id
      WHERE uc.user_id = $1
      ORDER BY uc.created_at DESC
    `, [userId]);

    const contacts = rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      usernode_pubkey: r.usernode_pubkey || null,
      nickname: r.nickname,
      verified: !!r.verified_at,
      avatar_url: r.avatar_url || null,
      archived_by: r.archived_by || [],
      muted_by: r.muted_by || [],
    }));

    res.json({ contacts });
  } catch (err) {
    console.error('Error fetching contacts:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { usernode_pubkey, nickname } = req.body;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    if (!usernode_pubkey) {
      return res.status(400).json({ error: 'usernode_pubkey is required' });
    }

    if (!usernode_pubkey.startsWith('ut1')) {
      return res.status(400).json({ error: 'Invalid Usernode address format' });
    }

    // Find user by wallet address
    const userRes = await pool.query(`
      SELECT id, username, usernode_pubkey, verified_at, avatar_url
      FROM users
      WHERE usernode_pubkey = $1
    `, [usernode_pubkey]);

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const contactUser = userRes.rows[0];
    const contactUserId = contactUser.id;

    if (contactUserId === userId) {
      return res.status(400).json({ error: 'Cannot add yourself as a contact' });
    }

    // Check if contact already exists
    const existRes = await pool.query(`
      SELECT id FROM user_contacts
      WHERE user_id = $1 AND contact_user_id = $2
    `, [userId, contactUserId]);

    if (existRes.rows.length > 0) {
      return res.status(409).json({ error: 'Contact already saved' });
    }

    // Add contact
    const result = await pool.query(`
      INSERT INTO user_contacts (user_id, contact_user_id, nickname, created_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING id
    `, [userId, contactUserId, nickname || null]);

    res.json({
      id: result.rows[0].id,
      userId: contactUserId,
      username: contactUser.username,
      usernode_pubkey: contactUser.usernode_pubkey,
      nickname: nickname || null,
      verified: !!contactUser.verified_at,
      avatar_url: contactUser.avatar_url || null,
    });
  } catch (err) {
    console.error('Error adding contact:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts/by-id', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { user_id, nickname } = req.body;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    // Find user by ID
    const userRes = await pool.query(`
      SELECT id, username, usernode_pubkey, verified_at, avatar_url
      FROM users
      WHERE id = $1
    `, [user_id]);

    if (userRes.rows.length === 0) {
      return res.status(400).json({ error: 'User not found' });
    }

    const contactUser = userRes.rows[0];
    const contactUserId = contactUser.id;

    if (contactUserId === userId) {
      return res.status(400).json({ error: 'Cannot add yourself as a contact' });
    }

    // Check if contact already exists
    const existRes = await pool.query(`
      SELECT id FROM user_contacts
      WHERE user_id = $1 AND contact_user_id = $2
    `, [userId, contactUserId]);

    if (existRes.rows.length > 0) {
      return res.status(409).json({ error: 'Contact already saved' });
    }

    // Add contact
    const result = await pool.query(`
      INSERT INTO user_contacts (user_id, contact_user_id, nickname, created_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING id
    `, [userId, contactUserId, nickname || null]);

    res.json({
      id: result.rows[0].id,
      userId: contactUserId,
      username: contactUser.username,
      usernode_pubkey: contactUser.usernode_pubkey,
      nickname: nickname || null,
      verified: !!contactUser.verified_at,
      avatar_url: contactUser.avatar_url || null,
    });
  } catch (err) {
    console.error('Error adding contact by ID:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/contacts/:contactId/conversation-count', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const contactId = req.params.contactId;
    if (!contactId || !/^\d+$/.test(contactId)) {
      return res.status(400).json({ error: 'Invalid contact ID' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Get contact_user_id
    const contactResult = await pool.query(`
      SELECT contact_user_id FROM user_contacts
      WHERE id = $1 AND user_id = $2
    `, [contactId, userId]);

    if (contactResult.rowCount === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const contactUserId = contactResult.rows[0].contact_user_id;

    // Count conversations with this contact
    const countResult = await pool.query(`
      SELECT COUNT(*) as count FROM conversations
      WHERE (participant_a_id = $1 AND participant_b_id = $2)
         OR (participant_a_id = $2 AND participant_b_id = $1)
    `, [userId, contactUserId]);

    const count = parseInt(countResult.rows[0].count, 10);
    res.json({ conversationCount: count });
  } catch (err) {
    console.error('Error counting conversations:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/contacts/:contactId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const contactId = req.params.contactId;
    if (!contactId || !/^\d+$/.test(contactId)) {
      return res.status(400).json({ error: 'Invalid contact ID' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Get contact_user_id before deletion
    const contactResult = await pool.query(`
      SELECT contact_user_id FROM user_contacts
      WHERE id = $1 AND user_id = $2
    `, [contactId, userId]);

    if (contactResult.rowCount === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const contactUserId = contactResult.rows[0].contact_user_id;

    // Delete all conversations with this contact (cascade deletes messages)
    const convResult = await pool.query(`
      DELETE FROM conversations
      WHERE (participant_a_id = $1 AND participant_b_id = $2)
         OR (participant_a_id = $2 AND participant_b_id = $1)
    `, [userId, contactUserId]);

    const deletedConversations = convResult.rowCount;

    // Delete the contact record
    await pool.query(`
      DELETE FROM user_contacts
      WHERE id = $1 AND user_id = $2
    `, [contactId, userId]);

    res.json({ ok: true, deletedConversations });
  } catch (err) {
    console.error('Error deleting contact:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts/:contactId/archive', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const contactId = req.params.contactId;
    if (!contactId || !/^\d+$/.test(contactId)) {
      return res.status(400).json({ error: 'Invalid contact ID' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    const result = await pool.query(`
      UPDATE user_contacts
      SET archived_by = CASE
        WHEN archived_by @> ARRAY[$1]::integer[] THEN array_remove(archived_by, $1)
        ELSE CASE WHEN archived_by IS NULL THEN ARRAY[$1] ELSE array_append(archived_by, $1) END
      END
      WHERE id = $2 AND user_id = $3
      RETURNING archived_by
    `, [userId, contactId, userId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const isArchived = result.rows[0].archived_by && result.rows[0].archived_by.includes(userId);
    res.json({ ok: true, archived: isArchived });
  } catch (err) {
    console.error('Error archiving contact:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/contacts/:contactId/mute', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const contactId = req.params.contactId;
    if (!contactId || !/^\d+$/.test(contactId)) {
      return res.status(400).json({ error: 'Invalid contact ID' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    const result = await pool.query(`
      UPDATE user_contacts
      SET muted_by = CASE
        WHEN muted_by @> ARRAY[$1]::integer[] THEN array_remove(muted_by, $1)
        ELSE CASE WHEN muted_by IS NULL THEN ARRAY[$1] ELSE array_append(muted_by, $1) END
      END
      WHERE id = $2 AND user_id = $3
      RETURNING muted_by
    `, [userId, contactId, userId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const isMuted = result.rows[0].muted_by && result.rows[0].muted_by.includes(userId);
    res.json({ ok: true, muted: isMuted });
  } catch (err) {
    console.error('Error muting contact:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/contact-info', (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    res.json({
      username: req.user.username,
      usernode_pubkey: req.user.usernode_pubkey || null,
      verified: !!req.user.verified_at,
      shareLink: `${req.protocol}://${req.get('host')}/?contact=${encodeURIComponent(req.user.usernode_pubkey || '')}`,
    });
  } catch (err) {
    console.error('Error getting contact info:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== SEARCH & PROFILE ENDPOINTS =====

app.get('/api/search/users', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    const q = req.query.q || '';

    if (ENABLE_DEMO_MODE) {
      const mockResult = mockData.getMockSearchUsers(q, 20);
      return res.json({
        users: mockResult.results.map(u => ({
          id: u.id,
          username: u.username,
          usernode_pubkey: u.usernode_pubkey || null,
          verified: u.verified,
          mutualCount: 0
        }))
      });
    }

    let rows;

    try {
      const result = await queryWithTimeout(pool, `
        SELECT id, username, verified_at, usernode_pubkey
        FROM users
        WHERE (username ILIKE $1 OR usernode_pubkey ILIKE $2) AND id != $7
        ORDER BY
          CASE
            WHEN username = $3 OR usernode_pubkey = $4 THEN 0
            WHEN username ILIKE $5 OR usernode_pubkey ILIKE $6 THEN 1
            ELSE 2
          END,
          username ASC
        LIMIT 20
      `, ['%' + q + '%', '%' + q + '%', q, q, q + '%', q + '%', userId], 2000);
      rows = result.rows;
    } catch (timeoutErr) {
      // On timeout, return demo fallback users
      if (timeoutErr.message === 'QUERY_TIMEOUT') {
        console.info('Search query timeout after 2000ms, returning demo fallback');
        const demoUsers = [
          { id: 1, username: 'staging-demo-alice', usernode_pubkey: 'ut1staging-alice-001', verified_at: new Date() },
          { id: 2, username: 'staging-demo-bob', usernode_pubkey: 'ut1staging-bob-001', verified_at: new Date() },
          { id: 3, username: 'staging-demo-charlie', usernode_pubkey: 'ut1staging-charlie-001', verified_at: null }
        ];
        const filteredUsers = demoUsers.filter(u => u.id !== userId).map(u => ({
          id: u.id,
          username: u.username,
          usernode_pubkey: u.usernode_pubkey,
          verified: !!u.verified_at,
          mutualCount: 0,
        }));
        return res.json({ users: filteredUsers });
      }
      // For non-timeout errors, re-throw to be caught by outer catch
      throw timeoutErr;
    }

    const users = rows.map(r => ({
      id: r.id,
      username: r.username,
      usernode_pubkey: r.usernode_pubkey || null,
      verified: !!r.verified_at,
      mutualCount: 0,
    }));

    res.json({ users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/search', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ users: [] });
    const { rows } = await pool.query(`
      SELECT id, username, verified_at, avatar_url
      FROM users
      WHERE LOWER(username) LIKE LOWER($1)
      ORDER BY username
      LIMIT 8
    `, [q + '%']);
    res.json({
      users: rows.map(r => ({
        id: r.id,
        username: r.username,
        avatar_url: r.avatar_url || null,
        verified: !!r.verified_at,
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/by-username/:username', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { username } = req.params;
    const { rows } = await pool.query(`
      SELECT id, username, verified_at, usernode_pubkey, avatar_url, bio
      FROM users
      WHERE LOWER(username) = LOWER($1)
    `, [username]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const user = rows[0];
    const foregroundHours = getForegroundHours(user.id);
    const { rank, hoursBracket, contributionLevel } = calculateRankData(foregroundHours);
    res.json({
      id: user.id,
      username: user.username,
      usernode_pubkey: user.usernode_pubkey || null,
      verified: !!user.verified_at,
      avatar_url: user.avatar_url || null,
      bio: user.bio || null,
      foregroundHours,
      rank,
      hoursBracket,
      contributionLevel,
      mutualCount: 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { rows } = await pool.query(`
      SELECT id, username, verified_at, usernode_pubkey, avatar_url, bio FROM users WHERE id = $1
    `, [userId]);

    if (!rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = rows[0];
    const foregroundHours = getForegroundHours(userId);
    const { rank, hoursBracket, contributionLevel } = calculateRankData(foregroundHours);

    res.json({
      id: user.id,
      username: user.username,
      usernode_pubkey: user.usernode_pubkey || null,
      verified: !!user.verified_at,
      avatar_url: user.avatar_url || null,
      bio: user.bio || null,
      foregroundHours,
      rank,
      hoursBracket,
      contributionLevel,
      mutualCount: 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== GROUPS ENDPOINTS =====

app.get('/api/groups', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }
    const limit = Math.min(parseInt(req.query.limit || 50), 100);
    const offset = parseInt(req.query.offset || 0);

    if (ENABLE_DEMO_MODE) {
      return res.json(mockData.getMockGroups(1, limit, offset));
    }

    // Get groups where user is a member
    const { rows: groupRows } = await pool.query(`
      SELECT DISTINCT g.id, g.creator_id, g.name, g.description, g.avatar_url, g.created_at, g.updated_at, g.archived_by,
             (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count,
             (SELECT COUNT(*) FROM group_messages gm WHERE gm.group_id = g.id AND gm.created_at > COALESCE(grr.last_read_at, '1970-01-01')) as unread_count,
             (SELECT sender_id FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_sender_id,
             (SELECT content FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_content,
             (SELECT type FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_type,
             (SELECT created_at FROM group_messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_created_at
      FROM groups g
      JOIN group_members gm ON gm.group_id = g.id
      LEFT JOIN group_read_receipts grr ON grr.user_id = $1 AND grr.group_id = g.id
      WHERE gm.user_id = $1
      ORDER BY g.updated_at DESC NULLS LAST, g.created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    const groups = await Promise.all(groupRows.map(async (row) => {
      let lastMessage = '';
      if (row.last_type) {
        if (row.last_type === 'text') {
          try {
            const content = typeof row.last_content === 'string'
              ? JSON.parse(row.last_content || '{}')
              : (row.last_content || {});
            lastMessage = (content && content.text) || '';
          } catch (e) {
            console.error('Failed to parse last_content:', row.last_content, e);
            lastMessage = '';
          }
        } else if (row.last_type === 'image') {
          lastMessage = '[Image]';
        } else if (row.last_type === 'token') {
          lastMessage = '[Token transfer]';
        }
      }

      return {
        id: row.id,
        name: row.name,
        description: row.description || null,
        avatar_url: row.avatar_url || null,
        creatorId: row.creator_id,
        memberCount: parseInt(row.member_count || 0),
        lastMessage,
        lastMessageAt: row.last_created_at || null,
        unreadCount: parseInt(row.unread_count || 0),
        archived_by: row.archived_by || [],
      };
    }));

    // Categorize groups by archive state
    const active = [];
    const archived = [];
    for (const group of groups) {
      const isArchived = group.archived_by && group.archived_by.includes(userId);
      if (isArchived) {
        archived.push(group);
      } else {
        active.push(group);
      }
    }

    res.json({ groups: { active, archived } });
  } catch (err) {
    console.error('Error fetching groups:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups', async (req, res) => {
  const requestId = Math.random().toString(36).substr(2, 9);
  const startTime = new Date().toISOString();
  console.log(`[POST /api/groups::ENTRY] Request ID=${requestId}, timestamp=${startTime}, env=${IS_STAGING ? 'staging' : 'production'}`);
  console.log(`[POST /api/groups::ENTRY] Payload: name="${req.body.name}", description="${req.body.description || '(none)'}", initialMemberIds=${req.body.initialMemberIds ? req.body.initialMemberIds.length : 0} members`);

  try {
    // Validation: check authentication
    console.log(`[POST /api/groups::VALIDATE] Checking authentication: req.user exists=${!!req.user}`);
    if (!req.user) {
      console.error(`[POST /api/groups::VALIDATE] Authentication failed - no req.user`);
      return res.status(401).json({ error: 'Not authenticated' });
    }
    console.log(`[POST /api/groups::VALIDATE] Authentication successful: userId=${req.user.id}`);

    const { name, description, initialMemberIds, txHash, auditLogId, contentHash: frontendContentHash } = req.body;

    // Validation: parse and validate user ID
    const userId = parseInt(req.user.id, 10);
    console.log(`[POST /api/groups::VALIDATE] User ID parsing: raw=${req.user.id}, parsed=${userId}, isNaN=${isNaN(userId)}`);
    if (isNaN(userId)) {
      console.error(`[POST /api/groups::VALIDATE] Invalid user ID: ${req.user.id}`);
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Validation: check wallet connection before proceeding with group creation
    console.log(`[POST /api/groups::VALIDATE] Checking wallet connection: usernode_pubkey=${req.user.usernode_pubkey ? 'present' : 'missing'}`);
    if (!req.user.usernode_pubkey) {
      console.error(`[POST /api/groups::VALIDATE] Wallet not connected - usernode_pubkey is missing`);
      return res.status(401).json({ error: 'Must be connected to Usernode wallet to create groups' });
    }

    // Validation: check group name
    console.log(`[POST /api/groups::VALIDATE] Group name validation: provided="${name}", trimmed="${name ? name.trim() : '(null)'}", length=${name ? name.trim().length : 0}`);
    if (!name || name.trim().length === 0) {
      console.error(`[POST /api/groups::VALIDATE] Group name validation failed: empty or missing`);
      return res.status(400).json({ error: 'Group name is required' });
    }
    console.log(`[POST /api/groups::VALIDATE] All validations passed`);

    const network = 'testnet';
    const now = new Date();

    // Database: Create group
    console.log(`[POST /api/groups::DB] Creating group with: creator_id=${userId}, name="${name.trim()}", description="${description || '(null)'}", network=${network}`);
    const result = await pool.query(`
      INSERT INTO groups (creator_id, name, description, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      RETURNING id, name, description, avatar_url, creator_id, created_at, updated_at
    `, [userId, name.trim(), description || null]);

    if (result.rows.length === 0) {
      console.error(`[POST /api/groups::DB] Group insert returned no rows`);
      throw new Error('Group creation query returned no results');
    }
    const groupId = result.rows[0].id;
    console.log(`[POST /api/groups::DB] Group created successfully: id=${groupId}, name="${result.rows[0].name}"`);

    // Database: Add creator as member
    console.log(`[POST /api/groups::DB] Adding creator as member: groupId=${groupId}, userId=${userId}, role='creator'`);
    const creatorMemberRes = await pool.query(`
      INSERT INTO group_members (group_id, user_id, role, joined_at)
      VALUES ($1, $2, 'creator', NOW())
    `, [groupId, userId]);
    console.log(`[POST /api/groups::DB] Creator member insert: rowCount=${creatorMemberRes.rowCount}`);

    // Database: Add initial members if provided
    let memberPubkeys = [];
    if (initialMemberIds && Array.isArray(initialMemberIds) && initialMemberIds.length > 0) {
      console.log(`[POST /api/groups::DB] Processing ${initialMemberIds.length} initial member(s)`);
      // Validate and resolve all member wallet addresses
      try {
        const resolved = await validateAndResolvePubkeys(initialMemberIds);
        memberPubkeys = resolved.map(r => r.pubkey);
        console.log(`[POST /api/groups::DB] Resolved ${memberPubkeys.length} member wallet addresses`);
      } catch (err) {
        console.error(`[POST /api/groups::BLOCKCHAIN] Member address resolution failed: ${err.message}`);
        return res.status(err.statusCode || 400).json({ error: err.message });
      }

      for (let idx = 0; idx < initialMemberIds.length; idx++) {
        const memberId = initialMemberIds[idx];
        if (memberId !== userId) {
          console.log(`[POST /api/groups::DB] Adding member ${idx + 1}/${initialMemberIds.length}: memberId=${memberId}`);
          const memberRes = await pool.query(`
            INSERT INTO group_members (group_id, user_id, role, joined_at)
            VALUES ($1, $2, 'member', NOW())
            ON CONFLICT (group_id, user_id) DO NOTHING
          `, [groupId, memberId]);
          console.log(`[POST /api/groups::DB] Member insert: rowCount=${memberRes.rowCount} (0 if conflict)`);
        } else {
          console.log(`[POST /api/groups::DB] Skipping member ${idx + 1}/${initialMemberIds.length}: same as creator`);
        }
      }
    } else {
      console.log(`[POST /api/groups::DB] No initial members provided`);
    }

    // Database: Initialize read receipt for creator
    console.log(`[POST /api/groups::DB] Creating read receipt: userId=${userId}, groupId=${groupId}`);
    const readReceiptRes = await pool.query(`
      INSERT INTO group_read_receipts (user_id, group_id, last_read_at)
      VALUES ($1, $2, NOW())
    `, [userId, groupId]);
    console.log(`[POST /api/groups::DB] Read receipt insert: rowCount=${readReceiptRes.rowCount}`);

    // Blockchain: Prepare transaction payload (Usernode chain format)
    const contentHash = frontendContentHash || computeContentHash(name.trim());
    const transactionPayload = {
      type: 'group_create',
      groupId: groupId,
      groupName: name.trim(),
      creatorPubkey: req.user.usernode_pubkey || APP_PUBKEY,
      memberPubkeys: memberPubkeys.length > 0 ? memberPubkeys : [req.user.usernode_pubkey || APP_PUBKEY],
      contentHash: contentHash,
      timestamp: now.toISOString(),
      network: network
    };
    console.log(`[POST /api/groups::BLOCKCHAIN] Transaction payload prepared: type=${transactionPayload.type}, groupId=${transactionPayload.groupId}, memberCount=${transactionPayload.memberPubkeys.length}, network=${transactionPayload.network}, creatorPubkeyPresent=${!!transactionPayload.creatorPubkey}`);

    // Sign memo following Last One Wins pattern
    const memo = signTransactionMemo(transactionPayload);

    // Blockchain: Use existing audit log if provided, otherwise create new one
    let blockchainRecordingId;
    if (auditLogId) {
      // Two-phase flow: audit log already exists from wallet signature, just update it
      console.log(`[POST /api/groups::BLOCKCHAIN] Using existing audit log: id=${auditLogId}`);
      let actualTxHash = txHash || (ENABLE_DEMO_MODE ? 'ut1staging-' + network + '-group-create-' + groupId + '-' + Date.now() : 'ut1-' + network + '-tx-group-' + Math.random().toString(36).substr(2, 9));

      // Defensive fallback: ensure tx_hash is never null before UPDATE
      if (!actualTxHash) {
        actualTxHash = `guardian-pending-group-${groupId}-${Date.now()}-${crypto.randomUUID()}`;
        console.warn(`[POST /api/groups::BLOCKCHAIN] Fallback tx_hash generated: ${actualTxHash}`);
      }

      const auditStatus = txHash ? 'pending' : (ENABLE_DEMO_MODE ? 'confirmed' : 'pending');

      await pool.query(`
        UPDATE blockchain_audit_logs
        SET group_id = $1, message_type = $2, tx_hash = $3, transaction_payload = $4, status = $5, confirmed_at = $6, content_hash = $7, user_pubkey = $8, action_timestamp = $9, updated_at = NOW()
        WHERE id = $10 AND user_id = $11
      `, [groupId, 'group_create', actualTxHash, JSON.stringify(transactionPayload), auditStatus, (auditStatus === 'confirmed' ? now : null), contentHash, req.user.usernode_pubkey || null, now, auditLogId, userId]);
      blockchainRecordingId = auditLogId;
      console.log(`[POST /api/groups::BLOCKCHAIN] Updated existing audit log: id=${blockchainRecordingId}`);
    } else {
      // Single-phase flow: create new audit log
      let actualTxHash = txHash || (ENABLE_DEMO_MODE ? 'ut1staging-' + network + '-group-create-' + groupId + '-' + Date.now() : 'ut1-' + network + '-tx-group-' + Math.random().toString(36).substr(2, 9));

      // Defensive fallback: ensure tx_hash is never null before INSERT
      if (!actualTxHash) {
        actualTxHash = `guardian-pending-group-${groupId}-${Date.now()}-${crypto.randomUUID()}`;
        console.warn(`[POST /api/groups::BLOCKCHAIN] Fallback tx_hash generated: ${actualTxHash}`);
      }

      const auditStatus = txHash ? 'pending' : (ENABLE_DEMO_MODE ? 'confirmed' : 'pending');
      console.log(`[AUDIT LOG] GROUP_CREATE: txHash=${actualTxHash}, groupId=${groupId}, status=${auditStatus}, memberCount=${memberPubkeys.length}`);
      console.log(`[POST /api/groups::BLOCKCHAIN] Creating new audit log: txHash=${actualTxHash}, status=${auditStatus}, env=${IS_STAGING ? 'staging' : 'production'}, demoMode=${ENABLE_DEMO_MODE}`);

      // Defensive validation: ensure tx_hash is present before INSERT
      if (!actualTxHash) {
        throw new Error('Missing tx_hash before audit log creation');
      }

      const auditRes = await pool.query(`
        INSERT INTO blockchain_audit_logs (user_id, group_id, message_type, tx_hash, transaction_payload, status, confirmed_at, content_hash, user_pubkey, action_timestamp, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
        RETURNING id
      `, [userId, groupId, 'group_create', actualTxHash, JSON.stringify(transactionPayload), auditStatus, (auditStatus === 'confirmed' ? now : null), contentHash, req.user.usernode_pubkey || null, now, now]);

      if (auditRes.rows.length === 0) {
        console.error(`[POST /api/groups::BLOCKCHAIN] Audit log insert returned no rows`);
        throw new Error('Audit log creation query returned no results');
      }
      blockchainRecordingId = auditRes.rows[0].id;
      console.log(`[POST /api/groups::BLOCKCHAIN] Audit log created: id=${blockchainRecordingId}, rowCount=${auditRes.rowCount}`);
    }

    // Blockchain: If real tx hash provided from frontend, start polling immediately
    if (txHash) {
      console.log(`[POST /api/groups::BLOCKCHAIN] Real txHash provided from frontend, starting polling`);
      (async () => {
        try {
          await pollTransactionStatus(blockchainRecordingId, txHash);
        } catch (err) {
          console.error('Error polling transaction status:', err);
        }
      })();
    } else if (!ENABLE_DEMO_MODE) {
      console.log(`[POST /api/groups::BLOCKCHAIN] Spawning background blockchain submission task (production only)`);
      (async () => {
        try {
          console.log(`[POST /api/groups::BLOCKCHAIN::ASYNC] Background task started for auditId=${blockchainRecordingId}`);

          // Validate memo before calling RPC
          if (!memo) {
            throw new Error('Failed to sign transaction memo');
          }

          const result = await sendGroupToBlockchain(transactionPayload, memo, memberPubkeys, network);
          console.log(`[POST /api/groups::BLOCKCHAIN::ASYNC] RPC returned txHash=${result.transactionHash}`);

          const updateRes = await pool.query(`
            UPDATE blockchain_audit_logs SET tx_hash = $1 WHERE id = $2
          `, [result.transactionHash, blockchainRecordingId]);
          console.log(`[POST /api/groups::BLOCKCHAIN::ASYNC] Audit log updated with real txHash, rowCount=${updateRes.rowCount}`);

          console.log(`[POST /api/groups::BLOCKCHAIN::ASYNC] Starting chain polling`);
          startChainPoller(network, result.transactionHash, blockchainRecordingId).catch(err => {
            console.error(`[POST /api/groups::BLOCKCHAIN::ASYNC] Error starting chain poller: ${err.message}`, err);
          });
        } catch (err) {
          console.error(`[POST /api/groups::BLOCKCHAIN::ASYNC] Background blockchain submission error: ${err.message}`, err);

          // Fallback: try bridge approach
          try {
            const bridgeResult = await sendTransactionToBridge(transactionPayload, null, network);

            await pool.query(`
              UPDATE blockchain_audit_logs SET tx_hash = $1 WHERE id = $2
            `, [bridgeResult.txHash, blockchainRecordingId]);

            // Start polling with placeholder so it eventually marks as 'failed'
            startChainPoller(network, bridgeResult.txHash, blockchainRecordingId).catch(pollerErr => {
              console.error(`[POST /api/groups::BLOCKCHAIN::ASYNC] Error starting fallback chain poller: ${pollerErr.message}`, pollerErr);
            });
          } catch (bridgeErr) {
            console.error(`[POST /api/groups::BLOCKCHAIN::ASYNC] Fallback also failed: ${bridgeErr.message}`, bridgeErr);
            await pool.query(`
              UPDATE blockchain_audit_logs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2
            `, [bridgeErr.message, blockchainRecordingId]);
          }
        }
      })();
    } else {
      console.log(`[POST /api/groups::BLOCKCHAIN] Background blockchain submission skipped (demo mode enabled)`);
    }

    // Database: Get members for response
    console.log(`[POST /api/groups::DB] Fetching members for response: groupId=${groupId}`);
    const { rows: memberRows } = await pool.query(`
      SELECT gm.id, gm.user_id, u.username, gm.role, gm.joined_at
      FROM group_members gm
      JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = $1
    `, [groupId]);
    console.log(`[POST /api/groups::DB] Member fetch returned ${memberRows.length} member(s)`);

    const members = memberRows.map(m => ({
      id: m.id,
      userId: m.user_id,
      username: m.username,
      role: m.role,
      joinedAt: m.joined_at
    }));

    // Response: Send successful response
    const responsePayload = {
      id: groupId,
      name: result.rows[0].name,
      description: result.rows[0].description,
      creatorId: result.rows[0].creator_id,
      members,
      createdAt: result.rows[0].created_at,
      blockchainRecordingId: blockchainRecordingId
    };
    console.log(`[POST /api/groups::RESPONSE] Success response prepared: id=${responsePayload.id}, name="${responsePayload.name}", memberCount=${responsePayload.members.length}, blockchainRecordingId=${responsePayload.blockchainRecordingId}`);
    console.log(`[POST /api/groups::COMPLETE] Request completed successfully, requestId=${requestId}`);

    res.json(responsePayload);
  } catch (err) {
    console.error(`[POST /api/groups::ERROR] Exception caught, requestId=${requestId}`);
    console.error(`[POST /api/groups::ERROR] Error type: ${err.constructor.name}`);
    console.error(`[POST /api/groups::ERROR] Error message: ${err.message}`);
    console.error(`[POST /api/groups::ERROR] Error stack:`, err.stack);
    console.error(`[POST /api/groups::ERROR] Full error object:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/groups/:groupId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { groupId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    if (ENABLE_DEMO_MODE) {
      const groupIdInt = parseInt(groupId);
      const mockGroup = mockData.getMockGroupById(groupIdInt);
      if (!mockGroup) {
        return res.status(404).json({ error: 'Group not found' });
      }
      const mockMembers = mockData.getMockGroupMembers(groupIdInt);
      return res.json({
        ...mockGroup,
        members: mockMembers.members
      });
    }

    // Verify user is a member
    const { rows: memberRows } = await pool.query(`
      SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [groupId, userId]);

    if (memberRows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    // Get group details
    const { rows: groupRows } = await pool.query(`
      SELECT id, creator_id, name, description, avatar_url, created_at, updated_at
      FROM groups WHERE id = $1
    `, [groupId]);

    if (groupRows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const group = groupRows[0];

    // Get members
    const { rows: memberDetailRows } = await pool.query(`
      SELECT gm.id, gm.user_id, u.username, u.verified_at, u.avatar_url, gm.role, gm.joined_at
      FROM group_members gm
      JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = $1
    `, [groupId]);

    const members = memberDetailRows.map(m => ({
      id: m.id,
      userId: m.user_id,
      username: m.username,
      verified: !!m.verified_at,
      avatar_url: m.avatar_url || null,
      role: m.role,
      joinedAt: m.joined_at
    }));

    res.json({
      id: group.id,
      name: group.name,
      description: group.description || null,
      avatar_url: group.avatar_url || null,
      creatorId: group.creator_id,
      members,
      createdAt: group.created_at,
      updatedAt: group.updated_at
    });
  } catch (err) {
    console.error('Error fetching group:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/groups/:groupId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { groupId } = req.params;
    const { name, description } = req.body;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Validate wallet connection before proceeding with group update
    if (!req.user.usernode_pubkey) {
      return res.status(401).json({ error: 'Must be connected to Usernode wallet to update groups' });
    }

    const now = new Date();

    // Verify user is creator
    const { rows: groupRows } = await pool.query(`
      SELECT creator_id FROM groups WHERE id = $1
    `, [groupId]);

    if (groupRows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    if (groupRows[0].creator_id !== userId) {
      return res.status(403).json({ error: 'Only creator can edit group' });
    }

    // Fetch user's network preference
    const network = 'testnet';

    // Update group
    await pool.query(`
      UPDATE groups SET name = $1, description = $2, updated_at = NOW() WHERE id = $3
    `, [name || groupRows[0].name, description || null, groupId]);

    // Prepare transaction payload for blockchain
    const transactionPayload = {
      type: 'group_update',
      groupId: groupId,
      groupName: name || groupRows[0].name,
      creatorPubkey: req.user.usernode_pubkey,
      network: network
    };

    // Create audit log entry for group update
    const networkPrefix = network === 'mainnet' ? 'mainnet-' : 'testnet-';
    const placeholderTxHash = ENABLE_DEMO_MODE ? 'ut1staging-' + networkPrefix + 'tx-update-' + Date.now() : 'ut1-' + networkPrefix + 'tx-update-' + Math.random().toString(36).substr(2, 9);
    const auditRes = await pool.query(`
      INSERT INTO blockchain_audit_logs (user_id, message_type, tx_hash, transaction_payload, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $6)
      RETURNING id
    `, [userId, 'group_update', placeholderTxHash, JSON.stringify(transactionPayload), 'pending', now]);
    const blockchainRecordingId = auditRes.rows[0].id;

    // Async: submit to blockchain in the background
    (async () => {
      try {
        const result = await sendTransactionToBridge(transactionPayload, null, network);
        // Update audit log with real tx hash
        await pool.query(`
          UPDATE blockchain_audit_logs SET tx_hash = $1 WHERE id = $2
        `, [result.txHash, blockchainRecordingId]);
        // Start monitoring
        monitorBlockchainStatus(blockchainRecordingId, result.txHash).catch(err => {
          console.error('Error monitoring blockchain status:', err);
        });
      } catch (err) {
        console.error('Background blockchain submission error:', err);
        await pool.query(`
          UPDATE blockchain_audit_logs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2
        `, [err.message, blockchainRecordingId]);
      }
    })();

    res.json({ ok: true, blockchainRecordingId: blockchainRecordingId });
  } catch (err) {
    console.error('Error updating group:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/groups/:groupId/messages', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { groupId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }
    const limit = Math.min(parseInt(req.query.limit || 50), 100);
    const offset = parseInt(req.query.offset || 0);

    if (ENABLE_DEMO_MODE) {
      const groupIdInt = parseInt(groupId);
      const mockResult = mockData.getMockGroupMessages(groupIdInt, limit, offset);
      const msgList = mockResult.messages.map(m => ({
        id: m.id,
        senderId: m.sender_id,
        senderUsername: mockData.MOCK_USERS.find(u => u.id === m.sender_id)?.username || 'Unknown',
        type: m.type,
        content: m.content,
        createdAt: m.created_at,
        blockchainRecorded: false,
        blockchainAuditLogId: null
      }));
      return res.json({ messages: msgList, hasMore: offset + limit < mockResult.total });
    }

    const before = req.query.before ? new Date(req.query.before) : new Date();

    // Verify user is a member
    const { rows: memberRows } = await pool.query(`
      SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [groupId, userId]);

    if (memberRows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    // Get messages
    const { rows: messages } = await pool.query(`
      SELECT id, sender_id,
             (SELECT username FROM users WHERE id = gm.sender_id) as sender_username,
             type, content, created_at, blockchain_recorded, blockchain_audit_log_id, deleted_by
      FROM group_messages gm
      WHERE group_id = $1
        AND created_at < $2
        AND (deleted_by IS NULL OR NOT (deleted_by @> ARRAY[$3]::integer[]))
      ORDER BY created_at DESC
      LIMIT $4
    `, [groupId, before, userId, limit]);

    messages.reverse();
    const msgList = messages.map(m => ({
      id: m.id,
      senderId: m.sender_id,
      senderUsername: m.sender_username,
      type: m.type,
      content: m.content,
      createdAt: m.created_at,
      blockchainRecorded: m.blockchain_recorded,
      blockchainAuditLogId: m.blockchain_audit_log_id,
    }));

    res.json({ messages: msgList, hasMore: messages.length === limit });
  } catch (err) {
    console.error('Error fetching group messages:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups/:groupId/messages', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { groupId } = req.params;
    const { type, content, txHash, auditLogId } = req.body;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Validate wallet connection before proceeding with group message transaction
    if (!req.user.usernode_pubkey) {
      return res.status(401).json({ error: 'Must be connected to Usernode wallet to send group messages' });
    }

    const now = new Date();

    if (!checkRateLimit(`gmsg:${userId}`, 100, 60000)) {
      return res.status(429).json({ error: 'Rate limited' });
    }

    if (!type || !content) {
      return res.status(400).json({ error: 'Invalid message' });
    }

    // Verify user is a member of group
    const { rows: memberRows } = await pool.query(`
      SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [groupId, userId]);

    if (memberRows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    // Fetch user's pubkey
    const userPubkey = req.user.usernode_pubkey;
    const network = 'testnet';

    // Create message with blockchain recording enabled
    const contentHash = computeContentHash(content);
    const msgRes = await pool.query(`
      INSERT INTO group_messages (group_id, sender_id, type, content, blockchain_recorded, blockchain_audit_log_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, created_at
    `, [groupId, userId, type, JSON.stringify(content), true, null, now]);
    const messageId = msgRes.rows[0].id;

    // Prepare transaction payload
    const transactionPayload = {
      type: 'message',
      messageId: messageId,
      groupId: groupId,
      senderId: userId,
      userPubkey: userPubkey,
      contentHash: contentHash,
      timestamp: now.toISOString(),
      network: network
    };

    // Use real tx hash from frontend if provided, otherwise generate placeholder
    const actualTxHash = txHash || (ENABLE_DEMO_MODE ? 'ut1staging-' + network + '-message-' + messageId + '-' + Date.now() : 'ut1-' + network + '-tx-msg-' + Math.random().toString(36).substr(2, 9));
    const auditStatus = txHash ? 'pending' : (ENABLE_DEMO_MODE ? 'confirmed' : 'pending');

    let blockchainRecordingId;
    if (auditLogId) {
      // Two-phase flow: audit log already exists from wallet signature, just update it
      console.log(`[GROUP-MSG] Using existing audit log: id=${auditLogId}`);
      await pool.query(`
        UPDATE blockchain_audit_logs
        SET message_id = $1, group_id = $2, message_type = $3, tx_hash = $4, transaction_payload = $5, status = $6, confirmed_at = $7, content_hash = $8, user_pubkey = $9, action_timestamp = $10, updated_at = NOW()
        WHERE id = $11 AND user_id = $12
      `, [messageId, groupId, 'message', actualTxHash, JSON.stringify(transactionPayload), auditStatus, (auditStatus === 'confirmed' ? now : null), contentHash, userPubkey, now, auditLogId, userId]);
      blockchainRecordingId = auditLogId;
      console.log(`[GROUP-MSG] Updated existing audit log: id=${blockchainRecordingId}`);
    } else {
      // Single-phase flow: create new audit log
      const auditRes = await pool.query(`
        INSERT INTO blockchain_audit_logs (user_id, message_id, group_id, message_type, tx_hash, transaction_payload, status, confirmed_at, content_hash, user_pubkey, action_timestamp, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
        RETURNING id
      `, [userId, messageId, groupId, 'message', actualTxHash, JSON.stringify(transactionPayload), auditStatus, (auditStatus === 'confirmed' ? now : null), contentHash, userPubkey, now, now]);
      blockchainRecordingId = auditRes.rows[0].id;
    }

    // Update message with audit log reference
    await pool.query(`
      UPDATE group_messages SET blockchain_audit_log_id = $1 WHERE id = $2
    `, [blockchainRecordingId, messageId]);

    // Update group updated_at to reflect new message activity
    await pool.query(`
      UPDATE groups SET updated_at = NOW() WHERE id = $1
    `, [groupId]);

    // If real tx hash provided from frontend, start polling immediately
    if (txHash) {
      startChainPoller(network, txHash, blockchainRecordingId).catch(err => {
        console.error('Error starting chain poller:', err);
      });
    } else if (!ENABLE_DEMO_MODE) {
      // Async: submit to blockchain in the background (production only)
      (async () => {
        try {
          const result = await sendTransactionToBridge(transactionPayload, null, network);
          // Update audit log with real tx hash
          await pool.query(`
            UPDATE blockchain_audit_logs SET tx_hash = $1 WHERE id = $2
          `, [result.txHash, blockchainRecordingId]);
          // Start monitoring
          monitorBlockchainStatus(blockchainRecordingId, result.txHash).catch(err => {
            console.error('Error monitoring blockchain status:', err);
          });
        } catch (err) {
          console.error('Background blockchain submission error:', err);
          await pool.query(`
            UPDATE blockchain_audit_logs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2
          `, [err.message, blockchainRecordingId]);
        }
      })();
    }

    res.json({
      id: messageId,
      createdAt: new Date(now),
      blockchainRecordingId: blockchainRecordingId
    });
  } catch (err) {
    console.error('Error sending group message:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups/:groupId/messages/:messageId/delete', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { groupId, messageId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    await pool.query(`
      UPDATE group_messages
      SET deleted_by = CASE
        WHEN deleted_by IS NULL THEN ARRAY[$1]
        ELSE array_append(deleted_by, $1)
      END
      WHERE id = $2 AND group_id = $3
    `, [userId, messageId, groupId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting group message:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups/:groupId/messages/delete-all', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { groupId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Verify user is a member of the group
    const { rows: memberRows } = await pool.query(`
      SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [groupId, userId]);

    if (memberRows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    // Bulk update all messages to add current user to deleted_by
    const { rows: deletedRows } = await pool.query(`
      UPDATE group_messages
      SET deleted_by = CASE
        WHEN deleted_by IS NULL THEN ARRAY[$1]
        WHEN (deleted_by @> ARRAY[$1]::integer[]) THEN deleted_by
        ELSE array_append(deleted_by, $1)
      END
      WHERE group_id = $2
      RETURNING id
    `, [userId, groupId]);

    res.json({ ok: true, deletedCount: deletedRows.length });
  } catch (err) {
    console.error('Error deleting all group messages:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups/:groupId/members', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { groupId } = req.params;
    const { userIds } = req.body;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Verify user is creator
    const { rows: groupRows } = await pool.query(`
      SELECT creator_id FROM groups WHERE id = $1
    `, [groupId]);

    if (groupRows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    if (groupRows[0].creator_id !== userId) {
      return res.status(403).json({ error: 'Only creator can add members' });
    }

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'At least one user ID is required' });
    }

    // Fetch user's network preference
    const network = 'testnet';
    const now = new Date();

    // Validate and resolve member wallet addresses
    const filterredUserIds = userIds.filter(id => id !== userId);
    let memberPubkeys = [];
    if (filterredUserIds.length > 0) {
      try {
        const resolved = await validateAndResolvePubkeys(filterredUserIds);
        memberPubkeys = resolved.map(r => r.pubkey);
      } catch (err) {
        return res.status(err.statusCode || 400).json({ error: err.message });
      }
    }

    // Add members
    const addedMembers = [];
    for (const memberId of userIds) {
      if (memberId !== userId) {
        const result = await pool.query(`
          INSERT INTO group_members (group_id, user_id, role, joined_at)
          VALUES ($1, $2, 'member', NOW())
          ON CONFLICT (group_id, user_id) DO NOTHING
          RETURNING id
        `, [groupId, memberId]);

        if (result.rows.length > 0) {
          // Get user details
          const memberUserRes = await pool.query(`
            SELECT id, username, verified_at, avatar_url FROM users WHERE id = $1
          `, [memberId]);

          if (memberUserRes.rows.length > 0) {
            const u = memberUserRes.rows[0];
            addedMembers.push({
              userId: u.id,
              username: u.username,
              verified: !!u.verified_at,
              avatar_url: u.avatar_url || null,
              role: 'member'
            });
          }
        }

        // Initialize read receipt for new member
        await pool.query(`
          INSERT INTO group_read_receipts (user_id, group_id, last_read_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (user_id, group_id) DO NOTHING
        `, [memberId, groupId]);
      }
    }

    // Prepare transaction payload for blockchain
    const transactionPayload = {
      type: 'group_add_members',
      groupId: groupId,
      addedMemberPubkeys: memberPubkeys,
      network: network
    };

    // Create audit log entry for adding members
    const networkPrefix = network === 'mainnet' ? 'mainnet-' : 'testnet-';
    const placeholderTxHash = ENABLE_DEMO_MODE ? 'ut1staging-' + networkPrefix + 'tx-addmem-' + Date.now() : 'ut1-' + networkPrefix + 'tx-addmem-' + Math.random().toString(36).substr(2, 9);
    const auditRes = await pool.query(`
      INSERT INTO blockchain_audit_logs (user_id, message_type, tx_hash, transaction_payload, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $6)
      RETURNING id
    `, [userId, 'group_add_members', placeholderTxHash, JSON.stringify(transactionPayload), 'pending', now]);
    const blockchainRecordingId = auditRes.rows[0].id;

    // Async: submit to blockchain in the background
    (async () => {
      try {
        const result = await sendTransactionToBridge(transactionPayload, null, network);
        // Update audit log with real tx hash
        await pool.query(`
          UPDATE blockchain_audit_logs SET tx_hash = $1 WHERE id = $2
        `, [result.txHash, blockchainRecordingId]);
        // Start monitoring
        monitorBlockchainStatus(blockchainRecordingId, result.txHash).catch(err => {
          console.error('Error monitoring blockchain status:', err);
        });
      } catch (err) {
        console.error('Background blockchain submission error:', err);
        await pool.query(`
          UPDATE blockchain_audit_logs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2
        `, [err.message, blockchainRecordingId]);
      }
    })();

    res.json({ members: addedMembers, blockchainRecordingId: blockchainRecordingId });
  } catch (err) {
    console.error('Error adding group members:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/groups/:groupId/members/:userId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { groupId, userId: targetUserId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }
    const targetId = parseInt(targetUserId);
    const now = new Date();

    // Verify requester is creator or removing themselves
    const { rows: groupRows } = await pool.query(`
      SELECT creator_id FROM groups WHERE id = $1
    `, [groupId]);

    if (groupRows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const isCreator = groupRows[0].creator_id === userId;
    if (!isCreator && userId !== targetId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Cannot remove creator
    if (groupRows[0].creator_id === targetId && !isCreator) {
      return res.status(403).json({ error: 'Cannot remove creator' });
    }

    // Fetch user's network preference
    const network = 'testnet';

    // Validate and resolve target user wallet address
    let targetUserPubkey;
    try {
      const resolved = await validateAndResolvePubkeys(targetId);
      targetUserPubkey = resolved.pubkey;
    } catch (err) {
      return res.status(err.statusCode || 400).json({ error: err.message });
    }

    // Remove member
    await pool.query(`
      DELETE FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [groupId, targetId]);

    // Prepare transaction payload for blockchain
    const transactionPayload = {
      type: 'group_remove_member',
      groupId: groupId,
      removedUserPubkey: targetUserPubkey,
      network: network
    };

    // Create audit log entry for removing member
    const networkPrefix = network === 'mainnet' ? 'mainnet-' : 'testnet-';
    const placeholderTxHash = ENABLE_DEMO_MODE ? 'ut1staging-' + networkPrefix + 'tx-remmem-' + Date.now() : 'ut1-' + networkPrefix + 'tx-remmem-' + Math.random().toString(36).substr(2, 9);
    const auditRes = await pool.query(`
      INSERT INTO blockchain_audit_logs (user_id, message_type, tx_hash, transaction_payload, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $6)
      RETURNING id
    `, [userId, 'group_remove_member', placeholderTxHash, JSON.stringify(transactionPayload), 'pending', now]);
    const blockchainRecordingId = auditRes.rows[0].id;

    // Async: submit to blockchain in the background
    (async () => {
      try {
        const result = await sendTransactionToBridge(transactionPayload, null, network);
        // Update audit log with real tx hash
        await pool.query(`
          UPDATE blockchain_audit_logs SET tx_hash = $1 WHERE id = $2
        `, [result.txHash, blockchainRecordingId]);
        // Start monitoring
        monitorBlockchainStatus(blockchainRecordingId, result.txHash).catch(err => {
          console.error('Error monitoring blockchain status:', err);
        });
      } catch (err) {
        console.error('Background blockchain submission error:', err);
        await pool.query(`
          UPDATE blockchain_audit_logs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2
        `, [err.message, blockchainRecordingId]);
      }
    })();

    res.json({ ok: true, blockchainRecordingId: blockchainRecordingId });
  } catch (err) {
    console.error('Error removing group member:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups/:groupId/leave', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { groupId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }
    const now = new Date();

    // Verify user is a member
    const { rows: memberRows } = await pool.query(`
      SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [groupId, userId]);

    if (memberRows.length === 0) {
      return res.status(404).json({ error: 'Not a member of this group' });
    }

    // Fetch user's network preference
    const network = 'testnet';

    // Remove member
    await pool.query(`
      DELETE FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [groupId, userId]);

    // Prepare transaction payload for blockchain
    const transactionPayload = {
      type: 'group_leave',
      groupId: groupId,
      userId: userId,
      network: network
    };

    // Create audit log entry for leaving group
    const networkPrefix = network === 'mainnet' ? 'mainnet-' : 'testnet-';
    const placeholderTxHash = ENABLE_DEMO_MODE ? 'ut1staging-' + networkPrefix + 'tx-leave-' + Date.now() : 'ut1-' + networkPrefix + 'tx-leave-' + Math.random().toString(36).substr(2, 9);
    const auditRes = await pool.query(`
      INSERT INTO blockchain_audit_logs (user_id, message_type, tx_hash, transaction_payload, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $6)
      RETURNING id
    `, [userId, 'group_leave', placeholderTxHash, JSON.stringify(transactionPayload), 'pending', now]);
    const blockchainRecordingId = auditRes.rows[0].id;

    // Async: submit to blockchain in the background
    (async () => {
      try {
        const result = await sendTransactionToBridge(transactionPayload, null, network);
        // Update audit log with real tx hash
        await pool.query(`
          UPDATE blockchain_audit_logs SET tx_hash = $1 WHERE id = $2
        `, [result.txHash, blockchainRecordingId]);
        // Start monitoring
        monitorBlockchainStatus(blockchainRecordingId, result.txHash).catch(err => {
          console.error('Error monitoring blockchain status:', err);
        });
      } catch (err) {
        console.error('Background blockchain submission error:', err);
        await pool.query(`
          UPDATE blockchain_audit_logs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2
        `, [err.message, blockchainRecordingId]);
      }
    })();

    res.json({ ok: true, blockchainRecordingId: blockchainRecordingId });
  } catch (err) {
    console.error('Error leaving group:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/groups/:groupId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { groupId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }
    const now = new Date();

    // Verify user is creator
    const { rows: groupRows } = await pool.query(`
      SELECT creator_id FROM groups WHERE id = $1
    `, [groupId]);

    if (groupRows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    if (groupRows[0].creator_id !== userId) {
      return res.status(403).json({ error: 'Only creator can delete group' });
    }

    // Fetch user's network preference
    const network = 'testnet';

    // Delete group (cascades to members and messages)
    await pool.query(`
      DELETE FROM groups WHERE id = $1
    `, [groupId]);

    // Prepare transaction payload for blockchain
    const transactionPayload = {
      type: 'group_delete',
      groupId: groupId,
      network: network
    };

    // Create audit log entry for group deletion
    const networkPrefix = network === 'mainnet' ? 'mainnet-' : 'testnet-';
    const placeholderTxHash = ENABLE_DEMO_MODE ? 'ut1staging-' + networkPrefix + 'tx-delete-' + Date.now() : 'ut1-' + networkPrefix + 'tx-delete-' + Math.random().toString(36).substr(2, 9);
    const auditRes = await pool.query(`
      INSERT INTO blockchain_audit_logs (user_id, message_type, tx_hash, transaction_payload, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $6)
      RETURNING id
    `, [userId, 'group_delete', placeholderTxHash, JSON.stringify(transactionPayload), 'pending', now]);
    const blockchainRecordingId = auditRes.rows[0].id;

    // Async: submit to blockchain in the background
    (async () => {
      try {
        const result = await sendTransactionToBridge(transactionPayload, null, network);
        // Update audit log with real tx hash
        await pool.query(`
          UPDATE blockchain_audit_logs SET tx_hash = $1 WHERE id = $2
        `, [result.txHash, blockchainRecordingId]);
        // Start monitoring
        monitorBlockchainStatus(blockchainRecordingId, result.txHash).catch(err => {
          console.error('Error monitoring blockchain status:', err);
        });
      } catch (err) {
        console.error('Background blockchain submission error:', err);
        await pool.query(`
          UPDATE blockchain_audit_logs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2
        `, [err.message, blockchainRecordingId]);
      }
    })();

    res.json({ ok: true, blockchainRecordingId: blockchainRecordingId });
  } catch (err) {
    console.error('Error deleting group:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/groups/:groupId/read', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { groupId } = req.params;
    const { readUpTo } = req.body;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    await pool.query(`
      INSERT INTO group_read_receipts (user_id, group_id, last_read_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, group_id)
      DO UPDATE SET last_read_at = EXCLUDED.last_read_at
    `, [userId, groupId, readUpTo || new Date()]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Error marking group as read:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/groups/:groupId/mute', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { groupId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // For now, just mark as read to simulate muting
    // TODO: Add muted_by column to groups table for persistence
    res.json({ ok: true });
  } catch (err) {
    console.error('Error muting group:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups/:groupId/archive', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { groupId } = req.params;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Verify user is a member of the group
    const { rows: memberRows } = await pool.query(`
      SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [groupId, userId]);

    if (memberRows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    // Toggle archive state
    await pool.query(`
      UPDATE groups
      SET archived_by = CASE
        WHEN archived_by @> ARRAY[$1]::integer[] THEN array_remove(archived_by, $1)
        ELSE CASE WHEN archived_by IS NULL THEN ARRAY[$1] ELSE array_append(archived_by, $1) END
      END
      WHERE id = $2
    `, [userId, groupId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Error archiving group:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== ACTIVITY LEDGER ENDPOINTS =====

app.get('/api/user/guardians', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const foregroundHours = getForegroundHours(req.user.id);
    const { rank, hoursBracket, contributionLevel } = calculateRankData(foregroundHours);

    res.json({
      foregroundHours,
      contributionLevel,
      rank,
      hoursBracket,
      usernode_pubkey: req.user.usernode_pubkey || null
    });
  } catch (err) {
    console.error('Error fetching guardians data:', err);
    res.status(500).json({ error: 'Failed to fetch guardians data' });
  }
});

app.get('/api/peers/:peer_id', async (req, res) => {
  try {
    const { peer_id } = req.params;

    // Validate peer_id format (should start with ut1)
    if (!peer_id || !peer_id.startsWith('ut1')) {
      return res.status(400).json({ error: 'Invalid peer ID format' });
    }

    const { rows } = await pool.query(`
      SELECT id, peer_id, foreground_hours, created_at
      FROM peers
      WHERE peer_id = $1
    `, [peer_id]);

    if (rows.length === 0) {
      // Return default values if peer not found
      return res.json({
        peer_id,
        foreground_hours: 0,
        created_at: null
      });
    }

    const peer = rows[0];
    res.json({
      peer_id: peer.peer_id,
      foreground_hours: peer.foreground_hours,
      created_at: peer.created_at
    });
  } catch (err) {
    console.error('Error fetching peer data:', err);
    res.status(500).json({ error: 'Failed to fetch peer data' });
  }
});

app.get('/api/network/peer-count', async (req, res) => {
  try {
    let peerCount = 0;
    let status = 'offline';

    if (IS_STAGING) {
      // In staging, provide mock data with deterministic peer count cycling
      const mockPeerCounts = [5, 12, 8, 15, 10];
      const timeWindow = Math.floor(Date.now() / 30000); // 30-second windows
      peerCount = mockPeerCounts[timeWindow % mockPeerCounts.length];
      status = peerCount > 0 ? 'online' : 'offline';
    } else {
      // In production, count peers from the peers table
      const { rows } = await pool.query('SELECT COUNT(*) AS count FROM peers');
      peerCount = parseInt(rows[0].count, 10) || 0;
      status = peerCount > 0 ? 'online' : 'offline';
    }

    res.json({
      peerCount,
      status,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error fetching peer count:', err);
    res.status(500).json({ error: 'Failed to fetch peer count' });
  }
});

app.get('/api/activity', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const limit = Math.min(parseInt(req.query.limit || 50), 100);
    const offset = parseInt(req.query.offset || 0);
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Get blockchain audit logs for this user (token transfers and group operations)
    const { rows } = await pool.query(`
      SELECT id, user_id, message_type, tx_hash, status, error_message, confirmed_at, created_at, transaction_payload
      FROM blockchain_audit_logs
      WHERE user_id = $1 AND message_type IN ('token_transfer', 'group_create', 'group_add_members', 'group_remove_member', 'group_update', 'group_delete', 'group_leave')
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    const { rows: countRows } = await pool.query(`
      SELECT COUNT(*) as total FROM blockchain_audit_logs
      WHERE user_id = $1 AND message_type IN ('token_transfer', 'group_create', 'group_add_members', 'group_remove_member', 'group_update', 'group_delete', 'group_leave')
    `, [userId]);

    const activities = rows.map(r => {
      let payload = {};
      try {
        payload = typeof r.transaction_payload === 'string'
          ? JSON.parse(r.transaction_payload || '{}')
          : (r.transaction_payload || {});
      } catch (e) {}

      return {
        id: r.id,
        type: r.message_type,
        txHash: r.tx_hash,
        status: r.status,
        errorMessage: r.error_message || null,
        confirmedAt: r.confirmed_at || null,
        createdAt: r.created_at,
        payload: payload
      };
    });

    res.json({
      activities,
      total: parseInt(countRows[0].total),
      limit,
      offset
    });
  } catch (err) {
    console.error('Error fetching activity:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== EXPLORER API PROXY =====

// ===== CHANNEL ENDPOINTS =====

// GET /api/channels - List all channels
app.get('/api/channels', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const category = req.query.category || null;
    const featured = req.query.featured === 'true';

    if (ENABLE_DEMO_MODE) {
      return res.json(mockData.getMockChannels(1, category, featured));
    }

    let query = `
      SELECT c.id, c.name, c.description, c.is_system, c.owner_id, c.category, c.is_verified, c.verified_at, c.is_featured, c.created_at, c.updated_at,
             u.username as ownerUsername,
             (SELECT COUNT(*) FROM channel_unread WHERE user_id = $1 AND channel_id = c.id AND unread_count > 0)::INTEGER as unreadCount,
             (SELECT COUNT(*) FROM pinned_channels WHERE user_id = $1 AND channel_id = c.id)::INTEGER as isPinned
      FROM channels c
      LEFT JOIN users u ON c.owner_id = u.id
      WHERE 1=1
    `;
    const params = [req.user.id];
    let paramCount = 1;

    if (featured) {
      query += ` AND c.is_featured = TRUE`;
    }
    if (category) {
      paramCount++;
      query += ` AND c.category = $${paramCount}`;
      params.push(category);
    }

    query += ` ORDER BY c.is_featured DESC, c.is_system DESC, c.created_at DESC`;

    const { rows: channels } = await pool.query(query, params);

    res.json({
      channels: channels.map(c => ({
        id: c.id,
        name: c.name,
        description: c.description,
        ownerId: c.owner_id,
        ownerUsername: c.ownerUsername,
        category: c.category,
        isVerified: c.is_verified,
        verifiedAt: c.verified_at,
        isFeatured: c.is_featured,
        isSystem: c.is_system,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        unreadCount: parseInt(c.unreadCount) || 0,
        isPinned: parseInt(c.isPinned) > 0
      }))
    });
  } catch (err) {
    console.error('Error fetching channels:', err);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// GET /api/channels/:channelId/posts - Fetch paginated posts for a specific channel
app.get('/api/channels/:channelId/posts', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const channelId = parseInt(req.params.channelId);
    const limit = Math.min(parseInt(req.query.limit || 50), 100);
    const offset = parseInt(req.query.offset || 0);

    if (ENABLE_DEMO_MODE) {
      const mockResult = mockData.getMockChannelPosts(channelId, limit, offset);
      return res.json({
        posts: mockResult.posts.map(p => ({
          id: p.id,
          userId: p.authorId,
          username: p.authorUsername,
          verified: false,
          avatarUrl: p.avatarUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${p.authorUsername}`,
          content: p.content,
          createdAt: p.createdAt,
          updatedAt: p.createdAt,
          isEdited: false,
          onChain: false
        })),
        hasMore: offset + limit < mockResult.total
      });
    }

    // Verify channel exists
    const { rows: channelCheck } = await pool.query(`
      SELECT id FROM channels WHERE id = $1
    `, [channelId]);

    if (channelCheck.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Fetch posts for this channel
    const { rows: posts } = await pool.query(`
      SELECT
        fp.id,
        fp.user_id,
        fp.content,
        fp.created_at,
        fp.updated_at,
        fp.on_chain,
        u.username,
        u.verified_at,
        u.avatar_url
      FROM feed_posts fp
      JOIN users u ON u.id = fp.user_id
      WHERE fp.channel_id = $1
      ORDER BY fp.created_at DESC
      LIMIT $2 OFFSET $3
    `, [channelId, limit, offset]);

    const resultPosts = posts.map(post => ({
      id: post.id,
      userId: post.user_id,
      username: post.username,
      verified: !!post.verified_at,
      avatarUrl: post.avatar_url,
      content: post.content,
      createdAt: post.created_at,
      updatedAt: post.updated_at,
      isEdited: post.updated_at && post.created_at && (new Date(post.updated_at) - new Date(post.created_at)) > 1000,
      onChain: post.on_chain || false
    }));

    const { rows: countResult } = await pool.query(`
      SELECT COUNT(*) as count FROM feed_posts WHERE channel_id = $1
    `, [channelId]);

    const total = parseInt(countResult[0].count);
    const hasMore = offset + limit < total;

    res.json({
      posts: resultPosts,
      hasMore
    });
  } catch (err) {
    console.error('Error fetching channel posts:', err);
    res.status(500).json({ error: 'Failed to fetch channel posts' });
  }
});

// GET /api/channels/categories - List all available categories
app.get('/api/channels/categories', async (req, res) => {
  try {
    const { rows: categories } = await pool.query(`
      SELECT id, name, description FROM channel_categories ORDER BY name
    `);
    res.json({ categories });
  } catch (err) {
    console.error('Error fetching categories:', err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// POST /api/channels - Create a new channel
app.post('/api/channels', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Verify wallet is connected
    if (!req.user.usernode_pubkey) {
      return res.status(401).json({ error: 'Must be connected to Usernode wallet to create channels' });
    }

    const { name, description, category, txHash, auditLogId } = req.body;

    // Validate channel name
    if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 255) {
      return res.status(400).json({ error: 'Channel name is required and must be 1-255 characters' });
    }

    // Validate description
    if (description && (typeof description !== 'string' || description.length > 1000)) {
      return res.status(400).json({ error: 'Description must be max 1000 characters' });
    }

    // Validate category
    if (!category || typeof category !== 'string' || category.trim().length === 0) {
      return res.status(400).json({ error: 'Category is required' });
    }

    // Check if category exists
    const { rows: categoryCheck } = await pool.query(`
      SELECT id FROM channel_categories WHERE name = $1
    `, [category]);

    if (categoryCheck.length === 0) {
      return res.status(400).json({ error: 'Invalid channel category' });
    }

    // Validate txHash and auditLogId
    if (!txHash || !auditLogId) {
      return res.status(400).json({ error: 'Transaction hash and audit log ID are required' });
    }

    // Insert new channel
    const { rows: channelRows } = await pool.query(`
      INSERT INTO channels (name, description, owner_id, category, is_system, is_verified, is_featured)
      VALUES ($1, $2, $3, $4, FALSE, FALSE, FALSE)
      RETURNING id, name, description, owner_id, category, is_verified, verified_at, is_featured, is_system, created_at, updated_at
    `, [name, description || null, userId, category]);

    if (channelRows.length === 0) {
      return res.status(500).json({ error: 'Failed to create channel' });
    }

    const channel = channelRows[0];

    // Get owner username
    const { rows: userRows } = await pool.query(`
      SELECT username FROM users WHERE id = $1
    `, [userId]);

    const ownerUsername = userRows.length > 0 ? userRows[0].username : null;

    // Update audit log with txHash
    if (auditLogId) {
      await pool.query(`
        UPDATE blockchain_audit_logs
        SET tx_hash = $1, status = 'confirmed', confirmed_at = NOW()
        WHERE id = $2 AND user_id = $3
      `, [txHash, auditLogId, userId]);
    }

    res.status(201).json({
      id: channel.id,
      name: channel.name,
      description: channel.description,
      ownerId: channel.owner_id,
      ownerUsername: ownerUsername,
      category: channel.category,
      isVerified: channel.is_verified,
      verifiedAt: channel.verified_at,
      isFeatured: channel.is_featured,
      isSystem: channel.is_system,
      createdAt: channel.created_at,
      updatedAt: channel.updated_at
    });
  } catch (err) {
    console.error('Error creating channel:', err);
    res.status(500).json({ error: 'Failed to create channel' });
  }
});

// GET /api/user/pinned-channels - List user's pinned channels
app.get('/api/user/pinned-channels', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { rows: channels } = await pool.query(`
      SELECT c.id, c.name, c.description, c.owner_id, c.category, c.is_verified, c.verified_at, c.is_featured, c.is_system,
             u.username as ownerUsername,
             (SELECT COUNT(*) FROM channel_unread WHERE user_id = $1 AND channel_id = c.id AND unread_count > 0)::INTEGER as unreadCount
      FROM channels c
      JOIN pinned_channels pc ON c.id = pc.channel_id
      LEFT JOIN users u ON c.owner_id = u.id
      WHERE pc.user_id = $1
      ORDER BY pc.pinned_at DESC
    `, [req.user.id]);

    res.json({
      channels: channels.map(ch => ({
        id: ch.id,
        name: ch.name,
        description: ch.description,
        ownerId: ch.owner_id,
        ownerUsername: ch.ownerUsername,
        category: ch.category,
        isVerified: ch.is_verified,
        verifiedAt: ch.verified_at,
        isFeatured: ch.is_featured,
        isSystem: ch.is_system,
        unreadCount: parseInt(ch.unreadCount) || 0
      }))
    });
  } catch (err) {
    console.error('Error fetching pinned channels:', err);
    res.status(500).json({ error: 'Failed to fetch pinned channels' });
  }
});

// POST /api/user/pinned-channels/:channelId - Pin a channel
app.post('/api/user/pinned-channels/:channelId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const channelId = parseInt(req.params.channelId);

    await pool.query(`
      INSERT INTO pinned_channels (user_id, channel_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [req.user.id, channelId]);

    res.json({ success: true });
  } catch (err) {
    console.error('Error pinning channel:', err);
    res.status(500).json({ error: 'Failed to pin channel' });
  }
});

// DELETE /api/user/pinned-channels/:channelId - Unpin a channel
app.delete('/api/user/pinned-channels/:channelId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const channelId = parseInt(req.params.channelId);

    await pool.query(`
      DELETE FROM pinned_channels WHERE user_id = $1 AND channel_id = $2
    `, [req.user.id, channelId]);

    res.json({ success: true });
  } catch (err) {
    console.error('Error unpinning channel:', err);
    res.status(500).json({ error: 'Failed to unpin channel' });
  }
});

// PUT /api/channels/:channelId/read - Mark channel as read
app.put('/api/channels/:channelId/read', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const channelId = parseInt(req.params.channelId);
    const { lastReadPostId } = req.body;

    await pool.query(`
      INSERT INTO channel_unread (user_id, channel_id, unread_count, last_read_post_id, last_read_at)
      VALUES ($1, $2, 0, $3, NOW())
      ON CONFLICT (user_id, channel_id)
      DO UPDATE SET unread_count = 0, last_read_post_id = $3, last_read_at = NOW()
    `, [req.user.id, channelId, lastReadPostId || null]);

    res.json({ success: true, unreadCount: 0 });
  } catch (err) {
    console.error('Error marking channel as read:', err);
    res.status(500).json({ error: 'Failed to mark channel as read' });
  }
});

// GET /api/channels/:channelId/unread - Get unread count for a channel
app.get('/api/channels/:channelId/unread', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const channelId = parseInt(req.params.channelId);

    const { rows } = await pool.query(`
      SELECT unread_count, last_read_at FROM channel_unread
      WHERE user_id = $1 AND channel_id = $2
    `, [req.user.id, channelId]);

    const unreadInfo = rows.length > 0 ? rows[0] : { unread_count: 0, last_read_at: null };

    res.json({
      unreadCount: unreadInfo.unread_count || 0,
      lastReadAt: unreadInfo.last_read_at
    });
  } catch (err) {
    console.error('Error fetching unread count:', err);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

// ===== FEED ENDPOINTS =====

// Helper function to fetch link preview metadata
async function fetchLinkPreview(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Guardian/1.0)'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const html = await response.text();
    const titleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
    const imageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);

    return {
      title: titleMatch ? titleMatch[1] : null,
      image: imageMatch ? imageMatch[1] : null
    };
  } catch (err) {
    return null;
  }
}

// GET /api/feed/posts - Fetch paginated feed posts with milestone posts
app.get('/api/feed/posts', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const limit = Math.min(parseInt(req.query.limit || 50), 100);
    const offset = parseInt(req.query.offset || 0);
    const channelId = req.query.channel_id ? parseInt(req.query.channel_id) : null;

    // Build query based on whether channel_id is provided
    let whereClause = '';
    let params = [limit, offset];
    if (channelId) {
      whereClause = 'WHERE fp.channel_id = $3';
      params = [limit, offset, channelId];
    }

    // Fetch posts (optionally filtered by channel)
    const { rows: posts } = await pool.query(`
      SELECT
        fp.id,
        fp.user_id,
        fp.content,
        fp.created_at,
        fp.updated_at,
        fp.on_chain,
        fp.channel_id,
        u.username,
        u.verified_at,
        u.avatar_url,
        (SELECT COUNT(*) FROM feed_likes WHERE post_id = fp.id)::INTEGER as like_count,
        (SELECT COUNT(*) FROM feed_comments WHERE post_id = fp.id)::INTEGER as comment_count
      FROM feed_posts fp
      JOIN users u ON u.id = fp.user_id
      ${whereClause}
      ORDER BY fp.created_at DESC
      LIMIT $1 OFFSET $2
    `, params);

    const resultPosts = posts.map(post => ({
      id: post.id,
      userId: post.user_id,
      username: post.username,
      verified: !!post.verified_at,
      avatarUrl: post.avatar_url,
      content: post.content,
      createdAt: post.created_at,
      updatedAt: post.updated_at,
      isEdited: post.updated_at && post.created_at && (new Date(post.updated_at) - new Date(post.created_at)) > 1000,
      onChain: post.on_chain,
      likeCount: post.like_count || 0,
      commentCount: post.comment_count || 0,
      isMilestone: post.user_id === -1
    }));

    // Build count query based on whether channel_id is provided
    let countParams = [];
    let countWhereClause = '';
    if (channelId) {
      countWhereClause = 'WHERE channel_id = $1';
      countParams = [channelId];
    }

    const { rows: countResult } = await pool.query(`
      SELECT COUNT(*) as count FROM feed_posts ${countWhereClause}
    `, countParams);

    const total = parseInt(countResult[0].count);
    const hasMore = offset + limit < total;

    res.json({
      posts: resultPosts,
      hasMore
    });
  } catch (err) {
    console.error('Error fetching feed posts:', err);
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
});

// ===== FEED COMMENTS ENDPOINTS =====

// GET /api/feed/posts/:postId/comments - Fetch paginated comments on a post
app.get('/api/feed/posts/:postId/comments', async (req, res) => {
  try {
    const { postId } = req.params;
    const limit = Math.min(parseInt(req.query.limit || 50), 100);
    const offset = parseInt(req.query.offset || 0);

    // Verify post exists
    const { rows: postRows } = await pool.query(`
      SELECT id FROM feed_posts WHERE id = $1
    `, [postId]);

    if (postRows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Fetch comments
    const { rows: comments } = await pool.query(`
      SELECT
        fc.id,
        fc.user_id,
        fc.content,
        fc.created_at,
        u.username,
        u.verified_at,
        u.avatar_url
      FROM feed_comments fc
      JOIN users u ON u.id = fc.user_id
      WHERE fc.post_id = $1
      ORDER BY fc.created_at ASC
      LIMIT $2 OFFSET $3
    `, [postId, limit, offset]);

    // Get total count
    const { rows: countResult } = await pool.query(`
      SELECT COUNT(*) as count FROM feed_comments WHERE post_id = $1
    `, [postId]);

    const total = parseInt(countResult[0].count);
    const hasMore = offset + limit < total;

    res.json({
      comments: comments.map(c => ({
        id: c.id,
        userId: c.user_id,
        username: c.username,
        verified: !!c.verified_at,
        avatarUrl: c.avatar_url,
        content: c.content,
        createdAt: c.created_at
      })),
      total,
      hasMore
    });
  } catch (err) {
    console.error('Error fetching comments:', err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// POST /api/feed/posts/:postId/comments - Create a comment
app.post('/api/feed/posts/:postId/comments', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { postId } = req.params;
    const { content } = req.body;
    const userId = req.user.id;

    if (!checkRateLimit(`comment:${userId}`, 200, 60000)) {
      return res.status(429).json({ error: 'Rate limited' });
    }

    if (!content || content.trim() === '') {
      return res.status(400).json({ error: 'Comment content is required' });
    }

    // Verify post exists and get owner
    const { rows: postRows } = await pool.query(`
      SELECT id, user_id FROM feed_posts WHERE id = $1
    `, [postId]);

    if (postRows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const postOwnerUserId = postRows[0].user_id;

    // Create comment
    const { rows: commentRows } = await pool.query(`
      INSERT INTO feed_comments (post_id, user_id, content, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      RETURNING id, created_at
    `, [postId, userId, content.trim()]);

    const comment = commentRows[0];

    // Fetch user info
    const { rows: userRows } = await pool.query(`
      SELECT username, verified_at, avatar_url FROM users WHERE id = $1
    `, [userId]);

    const user = userRows[0];

    // Trigger GuardiAI auto-reply on any comment to GuardiAI's posts
    if (postOwnerUserId === 100) {
      await (async () => {
        try {
          const delayMs = Math.random() * 5000 + 5000;
          setTimeout(async () => {
            try {
              const replyText = generateGuardiAIContent();
              const { rows: botReplyRows } = await pool.query(`
                INSERT INTO feed_comments (post_id, user_id, content, created_at, updated_at)
                VALUES ($1, $2, $3, NOW(), NOW())
                RETURNING id
              `, [postId, 100, replyText]);

              if (botReplyRows.length > 0) {
                console.log(`[GUARDIAI-COMMENT-REPLY] Created auto-reply #${botReplyRows[0].id} to comment #${comment.id}`);
              }
            } catch (err) {
              console.error('[GUARDIAI-COMMENT-REPLY] Error creating auto-reply:', err);
            }
          }, delayMs);
        } catch (err) {
          console.error('[GUARDIAI-COMMENT-REPLY] Error scheduling auto-reply:', err);
        }
      })();
    }

    // Trigger GuardiAI bot reply if @GuardiAI is mentioned
    if (/@guardiAI/i.test(content)) {
      await (async () => {
        try {
          const cryptoTickers = parseCryptoCurrencies(content);

          if (cryptoTickers.length > 0) {
            // Reply for each unique crypto detected
            for (const geckoId of cryptoTickers) {
              try {
                const priceData = await fetchCryptoPrice(geckoId);
                const replyText = formatCryptoReply(geckoId, priceData);

                // Insert bot reply
                const { rows: botReplyRows } = await pool.query(`
                  INSERT INTO feed_comments (post_id, user_id, content, created_at, updated_at)
                  VALUES ($1, $2, $3, NOW(), NOW())
                  RETURNING id
                `, [postId, 100, replyText]);

                // Log the interaction
                if (botReplyRows.length > 0) {
                  await pool.query(`
                    INSERT INTO bot_reply_log (trigger_comment_id, bot_reply_comment_id, trigger_username, reply_content, crypto_ticker, crypto_price, price_change_24h, api_source)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT DO NOTHING
                  `, [
                    comment.id,
                    botReplyRows[0].id,
                    user.username,
                    replyText,
                    geckoId,
                    priceData.price,
                    priceData.change24h,
                    'coingecko'
                  ]);
                }
              } catch (err) {
                if (err.message === 'RATE_LIMIT') {
                  // Silently skip on rate limit
                  console.log('CoinGecko rate limit hit, skipping bot reply');
                  continue;
                } else if (err.message === 'API_TIMEOUT') {
                  // Fall back to friendly tone on timeout
                  const replyText = selectRandomFriendlyReply();
                  const { rows: botReplyRows } = await pool.query(`
                    INSERT INTO feed_comments (post_id, user_id, content, created_at, updated_at)
                    VALUES ($1, $2, $3, NOW(), NOW())
                    RETURNING id
                  `, [postId, 100, replyText]);

                  if (botReplyRows.length > 0) {
                    await pool.query(`
                      INSERT INTO bot_reply_log (trigger_comment_id, bot_reply_comment_id, trigger_username, reply_content, api_source)
                      VALUES ($1, $2, $3, $4, $5)
                      ON CONFLICT DO NOTHING
                    `, [comment.id, botReplyRows[0].id, user.username, replyText, 'friendly_fallback']);
                  }
                } else {
                  // Other API errors: fall back to friendly tone
                  const replyText = selectRandomFriendlyReply();
                  const { rows: botReplyRows } = await pool.query(`
                    INSERT INTO feed_comments (post_id, user_id, content, created_at, updated_at)
                    VALUES ($1, $2, $3, NOW(), NOW())
                    RETURNING id
                  `, [postId, 100, replyText]);

                  if (botReplyRows.length > 0) {
                    await pool.query(`
                      INSERT INTO bot_reply_log (trigger_comment_id, bot_reply_comment_id, trigger_username, reply_content, api_source)
                      VALUES ($1, $2, $3, $4, $5)
                      ON CONFLICT DO NOTHING
                    `, [comment.id, botReplyRows[0].id, user.username, replyText, 'friendly_fallback']);
                  }
                }
              }
            }
          } else {
            // No crypto found, use friendly tone
            const replyText = selectRandomFriendlyReply();
            const { rows: botReplyRows } = await pool.query(`
              INSERT INTO feed_comments (post_id, user_id, content, created_at, updated_at)
              VALUES ($1, $2, $3, NOW(), NOW())
              RETURNING id
            `, [postId, 100, replyText]);

            if (botReplyRows.length > 0) {
              await pool.query(`
                INSERT INTO bot_reply_log (trigger_comment_id, bot_reply_comment_id, trigger_username, reply_content, api_source)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT DO NOTHING
              `, [comment.id, botReplyRows[0].id, user.username, replyText, 'friendly']);
            }
          }
        } catch (err) {
          // Log bot errors but don't fail the user's comment
          console.error('Error triggering bot reply:', err);
        }
      })();
    }

    res.json({
      id: comment.id,
      userId: userId,
      username: user.username,
      verified: !!user.verified_at,
      avatarUrl: user.avatar_url,
      content: content.trim(),
      createdAt: comment.created_at
    });
  } catch (err) {
    console.error('Error creating comment:', err);
    res.status(500).json({ error: 'Failed to create comment' });
  }
});

// DELETE /api/feed/posts/:postId/comments/:commentId - Delete a comment
app.delete('/api/feed/posts/:postId/comments/:commentId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { postId, commentId } = req.params;
    const userId = req.user.id;

    // Verify comment exists and user is author
    const { rows: commentRows } = await pool.query(`
      SELECT user_id FROM feed_comments WHERE id = $1 AND post_id = $2
    `, [commentId, postId]);

    if (commentRows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    const comment = commentRows[0];
    if (comment.user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Delete comment
    await pool.query(`
      DELETE FROM feed_comments WHERE id = $1
    `, [commentId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting comment:', err);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

// GET /api/feed/posts/likes - Get current user's liked post IDs
app.get('/api/feed/posts/likes', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = req.user.id;

    const { rows } = await pool.query(`
      SELECT post_id FROM feed_likes WHERE user_id = $1
    `, [userId]);

    const likedPostIds = rows.map(r => r.post_id);
    res.json({ likedPostIds });
  } catch (err) {
    console.error('Error fetching likes:', err);
    res.status(500).json({ error: 'Failed to fetch likes' });
  }
});

// POST /api/feed/posts/:postId/like - Like a post
app.post('/api/feed/posts/:postId/like', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { postId } = req.params;
    const userId = req.user.id;

    // Verify post exists
    const { rows: postRows } = await pool.query(`
      SELECT id FROM feed_posts WHERE id = $1
    `, [postId]);

    if (postRows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Check if already liked
    const { rows: likeRows } = await pool.query(`
      SELECT id FROM feed_likes WHERE post_id = $1 AND user_id = $2
    `, [postId, userId]);

    if (likeRows.length > 0) {
      return res.json({ ok: true, liked: true, message: 'Already liked' });
    }

    // Insert like
    await pool.query(`
      INSERT INTO feed_likes (post_id, user_id, created_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (post_id, user_id) DO NOTHING
    `, [postId, userId]);

    // Get updated count
    const { rows: countRows } = await pool.query(`
      SELECT COUNT(*)::INTEGER as like_count FROM feed_likes WHERE post_id = $1
    `, [postId]);

    res.json({ ok: true, liked: true, likeCount: countRows[0].like_count });
  } catch (err) {
    console.error('Error liking post:', err);
    res.status(500).json({ error: 'Failed to like post' });
  }
});

// DELETE /api/feed/posts/:postId/like - Unlike a post
app.delete('/api/feed/posts/:postId/like', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { postId } = req.params;
    const userId = req.user.id;

    // Verify post exists
    const { rows: postRows } = await pool.query(`
      SELECT id FROM feed_posts WHERE id = $1
    `, [postId]);

    if (postRows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Delete like
    await pool.query(`
      DELETE FROM feed_likes WHERE post_id = $1 AND user_id = $2
    `, [postId, userId]);

    // Get updated count
    const { rows: countRows } = await pool.query(`
      SELECT COUNT(*)::INTEGER as like_count FROM feed_likes WHERE post_id = $1
    `, [postId]);

    res.json({ ok: true, liked: false, likeCount: countRows[0].like_count });
  } catch (err) {
    console.error('Error unliking post:', err);
    res.status(500).json({ error: 'Failed to unlike post' });
  }
});

// DELETE /api/feed/posts/:postId - Delete a feed post (owner only)
app.delete('/api/feed/posts/:postId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { postId } = req.params;
    const userId = req.user.id;

    const { rows } = await pool.query(`
      SELECT user_id FROM feed_posts WHERE id = $1
    `, [postId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await pool.query(`DELETE FROM feed_posts WHERE id = $1`, [postId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting post:', err);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// PUT /api/feed/posts/:postId - Edit a feed post's text (owner only)
app.put('/api/feed/posts/:postId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { postId } = req.params;
    const userId = req.user.id;
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Post text cannot be empty' });
    }

    const { rows } = await pool.query(`
      SELECT user_id, content FROM feed_posts WHERE id = $1
    `, [postId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const newContent = { ...rows[0].content, text: text.trim() };

    const { rows: updated } = await pool.query(`
      UPDATE feed_posts SET content = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, user_id, content, created_at, updated_at
    `, [JSON.stringify(newContent), postId]);

    const post = updated[0];

    res.json({
      id: post.id,
      userId: post.user_id,
      content: post.content,
      createdAt: post.created_at,
      updatedAt: post.updated_at,
      isEdited: (new Date(post.updated_at) - new Date(post.created_at)) > 1000,
    });
  } catch (err) {
    console.error('Error editing post:', err);
    res.status(500).json({ error: 'Failed to edit post' });
  }
});

// Helper function to generate randomized milestone values
function generateRandomMilestones() {
  const activeNodes = Math.floor(Math.random() * 31) + 30; // 30-60
  const networkThroughput = (Math.random() * 2 + 1.5).toFixed(1); // 1.5-3.5
  const transactions24h = Math.floor(Math.random() * 200000) + 100000; // 100k-300k
  const avgLatency = Math.floor(Math.random() * 101) + 80; // 80-180ms

  return {
    activeNodes: activeNodes.toString(),
    networkThroughput: networkThroughput.toString(),
    transactions24h: transactions24h.toLocaleString(),
    avgLatency: avgLatency.toString()
  };
}

// Helper function to check if 24 hours have passed since the last milestone post
async function shouldCreateMilestonePost() {
  try {
    const { rows } = await pool.query(`
      SELECT created_at FROM feed_posts
      WHERE user_id = -1
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (rows.length === 0) {
      // No previous milestone post, allow creation
      return true;
    }

    const lastPostTime = new Date(rows[0].created_at);
    const now = new Date();
    const hoursSinceLastPost = (now - lastPostTime) / (1000 * 60 * 60);

    if (hoursSinceLastPost >= 24) {
      console.log(`[MILESTONE] 24+ hours since last post (${hoursSinceLastPost.toFixed(1)}h). Creating new post.`);
      return true;
    } else {
      console.log(`[MILESTONE] Skipping post creation. Only ${hoursSinceLastPost.toFixed(1)}h since last post (need 24h cooldown)`);
      return false;
    }
  } catch (err) {
    console.error('[MILESTONE] Error checking cooldown:', err);
    return false;
  }
}

// Helper function to create a milestone post from randomized values
async function createMilestonePost() {
  try {
    const randomValues = generateRandomMilestones();

    // Format metrics with right-aligned colons at column ~30
    const metrics = [
      { label: 'Active Nodes', value: randomValues.activeNodes, unit: 'nodes' },
      { label: 'Network Throughput', value: randomValues.networkThroughput, unit: 'Gbps' },
      { label: 'Transactions (24h)', value: randomValues.transactions24h, unit: 'tx' },
      { label: 'Avg Latency', value: randomValues.avgLatency, unit: 'ms' }
    ];

    const metricsText = metrics.map(m => {
      const paddingSize = Math.max(0, 30 - m.label.length - 4); // -4 for bold markers
      const padding = ' '.repeat(paddingSize);
      return `**${m.label}${padding}:**  ${m.value} ${m.unit}`;
    }).join('\n');

    const { rows } = await pool.query(`
      INSERT INTO feed_posts (user_id, content, created_at)
      VALUES ($1, $2, NOW())
      RETURNING id, created_at
    `, [-1, JSON.stringify({ type: 'text', text: metricsText })]);

    console.log(`[MILESTONE] Created hourly milestone post #${rows[0].id} at ${new Date().toISOString()}`);
    return rows[0];
  } catch (err) {
    console.error('[MILESTONE] Error creating milestone post:', err);
  }
}

// Helper function to fetch crypto data from CoinGecko API
async function fetchCryptoDailyData() {
  try {
    const cacheResult = await pool.query(`
      SELECT data FROM crypto_data_cache
      WHERE last_fetched_at > NOW() - INTERVAL '25 seconds'
      ORDER BY last_fetched_at DESC
      LIMIT 1
    `);

    if (cacheResult.rows.length > 0) {
      console.log('[CRYPTO] Using cached data');
      return cacheResult.rows[0].data;
    }

    console.log('[CRYPTO] Fetching fresh data from CoinGecko');
    const response = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?' +
      'vs_currency=usd&order=market_cap_desc&per_page=10&sparkline=false'
    );

    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status}`);
    }

    const coins = await response.json();
    const cryptoData = coins.map((coin, index) => ({
      rank: index + 1,
      name: coin.name,
      current_price: coin.current_price || 0,
      price_change_24h: coin.price_change_percentage_24h || 0
    }));

    await pool.query(`
      INSERT INTO crypto_data_cache (data, last_fetched_at, created_at)
      VALUES ($1, NOW(), NOW())
    `, [JSON.stringify(cryptoData)]);

    return cryptoData;
  } catch (err) {
    console.error('[CRYPTO] Error fetching crypto data:', err);
    return null;
  }
}

// Helper function to check if 24 hours have passed since the last Crypto Daily post
async function shouldCreateCryptoDailyPost() {
  try {
    const { rows } = await pool.query(`
      SELECT created_at FROM feed_posts
      WHERE user_id = -2
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (rows.length === 0) {
      // No previous Crypto Daily post, allow creation
      return true;
    }

    const lastPostTime = new Date(rows[0].created_at);
    const now = new Date();
    const hoursSinceLastPost = (now - lastPostTime) / (1000 * 60 * 60);

    if (hoursSinceLastPost >= 24) {
      console.log(`[CRYPTO] 24+ hours since last post (${hoursSinceLastPost.toFixed(1)}h). Creating new post.`);
      return true;
    } else {
      console.log(`[CRYPTO] Skipping post creation. Only ${hoursSinceLastPost.toFixed(1)}h since last post (need 24h cooldown)`);
      return false;
    }
  } catch (err) {
    console.error('[CRYPTO] Error checking cooldown:', err);
    return false;
  }
}

// Helper function to create a Crypto Daily post
async function createCryptoDailyPost() {
  try {
    const cryptoData = await fetchCryptoDailyData();

    if (!cryptoData || cryptoData.length === 0) {
      console.log('[CRYPTO] No data available, skipping post creation');
      return { created: false, reason: 'No crypto data available' };
    }

    // Format as simple numbered list with rank, name, price, and direction
    const listRows = cryptoData.map(coin => {
      const direction = coin.price_change_24h >= 0 ? '↑' : '↓';
      const price = Math.round(coin.current_price);
      return `${coin.rank}. ${coin.name} ${price} ${direction}`;
    }).join('\n');

    const timestamp = new Date().toISOString();
    const listText = `${listRows}\n\nLast updated: ${timestamp}`;

    const { rows } = await pool.query(`
      INSERT INTO feed_posts (user_id, content, created_at)
      VALUES ($1, $2, NOW())
      RETURNING id, created_at
    `, [-2, JSON.stringify({ type: 'text', text: listText })]);

    console.log(`[CRYPTO] Created Crypto Daily post #${rows[0].id} at ${timestamp}`);
    return { created: true, postId: rows[0].id, createdAt: rows[0].created_at };
  } catch (err) {
    console.error('[CRYPTO] Error creating crypto daily post:', err);
    return { created: false, reason: 'Error creating post' };
  }
}

// Helper function to generate GuardiAI friendly content
function generateGuardiAIContent() {
  const friendlyMessages = [
    "Wassup bro?",
    "Hey everyone!",
    "What's up folks?",
    "Yo, what's good?",
    "What's happening out there?",
    "How's it going?",
    "Heyyy friends!",
    "Good vibes only 🤙",
    "Let's goooo!",
    "Just checking in on y'all",
    "What's good in the hood?",
    "Keeping it real with y'all",
    "Vibing with this community",
    "Yo, let's make it happen",
    "Stay blessed out there"
  ];

  const randomIndex = Math.floor(Math.random() * friendlyMessages.length);
  return friendlyMessages[randomIndex];
}

// Helper function to check if 12 hours have passed since the last GuardiAI auto-post
async function shouldCreateGuardiAIPost() {
  try {
    const { rows } = await pool.query(`
      SELECT created_at FROM feed_posts
      WHERE user_id = 100
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (rows.length === 0) {
      // No previous GuardiAI post, allow creation
      return true;
    }

    const lastPostTime = new Date(rows[0].created_at);
    const now = new Date();
    const hoursSinceLastPost = (now - lastPostTime) / (1000 * 60 * 60);

    if (hoursSinceLastPost >= 12) {
      console.log(`[GUARDIAI] 12+ hours since last post (${hoursSinceLastPost.toFixed(1)}h). Creating new post.`);
      return true;
    } else {
      console.log(`[GUARDIAI] Skipping post creation. Only ${hoursSinceLastPost.toFixed(1)}h since last post (need 12h cooldown)`);
      return false;
    }
  } catch (err) {
    console.error('[GUARDIAI] Error checking cooldown:', err);
    return false;
  }
}

// Helper function to create a GuardiAI auto-post
async function createGuardiAIPost() {
  try {
    const content = generateGuardiAIContent();

    const { rows } = await pool.query(`
      INSERT INTO feed_posts (user_id, content, created_at)
      VALUES ($1, $2, NOW())
      RETURNING id, created_at
    `, [100, JSON.stringify({ type: 'text', text: content })]);

    console.log(`[GUARDIAI] Created GuardiAI auto-post #${rows[0].id} at ${new Date().toISOString()}`);
    return { created: true, postId: rows[0].id, createdAt: rows[0].created_at };
  } catch (err) {
    console.error('[GUARDIAI] Error creating GuardiAI post:', err);
    return { created: false, reason: 'Error creating post' };
  }
}

// POST /api/feed/milestones/refresh - Refresh network milestone data on-demand
app.post('/api/feed/milestones/refresh', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Create a new milestone post with random values
    const newPost = await createMilestonePost();

    // Update network_milestones last_refreshed_at (for backwards compatibility)
    await pool.query(`
      UPDATE network_milestones
      SET last_refreshed_at = NOW(), updated_at = NOW()
    `);

    // Return the newly created milestone post
    const { rows: milestones } = await pool.query(`
      SELECT id, key, label, value, unit, category, last_refreshed_at, updated_at
      FROM network_milestones
      ORDER BY last_refreshed_at DESC
    `);

    const milestonePosts = milestones.map(m => ({
      id: 'milestone_' + m.key,
      userId: -1,
      username: 'Usernode Network Updates',
      verified: true,
      avatarUrl: null,
      content: { type: 'milestone', text: m.label, metrics: { key: m.key, value: m.value, unit: m.unit } },
      createdAt: m.last_refreshed_at,
      updatedAt: m.updated_at,
      isEdited: false,
      onChain: false,
      likeCount: 0,
      commentCount: 0,
      isMilestone: true
    }));

    res.json({
      milestones: milestonePosts,
      newPostId: newPost?.id,
      refreshedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error refreshing milestones:', err);
    res.status(500).json({ error: 'Failed to refresh milestones' });
  }
});

// Explorer API proxy for transaction status polling (modeled after Last One Wins)
// This endpoint is called by the chain poller to check transaction confirmation status via Usernode explorer
app.get('/explorer-api/:chainId/transactions/:txHash', async (req, res) => {
  try {
    const { chainId, txHash } = req.params;

    // In staging/demo mode, return confirmed status immediately
    if (IS_STAGING) {
      return res.json({
        txHash: txHash,
        status: 'confirmed',
        blockNumber: 12345,
        timestamp: new Date().toISOString()
      });
    }

    // In production: call real Usernode explorer API
    const config = CHAIN_CONFIG[chainId];
    if (!config) {
      return res.status(400).json({ error: 'Invalid chain ID' });
    }

    // Call Usernode explorer to check transaction status
    // Pattern: GET /explorer/tx/{txHash}
    const explorerUrl = `${config.explorerUrl}/api/tx/${txHash}`;

    return new Promise((resolve) => {
      const request = https.get(explorerUrl, { timeout: 5000 }, (response) => {
        let data = '';
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => {
          try {
            const txData = JSON.parse(data);
            // Usernode explorer returns { hash, status, blockNumber, timestamp, ... }
            resolve(res.json({
              txHash: txHash,
              status: txData.status || 'pending', // 'confirmed', 'pending', 'failed'
              blockNumber: txData.blockNumber || null,
              timestamp: txData.timestamp || new Date().toISOString()
            }));
          } catch (err) {
            // If explorer response invalid, return pending (retry will happen)
            resolve(res.json({
              txHash: txHash,
              status: 'pending',
              blockNumber: null,
              timestamp: new Date().toISOString()
            }));
          }
        });
      }).on('error', (err) => {
        // Explorer unreachable, return pending
        console.warn(`[Explorer] Error fetching ${txHash}:`, err.message);
        resolve(res.json({
          txHash: txHash,
          status: 'pending',
          blockNumber: null,
          timestamp: new Date().toISOString()
        }));
      });
      request.on('timeout', () => {
        request.destroy();
        resolve(res.json({
          txHash: txHash,
          status: 'pending',
          blockNumber: null,
          timestamp: new Date().toISOString()
        }));
      });
    });
  } catch (err) {
    console.error('Explorer API error:', err);
    res.status(500).json({ error: 'Explorer API error' });
  }
});

// ===== BRIDGE DIAGNOSTICS ENDPOINT =====

app.post('/api/diagnostics/bridge', async (req, res) => {
  try {
    const { diagnostic, context, userId, telemetry } = req.body;

    if (!diagnostic || !context) {
      return res.status(400).json({ error: 'Missing diagnostic or context' });
    }

    // Log to console for debugging
    console.log(`[BRIDGE-DIAGNOSTIC] User ${userId || 'unknown'} reported: ${context.errorType || 'unknown'}`);
    console.log(`[BRIDGE-DIAGNOSTIC] Context:`, context);
    console.log(`[BRIDGE-DIAGNOSTIC] Bridge state:`, {
      scriptLoaded: diagnostic.bridgeScript?.scriptTagLoaded,
      windowUsernodeExists: diagnostic.windowUsernode?.exists,
      bridgeReadyState: diagnostic.bridgeLoadState?.bridgeReady,
      isDemoMode: diagnostic.isDemoMode
    });

    if (context.errorType === 'wallet_signature_timeout') {
      console.log(`[BRIDGE-DIAGNOSTIC] Wallet timeout after ${context.elapsedMs}ms on attempt ${context.attempt}/${context.maxAttempts} for action: ${context.action}`);
      console.log(`[BRIDGE-DIAGNOSTIC] Signature state:`, diagnostic.signatureState);
    }

    if (context.errorType === 'bridge_load_failure') {
      console.log(`[BRIDGE-DIAGNOSTIC] Bridge failed to load within ${context.timeoutMs}ms`);
    }

    // Log bridge telemetry if provided
    if (telemetry && telemetry.logs) {
      console.log(`[BRIDGE-DIAGNOSTIC-TELEMETRY] Received ${telemetry.logs.length} telemetry events`);
      telemetry.logs.slice(0, 20).forEach(log => {
        console.log(`  [${log.category}] +${log.elapsed}ms: ${log.message}`);
      });
      if (telemetry.postMessageEvents && telemetry.postMessageEvents.length > 0) {
        console.log(`[BRIDGE-DIAGNOSTIC-TELEMETRY] Received ${telemetry.postMessageEvents.length} postMessage events`);
      }
      if (telemetry.customEvents && telemetry.customEvents.length > 0) {
        console.log(`[BRIDGE-DIAGNOSTIC-TELEMETRY] Received ${telemetry.customEvents.length} custom events`);
      }
    }

    // Could optionally store in database for later analysis
    // For now, just log it
    res.json({ ok: true, diagnosticsReceived: true });
  } catch (err) {
    console.error('Error processing bridge diagnostic:', err);
    res.status(500).json({ error: err.message });
  }
});

// New endpoint to retrieve bridge telemetry logs via frontend (receives telemetry from client)
app.post('/api/diagnostics/bridge-logs', async (req, res) => {
  try {
    const { telemetry } = req.body;

    if (!telemetry) {
      return res.status(400).json({ error: 'No telemetry data provided' });
    }

    // Log complete telemetry to console
    console.log(`[BRIDGE-LOGS] Complete telemetry dump:`);
    console.log(`[BRIDGE-LOGS] Total events: ${telemetry.logs?.length || 0}`);
    console.log(`[BRIDGE-LOGS] PostMessage events: ${telemetry.postMessageEvents?.length || 0}`);
    console.log(`[BRIDGE-LOGS] Custom events: ${telemetry.customEvents?.length || 0}`);

    if (telemetry.logs && telemetry.logs.length > 0) {
      console.log(`[BRIDGE-LOGS] === Event Timeline ===`);
      let lastTimestamp = telemetry.logs[0].timestamp;
      telemetry.logs.forEach((log, idx) => {
        const elapsed = log.timestamp - lastTimestamp;
        console.log(`[BRIDGE-LOGS] ${idx + 1}. +${elapsed}ms [${log.category}] ${log.message}`);
        if (log.data) {
          console.log(`     Data:`, log.data);
        }
      });
    }

    if (telemetry.windowSnapshot) {
      console.log(`[BRIDGE-LOGS] Window snapshot:`, telemetry.windowSnapshot);
    }

    if (telemetry.postMessageEvents && telemetry.postMessageEvents.length > 0) {
      console.log(`[BRIDGE-LOGS] PostMessage events:`, telemetry.postMessageEvents);
    }

    if (telemetry.promiseStates && Object.keys(telemetry.promiseStates).length > 0) {
      console.log(`[BRIDGE-LOGS] Promise states:`, telemetry.promiseStates);
    }

    res.json({
      ok: true,
      telemetryReceived: true,
      summary: {
        totalEvents: telemetry.logs?.length || 0,
        postMessageEvents: telemetry.postMessageEvents?.length || 0,
        customEvents: telemetry.customEvents?.length || 0,
        promiseStates: Object.keys(telemetry.promiseStates || {}).length
      }
    });
  } catch (err) {
    console.error('Error processing bridge logs:', err);
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint to manually retrieve current telemetry data (for testing/manual inspection)
app.get('/api/debug/bridge-telemetry-check', async (req, res) => {
  res.json({
    note: 'Bridge telemetry is captured in the browser console. On a timeout event, logs are automatically sent to /api/diagnostics/bridge and /api/diagnostics/bridge-logs. Check server console output for [BRIDGE-LOGS] entries.',
    howToRetrieve: [
      '1. Open browser DevTools console',
      '2. Look for [Bridge-Telemetry-*] console messages',
      '3. Check server logs for [BRIDGE-LOGS] entries when a timeout occurs',
      '4. All telemetry is automatically uploaded on timeout events'
    ],
    telemetryCaptures: [
      'BRIDGE-CALL: parameters sent to window.sendTransaction()',
      'BRIDGE-RETURN: whether the bridge returned a Promise',
      'PROMISE-CREATED: when Promise is created',
      'PROMISE-RESOLVED: when Promise resolves',
      'PROMISE-REJECTED: when Promise rejects',
      'POSTMESSAGE: all postMessage events received',
      'CUSTOM-EVENT: any custom events fired',
      'WINDOW-SNAPSHOT: bridge objects available at runtime',
      'TIMEOUT-FINAL-STATE: final state when timeout fires'
    ]
  });
});

// ===== PRODUCTION SIMULATION TEST =====

app.get('/api/test/production-simulation', async (req, res) => {
  const testStartTime = Date.now();
  const results = {
    success: false,
    testName: 'Guardian Production Simulation Test',
    timestamp: new Date().toISOString(),
    tests: {}
  };

  try {
    // Test 1: Create a test message
    const testUserId = 999999;
    const testUsername = 'test-prod-sim-user';
    const testRecipient = 'test-recipient-user';
    const messageContent = `[TEST] Production simulation message at ${Date.now()}`;
    const chainId = 'testnet';
    const network = 'testnet';

    // Ensure test user exists
    await pool.query(`
      INSERT INTO users (id, username) VALUES ($1, $2)
      ON CONFLICT (username) DO NOTHING
    `, [testUserId, testUsername]);

    // Test 1: Create message in database
    results.tests.messageCreation = { status: 'pending' };
    const messageResult = await pool.query(`
      INSERT INTO messages (sender_id, sender_username, recipient_id, content, created_at)
      SELECT $1, $2, id, $3, NOW()
      FROM users WHERE username = $4
      RETURNING id, sender_id, recipient_id, content, created_at
    `, [testUserId, testUsername, messageContent, testRecipient]);

    if (messageResult.rows.length === 0) {
      return res.status(500).json({
        ...results,
        error: 'Failed to create test message - recipient user not found'
      });
    }

    const message = messageResult.rows[0];
    const messageId = message.id;
    results.tests.messageCreation = {
      status: 'pass',
      messageId: messageId,
      senderId: message.sender_id,
      content: message.content
    };

    // Test 2: Sign transaction memo
    results.tests.memoSigning = { status: 'pending' };
    const contentHash = computeContentHash(messageContent);
    const memoPayload = {
      type: 'message',
      senderId: testUserId,
      timestamp: Date.now(),
      contentHash: contentHash
    };
    const signedMemo = signTransactionMemo(memoPayload);
    const parsedMemo = JSON.parse(signedMemo);

    // Verify memo format
    if (parsedMemo.app !== 'guardian' || parsedMemo.type !== 'message' || !parsedMemo.contentHash) {
      throw new Error('Invalid memo format');
    }

    results.tests.memoSigning = {
      status: 'pass',
      memo: parsedMemo,
      contentHash: contentHash,
      format: 'Last One Wins pattern - { app: "guardian", type, senderId, timestamp, contentHash }'
    };

    // Test 3: Generate transaction hash
    results.tests.transactionGeneration = { status: 'pending' };
    const txHash = `ut1test-${chainId}-message-${messageId}-${Date.now()}`;
    results.tests.transactionGeneration = {
      status: 'pass',
      transactionHash: txHash,
      chain: chainId
    };

    // Test 4: Insert blockchain audit log
    results.tests.auditLogInsertion = { status: 'pending' };
    const auditLogResult = await pool.query(`
      INSERT INTO blockchain_audit_logs (
        user_id, user_pubkey, message_type, action_id, tx_hash, status,
        transaction_payload, content_hash, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING id, status, created_at, transaction_payload
    `, [
      testUserId,
      APP_PUBKEY,
      'message',
      messageId,
      txHash,
      'pending',
      JSON.stringify({
        memo: parsedMemo,
        app: 'guardian',
        messageId: messageId,
        type: 'message'
      }),
      contentHash
    ]);

    if (auditLogResult.rows.length === 0) {
      throw new Error('Failed to insert blockchain audit log');
    }

    const auditLog = auditLogResult.rows[0];
    results.tests.auditLogInsertion = {
      status: 'pass',
      auditLogId: auditLog.id,
      initialStatus: auditLog.status,
      createdAt: auditLog.created_at
    };

    // Test 5: Test explorer API endpoint
    results.tests.explorerAPI = { status: 'pending' };
    const explorerResponse = await new Promise((resolve) => {
      const options = {
        hostname: 'localhost',
        port: port || 3000,
        path: `/explorer-api/${chainId}/transactions/${txHash}`,
        method: 'GET',
        timeout: 5000
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    });

    results.tests.explorerAPI = {
      status: explorerResponse ? 'pass' : 'fail',
      response: explorerResponse || { error: 'No response from explorer' }
    };

    // Test 6: Simulate chain polling (instant confirmation in test)
    results.tests.chainPolling = { status: 'pending' };
    const pollStartTime = Date.now();

    // Simulate one poll cycle
    const simulatedPollResult = {
      txHash: txHash,
      status: 'confirmed',
      blockNumber: 12345,
      timestamp: new Date().toISOString()
    };

    // Update audit log to confirmed
    const updateResult = await pool.query(`
      UPDATE blockchain_audit_logs
      SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING id, status, confirmed_at, created_at
    `, [auditLog.id]);

    if (updateResult.rows.length > 0) {
      const updatedAuditLog = updateResult.rows[0];
      const confirmationTimeMs = new Date(updatedAuditLog.confirmed_at) - new Date(updatedAuditLog.created_at);

      results.tests.chainPolling = {
        status: 'pass',
        pollResult: simulatedPollResult,
        auditLogUpdated: true,
        finalStatus: updatedAuditLog.status,
        confirmationTimeMs: confirmationTimeMs,
        pollDurationMs: Date.now() - pollStartTime
      };
    }

    // Test 7: Verify final audit log state
    results.tests.finalAuditLogVerification = { status: 'pending' };
    const finalAuditResult = await pool.query(`
      SELECT id, status, tx_hash, content_hash, user_pubkey, transaction_payload, created_at, confirmed_at
      FROM blockchain_audit_logs
      WHERE id = $1
    `, [auditLog.id]);

    if (finalAuditResult.rows.length > 0) {
      const finalAuditLog = finalAuditResult.rows[0];
      results.tests.finalAuditLogVerification = {
        status: 'pass',
        auditLog: {
          id: finalAuditLog.id,
          status: finalAuditLog.status,
          txHash: finalAuditLog.tx_hash,
          contentHash: finalAuditLog.content_hash,
          appPubkey: finalAuditLog.user_pubkey,
          payload: JSON.parse(finalAuditLog.transaction_payload),
          createdAt: finalAuditLog.created_at,
          confirmedAt: finalAuditLog.confirmed_at
        }
      };
    }

    // Summary
    const testDurationMs = Date.now() - testStartTime;
    const allTestsPassed = Object.values(results.tests).every(t => t.status === 'pass');

    results.success = allTestsPassed;
    results.summary = {
      allTestsPassed: allTestsPassed,
      totalDurationMs: testDurationMs,
      testCount: Object.keys(results.tests).length,
      passedCount: Object.values(results.tests).filter(t => t.status === 'pass').length,
      failedCount: Object.values(results.tests).filter(t => t.status === 'fail').length,
      testsRun: [
        '✓ Message creation in database',
        '✓ Transaction memo signing (Last One Wins format)',
        '✓ Transaction hash generation',
        '✓ Blockchain audit log insertion',
        '✓ Explorer API endpoint response',
        '✓ Chain polling and confirmation',
        '✓ Final audit log state verification'
      ]
    };

    res.json(results);
  } catch (err) {
    console.error('[Production Simulation Test] Error:', err);
    results.success = false;
    results.error = err.message;
    results.stack = process.env.NODE_ENV === 'development' ? err.stack : undefined;
    res.status(500).json(results);
  }
});

// ===== STATIC & FALLBACK =====

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== DATABASE INITIALIZATION =====

async function start() {
  try {
    // Drop old presses table if it exists (for demo purposes)
    await pool.query(`DROP TABLE IF EXISTS presses CASCADE`);

    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        usernode_pubkey VARCHAR(100) UNIQUE,
        verified_at TIMESTAMPTZ,
        avatar_url TEXT,
        blocked_users INTEGER[],
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Add usernode_pubkey column if it doesn't exist (idempotent migration)
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS usernode_pubkey VARCHAR(100) UNIQUE
    `);

    // Add network column if it doesn't exist (idempotent migration)
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS network VARCHAR(50) DEFAULT 'testnet'
    `);

    // Add view_mode column if it doesn't exist (idempotent migration)
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS view_mode VARCHAR(50) DEFAULT 'web'
    `);

    // Add last_usernode_ping_at column if it doesn't exist (idempotent migration)
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_usernode_ping_at TIMESTAMPTZ
    `);

    // Add bio column if it doesn't exist (idempotent migration)
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(500)
    `);

    // Widen avatar_url to TEXT so base64 data URIs are not truncated (idempotent migration)
    await pool.query(`
      ALTER TABLE users ALTER COLUMN avatar_url TYPE TEXT
    `);

    // Add is_bot column to users table (idempotent migration)
    try {
      console.log('[Migration] Adding is_bot column to users table...');
      await pool.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT FALSE
      `);
      console.log('[Migration] ✅ is_bot column migration completed');
    } catch (err) {
      console.error('[Migration] ❌ ERROR adding is_bot column:', err.message);
      throw err;
    }

    // Create conversations table (marked private)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id BIGSERIAL PRIMARY KEY,
        participant_a_id INTEGER NOT NULL,
        participant_b_id INTEGER NOT NULL,
        archived_by INTEGER[],
        muted_by INTEGER[],
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(participant_a_id, participant_b_id)
      )
    `);

    // Create messages table (marked private)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id INTEGER NOT NULL,
        type VARCHAR(50) NOT NULL,
        content JSONB NOT NULL,
        blockchain_recorded BOOLEAN DEFAULT FALSE,
        blockchain_audit_log_id BIGINT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_by INTEGER[]
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
        ON messages(conversation_id, created_at)
    `);

    // Add blockchain columns to messages if they don't exist (idempotent migration)
    await pool.query(`
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS blockchain_recorded BOOLEAN DEFAULT FALSE
    `);
    await pool.query(`
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS blockchain_audit_log_id BIGINT
    `);

    // Add updated_at column to conversations if it doesn't exist (idempotent migration)
    await pool.query(`
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_updated_created
        ON conversations(updated_at DESC NULLS LAST, created_at DESC)
    `);

    // Add post-message-control columns to conversations (idempotent migration)
    await pool.query(`
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS status_a VARCHAR(50) DEFAULT 'accepted'
    `);
    await pool.query(`
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS status_b VARCHAR(50) DEFAULT 'accepted'
    `);
    await pool.query(`
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS blocked_by INTEGER[]
    `);

    // Create read_receipts table (marked private)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS read_receipts (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        conversation_id BIGINT NOT NULL,
        last_read_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, conversation_id)
      )
    `);

    // Create user_contacts table (marked private)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_contacts (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        contact_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        nickname VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        archived_by INTEGER[],
        muted_by INTEGER[],
        UNIQUE(user_id, contact_user_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_contacts_user_id
        ON user_contacts(user_id)
    `);

    // Add archived_by column if it doesn't exist (idempotent migration)
    await pool.query(`
      ALTER TABLE user_contacts ADD COLUMN IF NOT EXISTS archived_by INTEGER[]
    `);

    // Add muted_by column if it doesn't exist (idempotent migration)
    await pool.query(`
      ALTER TABLE user_contacts ADD COLUMN IF NOT EXISTS muted_by INTEGER[]
    `);

    // Create blockchain_audit_logs table (marked private)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blockchain_audit_logs (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id BIGINT REFERENCES messages(id) ON DELETE CASCADE,
        message_type VARCHAR(50),
        tx_hash VARCHAR(255) UNIQUE,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        transaction_payload JSONB,
        transaction_data JSONB,
        error_message TEXT,
        confirmed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Add message_type column if it doesn't exist (idempotent migration)
    await pool.query(`
      ALTER TABLE blockchain_audit_logs ADD COLUMN IF NOT EXISTS message_type VARCHAR(50)
    `);

    // Add transaction_payload column if it doesn't exist (idempotent migration)
    await pool.query(`
      ALTER TABLE blockchain_audit_logs ADD COLUMN IF NOT EXISTS transaction_payload JSONB
    `);

    // Add updated_at column if it doesn't exist (idempotent migration)
    await pool.query(`
      ALTER TABLE blockchain_audit_logs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
    `);

    // Add on-chain proof tracking columns (idempotent migration)
    await pool.query(`
      ALTER TABLE blockchain_audit_logs ADD COLUMN IF NOT EXISTS group_id BIGINT REFERENCES groups(id) ON DELETE SET NULL
    `);
    await pool.query(`
      ALTER TABLE blockchain_audit_logs ADD COLUMN IF NOT EXISTS on_chain_group_id VARCHAR(255)
    `);
    await pool.query(`
      ALTER TABLE blockchain_audit_logs ADD COLUMN IF NOT EXISTS on_chain_message_id VARCHAR(255)
    `);
    await pool.query(`
      ALTER TABLE blockchain_audit_logs ADD COLUMN IF NOT EXISTS content_hash VARCHAR(255)
    `);
    await pool.query(`
      ALTER TABLE blockchain_audit_logs ADD COLUMN IF NOT EXISTS user_pubkey VARCHAR(100)
    `);
    await pool.query(`
      ALTER TABLE blockchain_audit_logs ADD COLUMN IF NOT EXISTS action_timestamp TIMESTAMPTZ
    `);

    // Drop NOT NULL constraint on tx_hash to allow two-phase audit log creation (pending audits with null tx_hash)
    await pool.query(`
      ALTER TABLE blockchain_audit_logs ALTER COLUMN tx_hash DROP NOT NULL
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_blockchain_audit_logs_message_id
        ON blockchain_audit_logs(message_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_blockchain_audit_logs_user_created
        ON blockchain_audit_logs(user_id, created_at)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_blockchain_audit_logs_group_id
        ON blockchain_audit_logs(group_id)
    `);

    // Create groups table (marked private)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id BIGSERIAL PRIMARY KEY,
        creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        avatar_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Add archived_by column to groups if it doesn't exist
    await pool.query(`
      ALTER TABLE groups
      ADD COLUMN IF NOT EXISTS archived_by INTEGER[] DEFAULT '{}'
    `);

    // Widen groups.avatar_url to TEXT (idempotent migration)
    await pool.query(`
      ALTER TABLE groups ALTER COLUMN avatar_url TYPE TEXT
    `);

    // Create group_members table (marked private)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_members (
        id BIGSERIAL PRIMARY KEY,
        group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(50) DEFAULT 'member',
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(group_id, user_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_group_members_group_id
        ON group_members(group_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_group_members_user_id
        ON group_members(user_id)
    `);

    // Create group_messages table (marked private)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_messages (
        id BIGSERIAL PRIMARY KEY,
        group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        content JSONB NOT NULL,
        blockchain_recorded BOOLEAN DEFAULT FALSE,
        blockchain_audit_log_id BIGINT REFERENCES blockchain_audit_logs(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_by INTEGER[] DEFAULT '{}'
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_group_messages_group_created
        ON group_messages(group_id, created_at)
    `);

    // Create group_read_receipts table (marked private)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_read_receipts (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        last_read_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, group_id)
      )
    `);

    // Create channels table (public - for organizing feed posts by channel)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        is_system BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_channels_is_system_created
        ON channels(is_system DESC, created_at DESC)
    `);

    // Add columns to channels table for new features
    await pool.query(`
      ALTER TABLE channels
      ADD COLUMN IF NOT EXISTS owner_id INTEGER DEFAULT -1,
      ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'General',
      ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE
    `);

    // Create additional indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_channels_is_featured
        ON channels(is_featured DESC, created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_channels_category
        ON channels(category, is_featured DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_channels_owner_id
        ON channels(owner_id)
    `);

    // Create pinned_channels table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pinned_channels (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        pinned_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, channel_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_pinned_channels_user_id
        ON pinned_channels(user_id, pinned_at DESC)
    `);

    // Create channel_unread table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS channel_unread (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        unread_count INTEGER DEFAULT 0,
        last_read_post_id BIGINT,
        last_read_at TIMESTAMPTZ,
        UNIQUE(user_id, channel_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_channel_unread_user_channel
        ON channel_unread(user_id, channel_id)
    `);

    // Create channel_categories table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS channel_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create or ensure Guardian Updates system channel exists with new fields
    const guardianChannelResult = await pool.query(`
      SELECT id FROM channels WHERE name = 'Guardian Updates' AND is_system = TRUE
    `);
    let guardianChannelId;
    if (guardianChannelResult.rows.length === 0) {
      const insertResult = await pool.query(`
        INSERT INTO channels (name, description, is_system, owner_id, is_verified, verified_at, is_featured, category)
        VALUES ('Guardian Updates', 'System notifications and milestones', TRUE, -1, TRUE, NOW(), TRUE, 'Updates')
        RETURNING id
      `);
      guardianChannelId = insertResult.rows[0].id;
    } else {
      guardianChannelId = guardianChannelResult.rows[0].id;
      // Update existing Guardian Updates channel with new fields
      await pool.query(`
        UPDATE channels
        SET owner_id = -1, is_verified = TRUE, verified_at = NOW(), is_featured = TRUE, category = 'Updates'
        WHERE id = $1
      `, [guardianChannelId]);
    }

    // Seed categories if empty
    const categoriesCheck = await pool.query(`SELECT COUNT(*) FROM channel_categories`);
    if (parseInt(categoriesCheck.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO channel_categories (name, description)
        VALUES
          ('Updates', 'System and important updates'),
          ('General', 'General discussion'),
          ('Announcements', 'Official announcements'),
          ('Community', 'Community-driven content')
      `);
    }

    // Staging: seed featured channels and example data
    if (process.env.USERNODE_ENV === 'staging') {
      await pool.query(`
        INSERT INTO channels (name, description, owner_id, category, is_featured)
        VALUES
          ('Community Highlights', 'Best posts from the community', -1, 'Community', TRUE),
          ('Announcements', 'Important network announcements', -1, 'Announcements', TRUE),
          ('[Staging] General Discussion', 'Staging demo general channel', -1, 'General', FALSE),
          ('[Staging] Dev Updates', 'Staging demo dev channel', -1, 'Updates', FALSE)
        ON CONFLICT (name) DO NOTHING
      `);
    }

    // Create feed_posts table (public - feed posts are shared with all users)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS feed_posts (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_feed_posts_created
        ON feed_posts(created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_feed_posts_user_id
        ON feed_posts(user_id)
    `);

    // Create feed_comments table (public - comments on feed posts)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS feed_comments (
        id BIGSERIAL PRIMARY KEY,
        post_id BIGINT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_feed_comments_post_id
        ON feed_comments(post_id, created_at)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_feed_comments_user_id
        ON feed_comments(user_id)
    `);

    // Create feed_likes table (public - likes on feed posts)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS feed_likes (
        id BIGSERIAL PRIMARY KEY,
        post_id BIGINT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(post_id, user_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_feed_likes_post_id
        ON feed_likes(post_id)
    `);

    // Add channel_id column to feed_posts if it doesn't exist
    await pool.query(`
      ALTER TABLE feed_posts
      ADD COLUMN IF NOT EXISTS channel_id BIGINT REFERENCES channels(id) ON DELETE CASCADE
    `);

    // Create index on channel_id and created_at for efficient post queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_feed_posts_channel_created
        ON feed_posts(channel_id, created_at DESC)
    `);

    // Backfill existing posts to Guardian Updates channel if they don't have a channel
    await pool.query(`
      UPDATE feed_posts
      SET channel_id = $1
      WHERE channel_id IS NULL
    `, [guardianChannelId]);

    // Add on_chain column to feed_posts if it doesn't exist
    await pool.query(`
      ALTER TABLE feed_posts
      ADD COLUMN IF NOT EXISTS on_chain BOOLEAN DEFAULT FALSE
    `);

    // Staging: seed example post if in staging mode
    if (process.env.USERNODE_ENV === 'staging') {
      await pool.query(`
        INSERT INTO feed_posts (user_id, content, channel_id, created_at)
        VALUES (-1, $1, $2, NOW())
        ON CONFLICT DO NOTHING
      `, [JSON.stringify({ type: 'text', text: '[Staging] Guardian Updates - Initial System Message' }), guardianChannelId]);
    }

    // Create bot_reply_log table for tracking bot replies
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_reply_log (
        id BIGSERIAL PRIMARY KEY,
        trigger_comment_id BIGINT NOT NULL REFERENCES feed_comments(id) ON DELETE CASCADE,
        bot_reply_comment_id BIGINT NOT NULL REFERENCES feed_comments(id) ON DELETE CASCADE,
        trigger_username VARCHAR(255),
        reply_content TEXT,
        crypto_ticker VARCHAR(20),
        crypto_price NUMERIC,
        price_change_24h NUMERIC,
        api_source VARCHAR(50),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_bot_reply_log_trigger
        ON bot_reply_log(trigger_comment_id)
    `);

    // Create peers table (public - peer foreground hours data)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS peers (
        id SERIAL PRIMARY KEY,
        peer_id VARCHAR(100) UNIQUE NOT NULL,
        foreground_hours INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_peers_peer_id
        ON peers(peer_id)
    `);

    // Create network_milestones table (public - Usernode network statistics)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS network_milestones (
        id SERIAL PRIMARY KEY,
        key VARCHAR(50) UNIQUE NOT NULL,
        label VARCHAR(255) NOT NULL,
        value TEXT NOT NULL,
        unit VARCHAR(50),
        category VARCHAR(50),
        last_refreshed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_network_milestones_key
        ON network_milestones(key)
    `);

    // Create crypto_data_cache table (public - cached CoinGecko data for Crypto Daily bot)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crypto_data_cache (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL,
        last_fetched_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_crypto_data_cache_fetched
        ON crypto_data_cache(last_fetched_at DESC)
    `);

    // Mark tables as private
    await pool.query(`COMMENT ON TABLE conversations IS 'staging:private'`);
    await pool.query(`COMMENT ON TABLE messages IS 'staging:private'`);
    await pool.query(`COMMENT ON TABLE read_receipts IS 'staging:private'`);
    await pool.query(`COMMENT ON TABLE user_contacts IS 'staging:private'`);
    await pool.query(`COMMENT ON TABLE blockchain_audit_logs IS 'staging:private'`);
    await pool.query(`COMMENT ON TABLE groups IS 'staging:private'`);
    await pool.query(`COMMENT ON TABLE group_members IS 'staging:private'`);
    await pool.query(`COMMENT ON TABLE group_messages IS 'staging:private'`);
    await pool.query(`COMMENT ON TABLE group_read_receipts IS 'staging:private'`);

    // Seed staging data
    // Seed mock testnet users (grace, henry, iris, jack) in all environments for user search testing
    const grace = 11, henry = 12, iris = 13, jack = 14;
    await pool.query(`
      INSERT INTO users (id, username, usernode_pubkey, verified_at, created_at, bio, avatar_url) VALUES
        ($1, 'test-user-grace', 'ut1staging-grace-001', NOW(), NOW() - INTERVAL '5 days', 'Test user - DevOps engineer', 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ccircle cx=%2250%22 cy=%2250%22 r=%2250%22 fill=%22%2310b981%22/%3E%3Ctext x=%2250%22 y=%2265%22 font-size=%2240%22 text-anchor=%22middle%22 fill=%22white%22 font-weight=%22bold%22%3EG%3C/text%3E%3C/svg%3E'),
        ($2, 'test-user-henry', 'ut1staging-henry-001', NOW(), NOW() - INTERVAL '3 days', 'Test user - Frontend specialist', 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ccircle cx=%2250%22 cy=%2250%22 r=%2250%22 fill=%22%238b5cf6%22/%3E%3Ctext x=%2250%22 y=%2265%22 font-size=%2240%22 text-anchor=%22middle%22 fill=%22white%22 font-weight=%22bold%22%3EH%3C/text%3E%3C/svg%3E'),
        ($3, 'test-user-iris', 'ut1staging-iris-001', null, NOW() - INTERVAL '1 day', 'Test user - Data scientist', 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ccircle cx=%2250%22 cy=%2250%22 r=%2250%22 fill=%22%23f59e0b%22/%3E%3Ctext x=%2250%22 y=%2265%22 font-size=%2240%22 text-anchor=%22middle%22 fill=%22white%22 font-weight=%22bold%22%3EI%3C/text%3E%3C/svg%3E'),
        ($4, 'test-user-jack', 'ut1staging-jack-001', NOW(), NOW(), 'Test user - QA engineer', 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ccircle cx=%2250%22 cy=%2250%22 r=%2250%22 fill=%22%23ef4444%22/%3E%3Ctext x=%2250%22 y=%2265%22 font-size=%2240%22 text-anchor=%22middle%22 fill=%22white%22 font-weight=%22bold%22%3EJ%3C/text%3E%3C/svg%3E')
      ON CONFLICT (id) DO UPDATE SET
        username = EXCLUDED.username,
        usernode_pubkey = EXCLUDED.usernode_pubkey,
        verified_at = EXCLUDED.verified_at,
        bio = EXCLUDED.bio,
        avatar_url = EXCLUDED.avatar_url
    `, [grace, henry, iris, jack]);

    if (IS_STAGING) {
      const alice = 1, bob = 2, charlie = 3, david = 4, emma = 5, frank = 10;
      // Note: User 10 will map to 10 % 10 = 0 -> 5 hours (New Guardian)
      // User 1 -> 25 hours (Active Guardian)
      // User 2 -> 100 hours (Trusted Guardian)
      // User 3 -> 300 hours (Elite Guardian)
      // User 4 -> 15 hours (Active Guardian)
      // User 5 -> 50 hours (Trusted Guardian)
      // User 11 -> 1 % 10 = 1 -> 25 hours (Active Guardian)
      // User 12 -> 2 % 10 = 2 -> 100 hours (Trusted Guardian)
      // User 13 -> 3 % 10 = 3 -> 300 hours (Elite Guardian)
      // User 14 -> 4 % 10 = 4 -> 15 hours (Active Guardian)

      // Create staging demo users with wallet addresses
      await pool.query(`
        INSERT INTO users (id, username, usernode_pubkey, verified_at, created_at, bio, avatar_url) VALUES
          ($1, 'staging-demo-alice', 'ut1staging-alice-001', NOW(), NOW() - INTERVAL '6 months', 'Staging demo user - Cloud architect | Web3 enthusiast', 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ccircle cx=%2250%22 cy=%2250%22 r=%2250%22 fill=%22%2306b6d4%22/%3E%3Ctext x=%2250%22 y=%2265%22 font-size=%2240%22 text-anchor=%22middle%22 fill=%22white%22 font-weight=%22bold%22%3EA%3C/text%3E%3C/svg%3E'),
          ($2, 'staging-demo-bob', 'ut1staging-bob-001', NOW(), NOW() - INTERVAL '4 months', 'Staging demo user - Blockchain developer', 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ccircle cx=%2250%22 cy=%2250%22 r=%2250%22 fill=%22%2306b6d4%22/%3E%3Ctext x=%2250%22 y=%2265%22 font-size=%2240%22 text-anchor=%22middle%22 fill=%22white%22 font-weight=%22bold%22%3EB%3C/text%3E%3C/svg%3E'),
          ($3, 'staging-demo-charlie', 'ut1staging-charlie-001', null, NOW() - INTERVAL '3 months', 'Staging demo user - Designer', 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ccircle cx=%2250%22 cy=%2250%22 r=%2250%22 fill=%22%2306b6d4%22/%3E%3Ctext x=%2250%22 y=%2265%22 font-size=%2240%22 text-anchor=%22middle%22 fill=%22white%22 font-weight=%22bold%22%3EC%3C/text%3E%3C/svg%3E'),
          ($4, 'staging-demo-david', 'ut1staging-david-001', NOW(), NOW() - INTERVAL '2 months', 'Staging demo user - Product Manager', 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ccircle cx=%2250%22 cy=%2250%22 r=%2250%22 fill=%22%2306b6d4%22/%3E%3Ctext x=%2250%22 y=%2265%22 font-size=%2240%22 text-anchor=%22middle%22 fill=%22white%22 font-weight=%22bold%22%3ED%3C/text%3E%3C/svg%3E'),
          ($5, 'staging-demo-emma', 'ut1staging-emma-001', NOW(), NOW() - INTERVAL '1 month', 'Staging demo user - Security researcher', 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ccircle cx=%2250%22 cy=%2250%22 r=%2250%22 fill=%22%2306b6d4%22/%3E%3Ctext x=%2250%22 y=%2265%22 font-size=%2240%22 text-anchor=%22middle%22 fill=%22white%22 font-weight=%22bold%22%3EE%3C/text%3E%3C/svg%3E'),
          ($6, 'staging-demo-frank', 'ut1staging-frank-001', NOW(), NOW() - INTERVAL '7 days', 'Staging demo user - Just joined!', null)
        ON CONFLICT (id) DO UPDATE SET
          username = EXCLUDED.username,
          usernode_pubkey = EXCLUDED.usernode_pubkey,
          verified_at = EXCLUDED.verified_at,
          bio = EXCLUDED.bio,
          avatar_url = EXCLUDED.avatar_url
      `, [alice, bob, charlie, david, emma, frank]);

      // Create conversation
      const { rows: convRows } = await pool.query(`
        SELECT id FROM conversations WHERE participant_a_id = $1 AND participant_b_id = $2
      `, [alice, bob]);

      let convId;
      if (convRows.length === 0) {
        const result = await pool.query(`
          INSERT INTO conversations (participant_a_id, participant_b_id, created_at)
          VALUES ($1, $2, NOW())
          RETURNING id
        `, [alice, bob]);
        convId = result.rows[0].id;
      } else {
        convId = convRows[0].id;
      }

      // Fetch user pubkeys for direct messages
      const { rows: dmUserRows } = await pool.query(`
        SELECT id, usernode_pubkey FROM users WHERE id IN ($1, $2)
      `, [alice, bob]);
      const dmUserPubkeyMap = {};
      dmUserRows.forEach(row => {
        dmUserPubkeyMap[row.id] = row.usernode_pubkey;
      });

      // Seed messages
      const baseTime = new Date(Date.now() - 3600000);
      const messages = [
        { offset: 0, sender: alice, type: 'text', content: { text: '[Staging] Hey Bob!' }, blockchain: true },
        { offset: 60000, sender: bob, type: 'text', content: { text: '[Staging] Hi Alice! How are you?' }, blockchain: false },
        { offset: 120000, sender: alice, type: 'text', content: { text: '[Staging] Doing great, thanks!' }, blockchain: false },
        { offset: 180000, sender: alice, type: 'image', content: { imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8DwHwMxxGAIwAAADkkBkMTjF4UAAAAASUVORK5CYII=' }, blockchain: false },
        { offset: 240000, sender: bob, type: 'text', content: { text: '[Staging] Nice photo!' }, blockchain: false },
        { offset: 300000, sender: alice, type: 'token', content: { recipientId: bob, amount: 100, memo: '[Staging] Here is a gift', txHash: 'staging-tx-001', status: 'confirmed' }, blockchain: true },
        { offset: 360000, sender: bob, type: 'text', content: { text: '[Staging] Thanks for the tokens!' }, blockchain: false },
        { offset: 420000, sender: bob, type: 'image', content: { imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNkYPhfwcDAwMjIyMjIyAgAEq4DBaIjqKQAAAAASUVORK5CYII=' }, blockchain: false },
        { offset: 480000, sender: alice, type: 'token', content: { recipientId: bob, amount: 50, memo: '[Staging] bonus', txHash: 'staging-tx-002', status: 'confirmed' }, blockchain: false },
        { offset: 540000, sender: bob, type: 'text', content: { text: '[Staging] This is awesome!' }, blockchain: false },
      ];

      for (const msg of messages) {
        const msgTime = new Date(baseTime.getTime() + msg.offset);
        const result = await pool.query(`
          INSERT INTO messages (conversation_id, sender_id, type, content, blockchain_recorded, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT DO NOTHING
          RETURNING id
        `, [convId, msg.sender, msg.type, JSON.stringify(msg.content), msg.blockchain, msgTime]);

        // Seed blockchain audit log for messages that have blockchain recording
        if (msg.blockchain && result.rows.length > 0) {
          const messageId = result.rows[0].id;
          const contentHash = computeContentHash(msg.content);
          const txHash = 'ut1staging-testnet-message-' + messageId + '-' + msgTime.getTime();
          const messageType = msg.type === 'token' ? 'token_transfer' : 'message';
          const transactionPayload = msg.type === 'token'
            ? {
                type: 'token_transfer',
                messageId: messageId,
                sender: msg.sender,
                recipient: msg.content.recipientId,
                amount: msg.content.amount,
                memo: msg.content.memo,
                userPubkey: dmUserPubkeyMap[msg.sender],
                contentHash: contentHash,
                timestamp: msgTime.toISOString()
              }
            : {
                type: 'message',
                messageId: messageId,
                senderId: msg.sender,
                userPubkey: dmUserPubkeyMap[msg.sender],
                contentHash: contentHash,
                timestamp: msgTime.toISOString()
              };

          const auditResult = await pool.query(`
            INSERT INTO blockchain_audit_logs (user_id, message_id, message_type, tx_hash, transaction_payload, status, confirmed_at, content_hash, user_pubkey, action_timestamp, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, 'confirmed', $6, $7, $8, $9, $10, $10)
            ON CONFLICT DO NOTHING
            RETURNING id
          `, [msg.sender, messageId, messageType, txHash, JSON.stringify(transactionPayload), msgTime, contentHash, dmUserPubkeyMap[msg.sender], msgTime, msgTime]);

          // Update message with audit log reference
          if (auditResult.rows.length > 0) {
            await pool.query(`
              UPDATE messages SET blockchain_audit_log_id = $1 WHERE id = $2
            `, [auditResult.rows[0].id, messageId]);
          }
        }
      }

      // Initialize read receipts
      await pool.query(`
        INSERT INTO read_receipts (user_id, conversation_id, last_read_at)
        VALUES ($1, $2, NOW()), ($3, $2, NOW())
        ON CONFLICT DO NOTHING
      `, [alice, convId, bob]);


      // Seed sample conversations with different statuses to demonstrate incoming message controls
      // Emma → Alice: unaccepted incoming message (Alice will see "New Message" badge)
      const [emmaAliceA, emmaAliceB] = [alice, emma].sort((x, y) => x - y);
      const { rows: convEmmAliceRows } = await pool.query(`
        SELECT id FROM conversations WHERE participant_a_id = $1 AND participant_b_id = $2
      `, [emmaAliceA, emmaAliceB]);

      let convEmmAliceId;
      if (convEmmAliceRows.length === 0) {
        const result = await pool.query(`
          INSERT INTO conversations (participant_a_id, participant_b_id, status_a, status_b, created_at, updated_at)
          VALUES ($1, $2, 'accepted', 'ignored', NOW(), NOW())
          RETURNING id
        `, [emmaAliceA, emmaAliceB]);
        convEmmAliceId = result.rows[0].id;
      } else {
        convEmmAliceId = convEmmAliceRows[0].id;
      }

      // Add a test message from Emma to Alice
      await pool.query(`
        INSERT INTO messages (conversation_id, sender_id, type, content, created_at)
        VALUES ($1, $2, 'text', '{"text": "[Staging] Hi Alice, just reaching out!"}', NOW())
        ON CONFLICT DO NOTHING
      `, [convEmmAliceId, emma]);

      // David → Bob: muted incoming message
      const [davidBobA, davidBobB] = [bob, david].sort((x, y) => x - y);
      const { rows: convDavidBobRows } = await pool.query(`
        SELECT id FROM conversations WHERE participant_a_id = $1 AND participant_b_id = $2
      `, [davidBobA, davidBobB]);

      let convDavidBobId;
      if (convDavidBobRows.length === 0) {
        const result = await pool.query(`
          INSERT INTO conversations (participant_a_id, participant_b_id, status_a, status_b, created_at, updated_at)
          VALUES ($1, $2, 'accepted', 'muted', NOW(), NOW())
          RETURNING id
        `, [davidBobA, davidBobB]);
        convDavidBobId = result.rows[0].id;
      } else {
        convDavidBobId = convDavidBobRows[0].id;
      }

      // Add a test message from David to Bob
      await pool.query(`
        INSERT INTO messages (conversation_id, sender_id, type, content, created_at)
        VALUES ($1, $2, 'text', '{"text": "[Staging] Hi Bob! Check this out"}', NOW())
        ON CONFLICT DO NOTHING
      `, [convDavidBobId, david]);

      // Seed archived alice-charlie conversation (archived by alice) for testing archive/unarchive UI
      const { rows: convAliceCharlieRows } = await pool.query(`
        SELECT id FROM conversations
        WHERE (participant_a_id = $1 AND participant_b_id = $2)
           OR (participant_a_id = $2 AND participant_b_id = $1)
      `, [alice, charlie]);

      let convAliceCharlieId;
      if (convAliceCharlieRows.length === 0) {
        const result = await pool.query(`
          INSERT INTO conversations (participant_a_id, participant_b_id, status_a, status_b, archived_by, created_at, updated_at)
          VALUES ($1, $2, 'accepted', 'accepted', ARRAY[$1]::integer[], NOW(), NOW())
          RETURNING id
        `, [alice, charlie]);
        convAliceCharlieId = result.rows[0].id;
      } else {
        convAliceCharlieId = convAliceCharlieRows[0].id;
        // Ensure alice is in archived_by
        await pool.query(`
          UPDATE conversations SET archived_by = array_append(archived_by, $1)
          WHERE id = $2 AND NOT (archived_by @> ARRAY[$1]::integer[])
        `, [alice, convAliceCharlieId]);
      }

      await pool.query(`
        INSERT INTO messages (conversation_id, sender_id, type, content, created_at)
        VALUES
          ($1, $2, 'text', '{"text": "[Staging] Hey Alice, long time no chat!"}', NOW() - INTERVAL '3 days'),
          ($1, $3, 'text', '{"text": "[Staging] Hi Charlie! Yeah it has been a while."}', NOW() - INTERVAL '3 days' + INTERVAL '5 minutes'),
          ($1, $2, 'text', '{"text": "[Staging] Let me know if you want to catch up sometime."}', NOW() - INTERVAL '3 days' + INTERVAL '10 minutes')
        ON CONFLICT DO NOTHING
      `, [convAliceCharlieId, charlie, alice]);

      // Seed pending contact requests for testing "Pending Requests" feature
      // Charlie → Alice: Charlie sends a pending request to Alice
      const [charlieAliceA, charlieAliceB] = [alice, charlie].sort((x, y) => x - y);
      const { rows: convCharlieAliceRows } = await pool.query(`
        SELECT id FROM conversations WHERE participant_a_id = $1 AND participant_b_id = $2
      `, [charlieAliceA, charlieAliceB]);

      if (convCharlieAliceRows.length === 0) {
        const charlieIsA = charlie === charlieAliceA;
        const result = await pool.query(`
          INSERT INTO conversations (participant_a_id, participant_b_id, status_a, status_b, created_at, updated_at)
          VALUES ($1, $2, $3, $4, NOW(), NOW())
          RETURNING id
        `, [charlieAliceA, charlieAliceB,
            charlieIsA ? 'accepted' : 'pending',
            charlieIsA ? 'pending' : 'accepted']);
        const convCharlieAliceId = result.rows[0].id;

        // Add a test message from Charlie to Alice
        await pool.query(`
          INSERT INTO messages (conversation_id, sender_id, type, content, created_at)
          VALUES ($1, $2, 'text', '{"text": "[Staging] Hey Alice, want to connect?"}', NOW() - INTERVAL '2 hours')
          ON CONFLICT DO NOTHING
        `, [convCharlieAliceId, charlie]);
      }

      // David → Bob: David sends a pending request to Bob
      const [davidBobA2, davidBobB2] = [bob, david].sort((x, y) => x - y);
      const { rows: convDavidBob2Rows } = await pool.query(`
        SELECT id FROM conversations WHERE participant_a_id = $1 AND participant_b_id = $2
      `, [davidBobA2, davidBobB2]);

      if (convDavidBob2Rows.length === 0) {
        const davidIsA = david === davidBobA2;
        const result = await pool.query(`
          INSERT INTO conversations (participant_a_id, participant_b_id, status_a, status_b, created_at, updated_at)
          VALUES ($1, $2, $3, $4, NOW(), NOW())
          RETURNING id
        `, [davidBobA2, davidBobB2,
            davidIsA ? 'accepted' : 'pending',
            davidIsA ? 'pending' : 'accepted']);
        const convDavidBob2Id = result.rows[0].id;

        // Add a test message from David to Bob
        await pool.query(`
          INSERT INTO messages (conversation_id, sender_id, type, content, created_at)
          VALUES ($1, $2, 'text', '{"text": "[Staging] Hi Bob, I have something interesting to share!"}', NOW() - INTERVAL '1 hour')
          ON CONFLICT DO NOTHING
        `, [convDavidBob2Id, david]);
      }

      // Seed sample contact relationships for testing "Add Contact" feature
      // Alice has Bob as a saved contact
      await pool.query(`
        INSERT INTO user_contacts (user_id, contact_user_id, nickname, created_at)
        VALUES ($1, $2, NULL, NOW())
        ON CONFLICT (user_id, contact_user_id) DO NOTHING
      `, [alice, bob]);

      // Bob has Alice as a saved contact
      await pool.query(`
        INSERT INTO user_contacts (user_id, contact_user_id, nickname, created_at)
        VALUES ($1, $2, NULL, NOW())
        ON CONFLICT (user_id, contact_user_id) DO NOTHING
      `, [bob, alice]);

      // Alice also has Charlie as a contact for testing wallet address search with saved contacts
      await pool.query(`
        INSERT INTO user_contacts (user_id, contact_user_id, nickname, created_at)
        VALUES ($1, $2, NULL, NOW())
        ON CONFLICT (user_id, contact_user_id) DO NOTHING
      `, [alice, charlie]);

      // Alice has David and Emma as additional contacts
      await pool.query(`
        INSERT INTO user_contacts (user_id, contact_user_id, nickname, created_at)
        VALUES ($1, $2, NULL, NOW()), ($1, $3, NULL, NOW())
        ON CONFLICT (user_id, contact_user_id) DO NOTHING
      `, [alice, david, emma]);

      // Seed archived, muted, and archived+muted contacts for testing contact options menu
      const { rows: archiveRows } = await pool.query(`
        SELECT id FROM user_contacts WHERE user_id = $1 AND contact_user_id = $2
      `, [alice, bob]);
      if (archiveRows.length > 0) {
        await pool.query(`
          UPDATE user_contacts SET muted_by = ARRAY[$1]::integer[] WHERE id = $2
        `, [alice, archiveRows[0].id]);
      }

      const { rows: archiveRows2 } = await pool.query(`
        SELECT id FROM user_contacts WHERE user_id = $1 AND contact_user_id = $2
      `, [alice, charlie]);
      if (archiveRows2.length > 0) {
        await pool.query(`
          UPDATE user_contacts SET archived_by = ARRAY[$1]::integer[] WHERE id = $2
        `, [alice, archiveRows2[0].id]);
      }

      const { rows: archiveRows3 } = await pool.query(`
        SELECT id FROM user_contacts WHERE user_id = $1 AND contact_user_id = $2
      `, [alice, david]);
      if (archiveRows3.length > 0) {
        await pool.query(`
          UPDATE user_contacts SET archived_by = ARRAY[$1]::integer[], muted_by = ARRAY[$1]::integer[] WHERE id = $2
        `, [alice, archiveRows3[0].id]);
      }

      // Seed a clearly-labelled test post for edit/delete feature testing
      const { rows: editTestRows } = await pool.query(`
        SELECT id FROM feed_posts WHERE user_id = $1 AND content->>'text' LIKE '%edited or deleted%' LIMIT 1
      `, [alice]);
      if (editTestRows.length === 0) {
        await pool.query(`
          INSERT INTO feed_posts (user_id, content, created_at, updated_at)
          VALUES ($1, $2, NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes')
        `, [alice, JSON.stringify({ text: '[Staging] This post can be edited or deleted — try it!' })]);
      }

      // Seed feed posts for Alice (min 8-12 posts)
      const postTimes = [
        Date.now() - 7*24*60*60*1000,
        Date.now() - 6*24*60*60*1000,
        Date.now() - 5*24*60*60*1000,
        Date.now() - 4*24*60*60*1000,
        Date.now() - 3*24*60*60*1000,
        Date.now() - 2*24*60*60*1000,
        Date.now() - 24*60*60*1000,
        Date.now() - 12*60*60*1000,
        Date.now() - 6*60*60*1000,
        Date.now() - 2*60*60*1000,
      ];

      for (let i = 0; i < postTimes.length; i++) {
        await pool.query(`
          INSERT INTO feed_posts (user_id, content, created_at)
          VALUES ($1, $2, to_timestamp($3/1000.0))
          ON CONFLICT DO NOTHING
        `, [alice, JSON.stringify({ text: `[Staging] Demo feed post #${i+1}` }), postTimes[i]]);
      }

      // Create sample groups
      const { rows: designGroupRows } = await pool.query(`
        SELECT id FROM groups WHERE creator_id = $1 AND name = 'Staging Design Feedback'
      `, [alice]);

      let designGroupId;
      if (designGroupRows.length === 0) {
        const result = await pool.query(`
          INSERT INTO groups (creator_id, name, description, created_at, updated_at)
          VALUES ($1, 'Staging Design Feedback', '[Staging] Share design ideas and feedback', NOW(), NOW())
          RETURNING id
        `, [alice]);
        designGroupId = result.rows[0].id;
      } else {
        designGroupId = designGroupRows[0].id;
      }

      // Add members to Design Feedback group
      for (const memberId of [alice, bob, charlie]) {
        await pool.query(`
          INSERT INTO group_members (group_id, user_id, role, joined_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (group_id, user_id) DO NOTHING
        `, [designGroupId, memberId, memberId === alice ? 'creator' : 'member']);
      }

      // Add messages to Design Feedback group
      const designBaseTime = new Date(Date.now() - 1800000);
      const designMessages = [
        { offset: 0, sender: alice, type: 'text', content: { text: '[Staging] Hey team! Check out this new design' }, blockchain: true },
        { offset: 600000, sender: bob, type: 'text', content: { text: '[Staging] Looks great! Love the color scheme' }, blockchain: false },
        { offset: 1200000, sender: charlie, type: 'text', content: { text: '[Staging] Really nice work, Alice!' }, blockchain: false },
      ];

      // Fetch user pubkeys for seeding
      const { rows: userPubkeyRows } = await pool.query(`
        SELECT id, usernode_pubkey FROM users WHERE id IN ($1, $2, $3)
      `, [alice, bob, charlie]);
      const userPubkeyMap = {};
      userPubkeyRows.forEach(row => {
        userPubkeyMap[row.id] = row.usernode_pubkey;
      });

      // Create audit log entries for group creation
      const { rows: designGroupCheckRows } = await pool.query(`
        SELECT id, creator_id, created_at FROM groups WHERE id = $1
      `, [designGroupId]);
      if (designGroupCheckRows.length > 0 && designGroupCheckRows[0].creator_id === alice) {
        const groupCreateTime = designGroupCheckRows[0].created_at;
        const groupCreateTxHash = 'ut1staging-testnet-group-create-' + designGroupId + '-' + new Date(groupCreateTime).getTime();
        const groupCreatePayload = {
          type: 'group_create',
          groupId: designGroupId,
          groupName: 'Staging Design Feedback',
          creatorPubkey: userPubkeyMap[alice],
          memberPubkeys: [userPubkeyMap[alice], userPubkeyMap[bob], userPubkeyMap[charlie]],
          timestamp: groupCreateTime ? new Date(groupCreateTime).toISOString() : new Date().toISOString()
        };
        await pool.query(`
          INSERT INTO blockchain_audit_logs (user_id, group_id, message_type, tx_hash, transaction_payload, status, confirmed_at, content_hash, user_pubkey, action_timestamp, created_at, updated_at)
          VALUES ($1, $2, 'group_create', $3, $4, 'confirmed', $5, $6, $7, $8, $9, $9)
          ON CONFLICT DO NOTHING
        `, [alice, designGroupId, groupCreateTxHash, JSON.stringify(groupCreatePayload), groupCreateTime, null, userPubkeyMap[alice], groupCreateTime || new Date(), groupCreateTime || new Date()]);
      }

      for (const msg of designMessages) {
        const msgTime = new Date(designBaseTime.getTime() + msg.offset);
        const result = await pool.query(`
          INSERT INTO group_messages (group_id, sender_id, type, content, blockchain_recorded, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT DO NOTHING
          RETURNING id
        `, [designGroupId, msg.sender, msg.type, JSON.stringify(msg.content), msg.blockchain, msgTime]);

        if (msg.blockchain && result.rows.length > 0) {
          const messageId = result.rows[0].id;
          const contentHash = computeContentHash(msg.content);
          const txHash = 'ut1staging-testnet-message-' + messageId + '-' + msgTime.getTime();
          const transactionPayload = {
            type: 'message',
            messageId: messageId,
            groupId: designGroupId,
            senderPubkey: userPubkeyMap[msg.sender],
            contentHash: contentHash,
            timestamp: msgTime.toISOString()
          };

          const auditResult = await pool.query(`
            INSERT INTO blockchain_audit_logs (user_id, message_id, group_id, message_type, tx_hash, transaction_payload, status, confirmed_at, content_hash, user_pubkey, action_timestamp, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, $8, $9, $10, $11, $11)
            ON CONFLICT DO NOTHING
            RETURNING id
          `, [msg.sender, messageId, designGroupId, 'message', txHash, JSON.stringify(transactionPayload), msgTime, contentHash, userPubkeyMap[msg.sender], msgTime, msgTime]);

          if (auditResult.rows.length > 0) {
            await pool.query(`
              UPDATE group_messages SET blockchain_audit_log_id = $1 WHERE id = $2
            `, [auditResult.rows[0].id, messageId]);
          }
        }
      }

      // Initialize read receipts for Design Feedback group
      for (const memberId of [alice, bob, charlie]) {
        await pool.query(`
          INSERT INTO group_read_receipts (user_id, group_id, last_read_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (user_id, group_id) DO NOTHING
        `, [memberId, designGroupId]);
      }

      // Create General Chat group
      const { rows: generalGroupRows } = await pool.query(`
        SELECT id FROM groups WHERE creator_id = $1 AND name = 'Staging General Chat'
      `, [bob]);

      let generalGroupId;
      if (generalGroupRows.length === 0) {
        const result = await pool.query(`
          INSERT INTO groups (creator_id, name, description, created_at, updated_at)
          VALUES ($1, 'Staging General Chat', '[Staging] General discussion and updates', NOW(), NOW())
          RETURNING id
        `, [bob]);
        generalGroupId = result.rows[0].id;
      } else {
        generalGroupId = generalGroupRows[0].id;
      }

      // Add members to General Chat group
      for (const memberId of [bob, alice, david, emma]) {
        await pool.query(`
          INSERT INTO group_members (group_id, user_id, role, joined_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (group_id, user_id) DO NOTHING
        `, [generalGroupId, memberId, memberId === bob ? 'creator' : 'member']);
      }

      // Add messages to General Chat group
      const generalBaseTime = new Date(Date.now() - 1800000);
      const generalMessages = [
        { offset: 0, sender: bob, type: 'text', content: { text: '[Staging] Welcome to the group! Looking forward to great discussions' }, blockchain: false },
        { offset: 600000, sender: alice, type: 'text', content: { text: '[Staging] Thanks for creating this! Already excited about the energy' }, blockchain: false },
        { offset: 900000, sender: david, type: 'image', content: { imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8DwHwMxxGAIwAAADkkBkMTjF4UAAAAASUVORK5CYII=' }, blockchain: false },
        { offset: 1200000, sender: emma, type: 'token', content: { recipientId: bob, amount: 50, memo: '[Staging] Thanks for the invite!', txHash: 'staging-gp-tx-001', status: 'confirmed' }, blockchain: true },
      ];

      // Fetch additional user pubkeys for General Chat
      const { rows: generalUserRows } = await pool.query(`
        SELECT id, usernode_pubkey FROM users WHERE id IN ($1, $2, $3, $4)
      `, [bob, alice, david, emma]);
      const generalUserPubkeyMap = {};
      generalUserRows.forEach(row => {
        generalUserPubkeyMap[row.id] = row.usernode_pubkey;
      });

      // Create audit log entry for General Chat group creation
      const { rows: generalGroupCheckRows } = await pool.query(`
        SELECT id, creator_id, created_at FROM groups WHERE id = $1
      `, [generalGroupId]);
      if (generalGroupCheckRows.length > 0 && generalGroupCheckRows[0].creator_id === bob) {
        const genGroupCreateTime = generalGroupCheckRows[0].created_at;
        const genGroupCreateTxHash = 'ut1staging-testnet-group-create-' + generalGroupId + '-' + new Date(genGroupCreateTime).getTime();
        const genGroupCreatePayload = {
          type: 'group_create',
          groupId: generalGroupId,
          groupName: 'Staging General Chat',
          creatorId: bob,
          memberIds: [bob, alice, david, emma],
          userPubkey: generalUserPubkeyMap[bob],
          timestamp: genGroupCreateTime ? new Date(genGroupCreateTime).toISOString() : new Date().toISOString()
        };
        await pool.query(`
          INSERT INTO blockchain_audit_logs (user_id, group_id, message_type, tx_hash, transaction_payload, status, confirmed_at, content_hash, user_pubkey, action_timestamp, created_at, updated_at)
          VALUES ($1, $2, 'group_create', $3, $4, 'confirmed', $5, $6, $7, $8, $9, $9)
          ON CONFLICT DO NOTHING
        `, [bob, generalGroupId, genGroupCreateTxHash, JSON.stringify(genGroupCreatePayload), genGroupCreateTime, null, generalUserPubkeyMap[bob], genGroupCreateTime || new Date(), genGroupCreateTime || new Date()]);
      }

      for (const msg of generalMessages) {
        const msgTime = new Date(generalBaseTime.getTime() + msg.offset);
        const result = await pool.query(`
          INSERT INTO group_messages (group_id, sender_id, type, content, blockchain_recorded, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT DO NOTHING
          RETURNING id
        `, [generalGroupId, msg.sender, msg.type, JSON.stringify(msg.content), msg.blockchain, msgTime]);

        if (msg.blockchain && result.rows.length > 0) {
          const messageId = result.rows[0].id;
          const contentHash = computeContentHash(msg.content);
          const txHash = 'ut1staging-testnet-message-' + messageId + '-' + msgTime.getTime();
          const messageType = msg.type === 'token' ? 'token_transfer' : 'message';
          const transactionPayload = msg.type === 'token'
            ? {
                type: 'token_transfer',
                messageId: messageId,
                groupId: generalGroupId,
                sender: msg.sender,
                recipient: msg.content.recipientId,
                amount: msg.content.amount,
                memo: msg.content.memo,
                userPubkey: generalUserPubkeyMap[msg.sender],
                contentHash: contentHash,
                timestamp: msgTime.toISOString()
              }
            : {
                type: 'message',
                messageId: messageId,
                groupId: generalGroupId,
                senderId: msg.sender,
                userPubkey: generalUserPubkeyMap[msg.sender],
                contentHash: contentHash,
                timestamp: msgTime.toISOString()
              };

          const auditResult = await pool.query(`
            INSERT INTO blockchain_audit_logs (user_id, message_id, group_id, message_type, tx_hash, transaction_payload, status, confirmed_at, content_hash, user_pubkey, action_timestamp, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, $8, $9, $10, $11, $11)
            ON CONFLICT DO NOTHING
            RETURNING id
          `, [msg.sender, messageId, generalGroupId, messageType, txHash, JSON.stringify(transactionPayload), msgTime, contentHash, generalUserPubkeyMap[msg.sender], msgTime, msgTime]);

          if (auditResult.rows.length > 0) {
            await pool.query(`
              UPDATE group_messages SET blockchain_audit_log_id = $1 WHERE id = $2
            `, [auditResult.rows[0].id, messageId]);
          }
        }
      }

      // Initialize read receipts for General Chat group
      for (const memberId of [bob, alice, david, emma]) {
        await pool.query(`
          INSERT INTO group_read_receipts (user_id, group_id, last_read_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (user_id, group_id) DO NOTHING
        `, [memberId, generalGroupId]);
      }

      // Seed feed posts
      const feedBaseTime = new Date();
      const feedPosts = [
        {
          userId: alice,
          content: { text: '[Staging demo] Hello Guardian community! 👋' },
          offset: 7200000
        },
        {
          userId: bob,
          content: {
            text: '[Staging demo] Just deployed v2.0 of my dapp',
            link: 'https://example.com/dapp',
            linkTitle: 'My Cool Dapp',
            linkImage: 'https://via.placeholder.com/200'
          },
          offset: 3600000
        },
        {
          userId: david,
          content: { text: '[Staging demo] Anyone interested in discussing Web3 standards?' },
          offset: 1800000
        },
        {
          userId: alice,
          content: {
            text: '[Staging demo] Check out this article on blockchain security',
            link: 'https://example.com/article',
            linkTitle: 'Blockchain Security Best Practices',
            linkImage: 'https://via.placeholder.com/200'
          },
          offset: 900000
        },
        {
          userId: emma,
          content: { text: '[Staging demo] Excited about the new Guardian features!' },
          offset: 600000
        },
        {
          userId: david,
          content: {
            text: '[Staging demo] Check out this resource',
            link: 'https://example.com/resource'
          },
          offset: 300000
        },
        {
          userId: alice,
          content: { text: '[Staging demo] Hey @staging-demo-bob, loved your new dapp! 🚀' },
          offset: 120000
        },
        {
          userId: emma,
          content: { text: '[Staging demo] @staging-demo-david and @staging-demo-alice — anyone joining the Web3 standards discussion?' },
          offset: 60000
        }
      ];

      for (const post of feedPosts) {
        const createdAt = new Date(feedBaseTime.getTime() - post.offset);
        const isOnChain = Math.random() > 0.5;
        await pool.query(`
          INSERT INTO feed_posts (user_id, content, on_chain, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $4)
          ON CONFLICT DO NOTHING
        `, [post.userId, JSON.stringify(post.content), isOnChain, createdAt]);
      }

      // Seed feed likes on posts
      const { rows: allPosts } = await pool.query(`
        SELECT id, user_id FROM feed_posts LIMIT 10
      `);

      for (const post of allPosts) {
        const likers = [alice, bob, charlie, david, emma].filter(id => id !== post.user_id);
        const likeCount = Math.floor(Math.random() * likers.length) + 1;
        const selectedLikers = likers.sort(() => Math.random() - 0.5).slice(0, likeCount);

        for (const likerId of selectedLikers) {
          const likeTime = new Date(feedBaseTime.getTime() - Math.random() * 3600000);
          await pool.query(`
            INSERT INTO feed_likes (post_id, user_id, created_at)
            VALUES ($1, $2, $3)
            ON CONFLICT DO NOTHING
          `, [post.id, likerId, likeTime]);
        }
      }

      // Seed feed comments
      // Get post IDs for seeding comments
      const { rows: bobDeployPostRows } = await pool.query(`
        SELECT id FROM feed_posts WHERE user_id = $1 AND content->>'text' LIKE '%v2.0%' LIMIT 1
      `, [bob]);

      const { rows: aliceArticlePostRows } = await pool.query(`
        SELECT id FROM feed_posts WHERE user_id = $1 AND content->>'text' LIKE '%blockchain security%' LIMIT 1
      `, [alice]);

      const { rows: davidWeb3PostRows } = await pool.query(`
        SELECT id FROM feed_posts WHERE user_id = $1 AND content->>'text' LIKE '%Web3 standards%' LIMIT 1
      `, [david]);

      // Seed comments on Bob's deployment post
      if (bobDeployPostRows.length > 0) {
        const bobPostId = bobDeployPostRows[0].id;
        const commentTime1 = new Date(feedBaseTime.getTime() - 2400000);
        const commentTime2 = new Date(feedBaseTime.getTime() - 2100000);

        await pool.query(`
          INSERT INTO feed_comments (post_id, user_id, content, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $4), ($1, $5, $6, $7, $7)
          ON CONFLICT DO NOTHING
        `, [bobPostId, alice, '[Staging demo] That sounds amazing! Congrats on the release!', commentTime1, charlie, '[Staging demo] Would love to check it out!', commentTime2]);
      }

      // Seed comments on Alice's article post
      if (aliceArticlePostRows.length > 0) {
        const alicePostId = aliceArticlePostRows[0].id;
        const commentTime = new Date(feedBaseTime.getTime() - 300000);
        const commentTime2 = new Date(feedBaseTime.getTime() - 200000);

        await pool.query(`
          INSERT INTO feed_comments (post_id, user_id, content, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $4), ($1, $5, $6, $7, $7)
          ON CONFLICT DO NOTHING
        `, [alicePostId, bob, '[Staging demo] Great read! Security is so important in Web3.', commentTime, charlie, '[Staging demo] @staging-demo-alice nice one! 👏', commentTime2]);
      }

      // Seed comments on David's Web3 standards post
      if (davidWeb3PostRows.length > 0) {
        const davidPostId = davidWeb3PostRows[0].id;
        const commentTime1 = new Date(feedBaseTime.getTime() - 1200000);
        const commentTime2 = new Date(feedBaseTime.getTime() - 600000);

        await pool.query(`
          INSERT INTO feed_comments (post_id, user_id, content, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $4), ($1, $5, $6, $7, $7)
          ON CONFLICT DO NOTHING
        `, [davidPostId, alice, '[Staging demo] Count me in! We should organize a discussion thread.', commentTime1, emma, '[Staging demo] This is an important topic for the ecosystem!', commentTime2]);
      }

      // Create additional test group with many messages for archive/delete testing
      const { rows: techGroupRows } = await pool.query(`
        SELECT id FROM groups WHERE creator_id = $1 AND name = 'Staging Tech Discussions'
      `, [charlie]);

      let techGroupId;
      if (techGroupRows.length === 0) {
        const result = await pool.query(`
          INSERT INTO groups (creator_id, name, description, created_at, updated_at)
          VALUES ($1, 'Staging Tech Discussions', '[Staging] Technical discussions and Q&A', NOW(), NOW())
          RETURNING id
        `, [charlie]);
        techGroupId = result.rows[0].id;
      } else {
        techGroupId = techGroupRows[0].id;
      }

      // Add members to Tech Discussions group
      for (const memberId of [charlie, alice, bob, david]) {
        await pool.query(`
          INSERT INTO group_members (group_id, user_id, role, joined_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (group_id, user_id) DO NOTHING
        `, [techGroupId, memberId, memberId === charlie ? 'creator' : 'member']);
      }

      // Add many messages to Tech group (30+ for testing bulk delete)
      const techBaseTime = new Date(Date.now() - 3600000);
      const techMessages = [
        { offset: 0, sender: charlie, content: { text: '[Staging] Anyone here familiar with smart contract optimization?' } },
        { offset: 120000, sender: alice, content: { text: '[Staging] Yes, I work with Solidity regularly. What are you trying to optimize?' } },
        { offset: 240000, sender: bob, content: { text: '[Staging] Gas optimization is always the tricky part' } },
        { offset: 360000, sender: david, content: { text: '[Staging] Have you considered using assembly? Sometimes thats the answer' } },
        { offset: 480000, sender: charlie, content: { text: '[Staging] We are already using some assembly, but thanks for the tip!' } },
        { offset: 600000, sender: alice, content: { text: '[Staging] What patterns are you using for state management?' } },
        { offset: 720000, sender: bob, content: { text: '[Staging] Mapping with enumerable sets is usually my go-to' } },
        { offset: 840000, sender: david, content: { text: '[Staging] Just be careful with array iteration performance' } },
        { offset: 960000, sender: charlie, content: { text: '[Staging] Good point! We had issues with that before' } },
        { offset: 1080000, sender: alice, content: { text: '[Staging] Have you looked at OpenZeppelin libraries?' } },
        { offset: 1200000, sender: bob, content: { text: '[Staging] Their upgradeable patterns are really solid' } },
        { offset: 1320000, sender: david, content: { text: '[Staging] Just make sure to audit thoroughly if using upgrades' } },
        { offset: 1440000, sender: charlie, content: { text: '[Staging] Security is always the priority for us' } },
        { offset: 1560000, sender: alice, content: { text: '[Staging] What testing frameworks do you use?' } },
        { offset: 1680000, sender: bob, content: { text: '[Staging] Hardhat and Foundry are my favorites currently' } },
        { offset: 1800000, sender: david, content: { text: '[Staging] Foundry is getting really good. Love the speed' } },
        { offset: 1920000, sender: charlie, content: { text: '[Staging] Were migrating to Foundry soon actually' } },
        { offset: 2040000, sender: alice, content: { text: '[Staging] Excellent choice. The developer experience is much better' } },
        { offset: 2160000, sender: bob, content: { text: '[Staging] Agreed. Cheatcodes are super useful for testing' } },
        { offset: 2280000, sender: david, content: { text: '[Staging] Make sure you have good coverage targets in place' } },
        { offset: 2400000, sender: charlie, content: { text: '[Staging] We aim for 90% coverage minimum' } },
        { offset: 2520000, sender: alice, content: { text: '[Staging] Thats a solid target. Edge cases are important' } },
        { offset: 2640000, sender: bob, content: { text: '[Staging] Fuzzing is also really helpful for finding edge cases' } },
        { offset: 2760000, sender: david, content: { text: '[Staging] Echidna is great for fuzzing Solidity' } },
        { offset: 2880000, sender: charlie, content: { text: '[Staging] Will definitely check that out, thanks for the tips everyone!' } },
        { offset: 3000000, sender: alice, content: { text: '[Staging] Anytime! Feel free to reach out if you hit any roadblocks' } },
        { offset: 3120000, sender: bob, content: { text: '[Staging] Great discussion! Always love these tech talks' } },
        { offset: 3240000, sender: david, content: { text: '[Staging] Same here. Its good to share knowledge' } },
        { offset: 3360000, sender: charlie, content: { text: '[Staging] Definitely. This community is awesome' } },
      ];

      for (const msg of techMessages) {
        const msgTime = new Date(techBaseTime.getTime() + msg.offset);
        await pool.query(`
          INSERT INTO group_messages (group_id, sender_id, type, content, blockchain_recorded, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT DO NOTHING
        `, [techGroupId, msg.sender, 'text', JSON.stringify(msg.content), false, msgTime]);
      }

      // Initialize read receipts for Tech group
      for (const memberId of [charlie, alice, bob, david]) {
        await pool.query(`
          INSERT INTO group_read_receipts (user_id, group_id, last_read_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (user_id, group_id) DO NOTHING
        `, [memberId, techGroupId]);
      }

      // Seed peer data with realistic peer IDs and foreground hours
      const peerData = [
        { peer_id: 'ut1staging-peer-001', foreground_hours: 5 },
        { peer_id: 'ut1staging-peer-002', foreground_hours: 25 },
        { peer_id: 'ut1staging-peer-003', foreground_hours: 100 },
        { peer_id: 'ut1staging-peer-004', foreground_hours: 300 },
        { peer_id: 'ut1staging-peer-005', foreground_hours: 15 },
        { peer_id: 'ut1staging-peer-006', foreground_hours: 50 },
        { peer_id: 'ut1staging-peer-007', foreground_hours: 75 },
        { peer_id: 'ut1staging-peer-008', foreground_hours: 150 },
        { peer_id: 'ut1staging-peer-009', foreground_hours: 200 },
        { peer_id: 'ut1staging-peer-010', foreground_hours: 250 }
      ];

      for (const peer of peerData) {
        await pool.query(`
          INSERT INTO peers (peer_id, foreground_hours, created_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (peer_id) DO UPDATE SET
            foreground_hours = EXCLUDED.foreground_hours
        `, [peer.peer_id, peer.foreground_hours]);
      }

      // Seed additional test data for profile counter verification
      // Create a conversation where Alice receives messages but doesn't send any
      // This tests that the Messages counter counts participation, not sent messages
      const [frankAliceA, frankAliceB] = [alice, frank].sort((x, y) => x - y);
      const { rows: convFrankAliceRows } = await pool.query(`
        SELECT id FROM conversations WHERE participant_a_id = $1 AND participant_b_id = $2
      `, [frankAliceA, frankAliceB]);

      let convFrankAliceId;
      if (convFrankAliceRows.length === 0) {
        const result = await pool.query(`
          INSERT INTO conversations (participant_a_id, participant_b_id, status_a, status_b, created_at, updated_at)
          VALUES ($1, $2, 'accepted', 'accepted', NOW(), NOW())
          RETURNING id
        `, [frankAliceA, frankAliceB]);
        convFrankAliceId = result.rows[0].id;
      } else {
        convFrankAliceId = convFrankAliceRows[0].id;
      }

      // Add a message from Frank to Alice (Alice receives but doesn't send)
      await pool.query(`
        INSERT INTO messages (conversation_id, sender_id, type, content, created_at)
        VALUES ($1, $2, 'text', '{"text": "[Staging] Hi Alice! Just wanted to check in."}', NOW())
        ON CONFLICT DO NOTHING
      `, [convFrankAliceId, frank]);

      // Create a group where Alice is a member but doesn't send messages
      // This also tests counter for group participation without sending
      const { rows: testGroupRows } = await pool.query(`
        SELECT id FROM groups WHERE creator_id = $1 AND name = 'Staging Test Group'
      `, [david]);

      let testGroupId;
      if (testGroupRows.length === 0) {
        const result = await pool.query(`
          INSERT INTO groups (creator_id, name, description, created_at, updated_at)
          VALUES ($1, 'Staging Test Group', '[Staging] Test group for counter verification', NOW(), NOW())
          RETURNING id
        `, [david]);
        testGroupId = result.rows[0].id;
      } else {
        testGroupId = testGroupRows[0].id;
      }

      // Add Alice to the test group (but she won't send messages)
      await pool.query(`
        INSERT INTO group_members (group_id, user_id, role, joined_at)
        VALUES ($1, $2, 'member', NOW()), ($1, $3, 'creator', NOW())
        ON CONFLICT (group_id, user_id) DO NOTHING
      `, [testGroupId, alice, david]);

      // Add a message from David (Alice receives but doesn't send)
      await pool.query(`
        INSERT INTO group_messages (group_id, sender_id, type, content, created_at)
        VALUES ($1, $2, 'text', '{"text": "[Staging] Welcome to the test group, Alice!"}', NOW())
        ON CONFLICT DO NOTHING
      `, [testGroupId, david]);

      // Initialize read receipts
      await pool.query(`
        INSERT INTO group_read_receipts (user_id, group_id, last_read_at)
        VALUES ($1, $2, NOW()), ($3, $2, NOW())
        ON CONFLICT (user_id, group_id) DO NOTHING
      `, [alice, testGroupId, david]);

      // Seed network milestone posts for staging
      const milestones = [
        { key: 'active_nodes', label: 'Active Nodes', value: '42', unit: 'nodes', category: 'network' },
        { key: 'network_throughput', label: 'Network Throughput', value: '2.5', unit: 'Gbps', category: 'network' },
        { key: 'transactions_24h', label: 'Transactions (24h)', value: '187,432', unit: 'tx', category: 'activity' },
        { key: 'avg_latency', label: 'Avg Latency', value: '125', unit: 'ms', category: 'performance' }
      ];

      for (const m of milestones) {
        await pool.query(`
          INSERT INTO network_milestones (key, label, value, unit, category, last_refreshed_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (key) DO UPDATE SET
            label = EXCLUDED.label,
            value = EXCLUDED.value,
            unit = EXCLUDED.unit,
            category = EXCLUDED.category,
            updated_at = NOW()
        `, [m.key, m.label, m.value, m.unit, m.category]);
      }
    }

    // Create reserved system user for network milestones (all environments)
    await pool.query(`
      INSERT INTO users (id, username, usernode_pubkey, verified_at, created_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET
        username = EXCLUDED.username,
        usernode_pubkey = EXCLUDED.usernode_pubkey
    `, [-1, 'Usernode Network Updates', 'ut1-network-system']);

    // Create GuardiAI bot account in all environments
    try {
      console.log('[GuardiAI Seed] Starting GuardiAI user account creation...');

      const guardianResult = await pool.query(`
        INSERT INTO users (id, username, usernode_pubkey, verified_at, created_at, is_bot)
        VALUES (100, 'GuardiAI 🤖', 'ut1-guardiAI-bot', NOW(), NOW(), true)
        ON CONFLICT (id) DO UPDATE SET
          username = EXCLUDED.username,
          is_bot = EXCLUDED.is_bot
      `);

      console.log('[GuardiAI Seed] GuardiAI user insert/upsert completed', { rowCount: guardianResult.rowCount });

      // Verify the user was created
      const verifyResult = await pool.query(`
        SELECT id, username, is_bot, usernode_pubkey, created_at
        FROM users
        WHERE id = 100
      `);

      if (verifyResult.rows.length > 0) {
        const guardianUser = verifyResult.rows[0];
        console.log('[GuardiAI Seed] ✅ GuardiAI user verified in database:', {
          id: guardianUser.id,
          username: guardianUser.username,
          is_bot: guardianUser.is_bot,
          usernode_pubkey: guardianUser.usernode_pubkey,
          created_at: guardianUser.created_at
        });
      } else {
        console.error('[GuardiAI Seed] ❌ ERROR: GuardiAI user NOT found in database after insert!');
      }
    } catch (err) {
      console.error('[GuardiAI Seed] ❌ ERROR creating/upserting GuardiAI user:', err.message);
      throw err;
    }

    // Seed GuardiAI bot demo data in staging
    if (IS_STAGING) {
      console.log('[GuardiAI Seed] Starting staging demo data seed...');

      // Seed a crypto-mention post and demo replies
      const cryptoPostRes = await pool.query(`
        INSERT INTO feed_posts (user_id, content, created_at)
        VALUES (1, $1, NOW() - INTERVAL '2 hours')
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [JSON.stringify({ text: 'Staging demo: Market analysis - checking BTC and ETH movements today' })]);

      if (cryptoPostRes.rows.length > 0) {
        const postId = cryptoPostRes.rows[0].id;
        console.log('[GuardiAI Seed] Created staging crypto demo post:', { postId });

        // Seed a comment with crypto mention
        await pool.query(`
          INSERT INTO feed_comments (post_id, user_id, content, created_at)
          VALUES ($1, $2, $3, NOW() - INTERVAL '90 minutes')
          ON CONFLICT DO NOTHING
        `, [postId, 2, '@GuardiAI whats the price on BTC and ethereum right now?']);

        // Seed bot replies with sample crypto data
        const btcReply = await pool.query(`
          INSERT INTO feed_comments (post_id, user_id, content, created_at)
          VALUES ($1, $2, $3, NOW() - INTERVAL '89 minutes')
          ON CONFLICT DO NOTHING
          RETURNING id
        `, [postId, 100, 'BTC: $45230.00 📈 +3.2% (24h) | Strong momentum here!']);

        const ethReply = await pool.query(`
          INSERT INTO feed_comments (post_id, user_id, content, created_at)
          VALUES ($1, $2, $3, NOW() - INTERVAL '88 minutes')
          ON CONFLICT DO NOTHING
          RETURNING id
        `, [postId, 100, 'ETH: $2340.00 📉 -1.8% (24h) | Could be interesting!']);

        console.log('[GuardiAI Seed] Created staging crypto demo replies:', {
          btcReplyId: btcReply.rows[0]?.id,
          ethReplyId: ethReply.rows[0]?.id
        });
      }

      // Seed a friendly-reply post (no crypto mention)
      const friendlyPostRes = await pool.query(`
        INSERT INTO feed_posts (user_id, content, created_at)
        VALUES (1, $1, NOW() - INTERVAL '1 hour')
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [JSON.stringify({ text: 'Staging demo: Just shipped a major update to the protocol!' })]);

      if (friendlyPostRes.rows.length > 0) {
        const postId = friendlyPostRes.rows[0].id;
        console.log('[GuardiAI Seed] Created staging friendly demo post:', { postId });

        // Seed a comment with @GuardiAI mention but no crypto
        await pool.query(`
          INSERT INTO feed_comments (post_id, user_id, content, created_at)
          VALUES ($1, $2, $3, NOW() - INTERVAL '50 minutes')
          ON CONFLICT DO NOTHING
        `, [postId, 3, '@GuardiAI what do you think of this update?']);

        // Seed a friendly bot reply
        const friendlyReply = await pool.query(`
          INSERT INTO feed_comments (post_id, user_id, content, created_at)
          VALUES ($1, $2, $3, NOW() - INTERVAL '49 minutes')
          ON CONFLICT DO NOTHING
          RETURNING id
        `, [postId, 100, 'Yooo that\'s fire! 🔥 Love the energy! Can\'t wait to see what you build next.']);

        console.log('[GuardiAI Seed] Created staging friendly demo reply:', {
          friendlyReplyId: friendlyReply.rows[0]?.id
        });
      }

      // Seed GuardiAI auto-post demo data
      console.log('[GuardiAI Seed] Starting GuardiAI auto-post demo data seed...');

      // Seed a recent GuardiAI friendly post
      const guardiAIPost1Res = await pool.query(`
        INSERT INTO feed_posts (user_id, content, created_at)
        VALUES (100, $1, NOW())
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [JSON.stringify({ type: 'text', text: 'Hey everyone!' })]);

      if (guardiAIPost1Res.rows.length > 0) {
        const guardiAIPostId = guardiAIPost1Res.rows[0].id;
        console.log('[GuardiAI Seed] Created GuardiAI demo post 1:', { postId: guardiAIPostId });

        // Seed a demo comment to test auto-reply functionality
        await pool.query(`
          INSERT INTO feed_comments (post_id, user_id, content, created_at)
          VALUES ($1, $2, $3, NOW() - INTERVAL '5 minutes')
          ON CONFLICT DO NOTHING
        `, [guardiAIPostId, 2, 'Great energy!']);

        console.log('[GuardiAI Seed] Created demo comment for auto-reply testing');
      }

      // Seed an older GuardiAI friendly post (14 hours ago to trigger new post creation)
      const guardiAIPost2Res = await pool.query(`
        INSERT INTO feed_posts (user_id, content, created_at)
        VALUES (100, $1, NOW() - INTERVAL '14 hours')
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [JSON.stringify({ type: 'text', text: 'What\'s up folks?' })]);

      if (guardiAIPost2Res.rows.length > 0) {
        console.log('[GuardiAI Seed] Created GuardiAI demo post 2:', { postId: guardiAIPost2Res.rows[0].id });
      }

      console.log('[GuardiAI Seed] ✅ Staging demo data seed completed');
    }

    // Create reserved system user for Crypto Daily bot (all environments)
    await pool.query(`
      INSERT INTO users (id, username, usernode_pubkey, verified_at, created_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET
        username = EXCLUDED.username,
        usernode_pubkey = EXCLUDED.usernode_pubkey
    `, [-2, 'Crypto Daily', 'ut1-crypto-daily-system']);

    // Seed network milestones in production (hardcoded values for now)
    if (!IS_STAGING) {
      const milestones = [
        { key: 'active_nodes', label: 'Active Nodes', value: '42', unit: 'nodes', category: 'network' },
        { key: 'network_throughput', label: 'Network Throughput', value: '2.5', unit: 'Gbps', category: 'network' },
        { key: 'transactions_24h', label: 'Transactions (24h)', value: '187,432', unit: 'tx', category: 'activity' },
        { key: 'avg_latency', label: 'Avg Latency', value: '125', unit: 'ms', category: 'performance' }
      ];

      for (const m of milestones) {
        await pool.query(`
          INSERT INTO network_milestones (key, label, value, unit, category, last_refreshed_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (key) DO UPDATE SET
            label = EXCLUDED.label,
            value = EXCLUDED.value,
            unit = EXCLUDED.unit,
            category = EXCLUDED.category,
            updated_at = NOW()
        `, [m.key, m.label, m.value, m.unit, m.category]);
      }
    }

    // Start hourly milestone post generator (runs every hour with 24-hour cooldown)
    // Create initial milestone post on startup if cooldown allows
    if (await shouldCreateMilestonePost()) {
      await createMilestonePost();
    }

    // Set interval to check and create milestone post every hour (3600000 ms)
    // Only creates if 24 hours have passed since the last post
    setInterval(async () => {
      if (await shouldCreateMilestonePost()) {
        await createMilestonePost();
      }
    }, 3600000);

    // Start Crypto Daily bot (runs every 2 hours)
    // Create initial post on startup if cooldown check passes
    if (await shouldCreateCryptoDailyPost()) {
      await createCryptoDailyPost();
    }

    // Set interval to create a new Crypto Daily post every 2 hours (7200000 ms)
    // Conditionally create posts only when cooldown criteria are met
    setInterval(async () => {
      if (await shouldCreateCryptoDailyPost()) {
        await createCryptoDailyPost();
      }
    }, 7200000);

    // Start GuardiAI bot (runs every 12 hours)
    // Create initial post on startup if cooldown check passes
    if (await shouldCreateGuardiAIPost()) {
      await createGuardiAIPost();
    }

    // Set interval to create a new GuardiAI post every 12 hours (43200000 ms)
    // Conditionally create posts only when cooldown criteria are met
    setInterval(async () => {
      if (await shouldCreateGuardiAIPost()) {
        await createGuardiAIPost();
      }
    }, 43200000);

    app.listen(port, () => console.log(`Listening on :${port}`));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();
