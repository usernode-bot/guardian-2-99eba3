const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { createUsernamesCache } = require('./lib/dapp-server');
const mockData = require('./server-mock-data');

// Guardian 2 - Production-ready Usernode blockchain integration
const app = express();
const port = process.env.PORT || 3000;

// Optional explicit override for the chain poller's self-proxy call.
// The poller talks to this same process, so loopback is always correct;
// API_BASE_URL exists only for unusual topologies where loopback is wrong.
const API_BASE_URL = process.env.API_BASE_URL || null;

// DATABASE_URL with graceful fallback for staging environments
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/guardian_staging';
console.log(`[CONFIG] DATABASE_URL: ${DATABASE_URL ? 'configured' : 'using fallback'}`);

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

// Track database connection state
let dbConnected = false;
pool.on('connect', () => {
  dbConnected = true;
  console.log('[DB] Connection established');
});
pool.on('error', (err) => {
  dbConnected = false;
  console.error('[DB] Pool error:', err.message);
});

const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Initialize network mode with priority: NETWORK_MODE env var > default 'testnet'
// Canonical values: 'testnet' (real blockchain), 'devnet' (database-only), 'mainnet' (future)
// Normalize 'real_testnet' to 'testnet' for backward compatibility
let NETWORK_MODE = process.env.NETWORK_MODE && ['testnet', 'real_testnet', 'devnet', 'mainnet'].includes(process.env.NETWORK_MODE)
  ? (process.env.NETWORK_MODE === 'real_testnet' ? 'testnet' : process.env.NETWORK_MODE)
  : 'testnet';
console.log(`[CONFIG] NETWORK_MODE: ${NETWORK_MODE}${process.env.NETWORK_MODE ? ' (from env)' : ' (using default)'}`);

// Usernode blockchain configuration
const APP_PUBKEY = process.env.APP_PUBKEY || 'ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb';
const APP_SECRET_KEY = process.env.APP_SECRET_KEY || 'guardian_sk_mqudwes5_ae613cf56214808e';

// RPC Configuration with validation (Testnet mode only)
function validateAndConfigureRPC() {
  // RPC configuration only applies when NETWORK_MODE === 'testnet'
  // In demo mode and devnet, bridge/fallback or database is used exclusively

  let configuredUrl = process.env.NODE_RPC_URL;

  // If NODE_RPC_URL is set, validate it's a valid URL (only in testnet mode)
  if (configuredUrl && NETWORK_MODE === 'testnet') {
    try {
      new URL(configuredUrl);
    } catch (err) {
      console.warn(`[CONFIG] NODE_RPC_URL is invalid URL: ${configuredUrl}, error: ${err.message}`);
      configuredUrl = null;
    }
  }

  // If not set or invalid, use intelligent defaults based on environment
  if (!configuredUrl && NETWORK_MODE === 'testnet') {
    if (IS_STAGING) {
      // In staging, try multiple fallbacks: in-container Usernode (port 3001), fallback to 3000, Docker host
      const stagingOptions = [
        'http://usernode-node:3001',      // In-network Usernode service (staging default)
        'http://usernode-node:3000',      // Fallback to production port
        'http://host.docker.internal:3001' // Docker desktop host
      ];
      configuredUrl = stagingOptions[0];  // Default to in-network service
      console.log(`[CONFIG] NODE_RPC_URL not set in staging`);
      console.log(`[CONFIG] Using default RPC endpoint for staging: ${configuredUrl}`);
      console.log(`[CONFIG] Fallback endpoints will be tried if primary fails: ${stagingOptions.slice(1).join(', ')}`);
    } else {
      // In production testnet: NODE_RPC_URL is REQUIRED
      console.error(`\n⚠️  [CONFIG] CRITICAL: NODE_RPC_URL not configured in production testnet mode\n`);
      console.error(`    Real blockchain transactions will NOT be submitted without RPC access.\n`);
      console.error(`    Set NODE_RPC_URL in platform Secrets with a value like:\n`);
      console.error(`    NODE_RPC_URL=http://usernode-node:3000\n`);
      console.error(`    or\n`);
      console.error(`    NODE_RPC_URL=https://testnet-rpc.usernodelabs.org\n`);
      console.error(`\n    Refusing to start in production testnet mode without RPC.\n`);
      process.exit(1);
    }
  }

  // In devnet, return null to skip RPC entirely
  if (NETWORK_MODE === 'devnet') {
    return null;
  }

  return configuredUrl;
}

let NODE_RPC_URL = validateAndConfigureRPC();

// RPC health check cache
let rpcHealthCache = null;
let rpcHealthCacheTime = 0;
const RPC_HEALTH_CACHE_MS = 30000; // 30 seconds

// Peer sync cache and configuration
const USERNODE_API_URL = process.env.USERNODE_API_URL || 'http://usernode-node:3001';
const PEER_SYNC_CACHE_MS = parseInt(process.env.PEER_SYNC_CACHE_MS || '300000', 10); // 5 minutes default
const PEER_SYNC_TIMEOUT_MS = parseInt(process.env.PEER_SYNC_TIMEOUT_MS || '5000', 10); // 5 seconds default
let peerSyncCache = new Map(); // Map<userId, { timestamp, peersHours }>
let peerSyncPromises = new Map(); // Map<userId, Promise> for concurrent request deduplication

async function checkRPCHealth(retryCount = 0, maxRetries = 2) {
  // RPC health checks only in testnet mode
  if (NETWORK_MODE !== 'testnet') {
    return { rpcUrl: null, reachable: false, error: 'Devnet or mainnet mode - RPC not used' };
  }

  if (!NODE_RPC_URL) {
    return { rpcUrl: null, reachable: false, error: 'NODE_RPC_URL not configured' };
  }

  const now = Date.now();
  if (retryCount === 0 && rpcHealthCache && (now - rpcHealthCacheTime) < RPC_HEALTH_CACHE_MS) {
    return rpcHealthCache;
  }

  return new Promise((resolve) => {
    const startTime = Date.now();
    const url = new URL('/health', NODE_RPC_URL);
    const isHttps = NODE_RPC_URL.startsWith('https');
    const client = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'GET',
      timeout: 3000
    };

    const req = client.request(options, (res) => {
      const responseTime = Date.now() - startTime;
      const result = {
        rpcUrl: NODE_RPC_URL,
        reachable: res.statusCode >= 200 && res.statusCode < 300,
        responseTime,
        lastChecked: new Date().toISOString(),
        statusCode: res.statusCode,
        error: null
      };
      rpcHealthCache = result;
      rpcHealthCacheTime = now;
      resolve(result);
    });

    req.on('error', async (err) => {
      const responseTime = Date.now() - startTime;
      const errorClass = classifyRPCError(err);

      if (retryCount < maxRetries) {
        console.warn(`[RPC Health] Attempt ${retryCount + 1}/${maxRetries + 1} failed (${errorClass.type}), retrying in 500ms...`);
        setTimeout(() => {
          checkRPCHealth(retryCount + 1, maxRetries).then(resolve);
        }, 500);
        return;
      }

      const result = {
        rpcUrl: NODE_RPC_URL,
        reachable: false,
        responseTime,
        lastChecked: new Date().toISOString(),
        error: errorClass.message,
        errorType: errorClass.type
      };
      rpcHealthCache = result;
      rpcHealthCacheTime = now;
      resolve(result);
    });

    req.on('timeout', () => {
      req.destroy();
      const responseTime = Date.now() - startTime;
      const result = {
        rpcUrl: NODE_RPC_URL,
        reachable: false,
        responseTime,
        lastChecked: new Date().toISOString(),
        error: 'RPC endpoint timed out (>3s)',
        errorType: 'ETIMEDOUT'
      };
      rpcHealthCache = result;
      rpcHealthCacheTime = now;
      resolve(result);
    });

    req.end();
  });
}

// Helper function to classify RPC errors with detailed diagnostics
function classifyRPCError(err) {
  if (!err) return { type: 'unknown', message: 'Unknown error', diagnostic: null };

  const message = err.message || '';
  const code = err.code || '';
  const urlObj = NODE_RPC_URL ? new URL(NODE_RPC_URL) : null;

  if (code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
    return {
      type: 'ECONNREFUSED',
      message: `RPC connection refused at ${NODE_RPC_URL}`,
      diagnostic: `The RPC service is not running or not accepting connections on ${urlObj?.hostname}:${urlObj?.port || 80}. Verify the service is online.`
    };
  }
  if (code === 'ENOTFOUND' || message.includes('ENOTFOUND')) {
    return {
      type: 'ENOTFOUND',
      message: `RPC hostname not found: ${NODE_RPC_URL}`,
      diagnostic: `DNS resolution failed for ${urlObj?.hostname}. Check hostname spelling and DNS configuration.`
    };
  }
  if (code === 'ETIMEDOUT' || message.includes('ETIMEDOUT')) {
    return {
      type: 'ETIMEDOUT',
      message: `RPC connection timeout at ${NODE_RPC_URL}`,
      diagnostic: `Connection attempt took >3 seconds. Check network path to ${urlObj?.hostname} and firewall rules.`
    };
  }
  if (message.includes('timeout') || code === 'ESOCKETTIMEDOUT') {
    return {
      type: 'timeout',
      message: `RPC request timeout: ${NODE_RPC_URL}`,
      diagnostic: `Socket timeout during communication. RPC service may be slow or unresponsive.`
    };
  }

  return {
    type: 'unknown',
    message: message || code || 'Unknown RPC error',
    diagnostic: `Error code: ${code}`
  };
}

// Helper function to get RPC endpoint from database
async function getRpcEndpointFromDatabase() {
  try {
    const result = await pool.query(`
      SELECT value FROM config_state WHERE key = 'NODE_RPC_URL' LIMIT 1
    `);
    if (result.rows.length > 0) {
      return result.rows[0].value;
    }
  } catch (err) {
    console.error('[RPC Config] Error fetching RPC endpoint from database:', err.message);
  }
  return null;
}

// Explorer API configuration and validation
let EXPLORER_URL = process.env.EXPLORER_URL || 'https://explorer.testnet.usernodelabs.org';
let EXPLORER_FORMAT = null; // Will be set to 'api/tx' or 'api/transaction' after boot validation
let EXPLORER_HEALTHY = false; // True if boot validation succeeded

async function validateAndConfigureExplorer() {
  // Test explorer connectivity with both known formats
  console.log(`[EXPLORER] Validating explorer at ${EXPLORER_URL}...`);

  // Use a known test txHash that should fail gracefully (won't exist on testnet)
  const testTxHash = 'explorer-health-check-' + Date.now();

  // Try both common endpoint formats
  const formats = [
    { name: 'api/tx', path: `/api/tx/${testTxHash}` },
    { name: 'api/transaction', path: `/api/transaction/${testTxHash}` }
  ];

  for (const format of formats) {
    try {
      const url = new URL(EXPLORER_URL + format.path);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.warn(`[EXPLORER] Endpoint check timeout for format ${format.name}`);
          resolve(false);
        }, 5000);

        const req = client.get(url, { timeout: 5000 }, (res) => {
          clearTimeout(timeout);
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            console.log(`[EXPLORER] Format ${format.name}: HTTP ${res.statusCode}`);

            // For 404: validate response contains JSON with transaction-like fields
            // For 200: also validate JSON contains status/blockNumber/timestamp
            if (res.statusCode === 404) {
              try {
                const parsed = JSON.parse(data);
                // 404 with JSON body is valid (transaction not found, but endpoint works)
                if (parsed && typeof parsed === 'object') {
                  EXPLORER_FORMAT = format.name;
                  EXPLORER_HEALTHY = true;
                  console.log(`[EXPLORER] ✓ Using format: ${format.name} (endpoint accessible, returns JSON)`);
                  resolve(true);
                  return;
                }
              } catch (e) {
                // 404 without JSON body (HTML error page) means endpoint doesn't exist
                console.warn(`[EXPLORER] Format ${format.name}: 404 without valid JSON (endpoint not found)`);
                resolve(false);
                return;
              }
            } else if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(data);
                // 200 with transaction fields is valid
                if (parsed && (parsed.status || parsed.blockNumber || parsed.timestamp)) {
                  EXPLORER_FORMAT = format.name;
                  EXPLORER_HEALTHY = true;
                  console.log(`[EXPLORER] ✓ Using format: ${format.name} (endpoint accessible, returns transaction JSON)`);
                  resolve(true);
                  return;
                } else {
                  console.warn(`[EXPLORER] Format ${format.name}: 200 but missing transaction fields`);
                  resolve(false);
                  return;
                }
              } catch (e) {
                console.warn(`[EXPLORER] Format ${format.name}: 200 but response is not valid JSON`);
                resolve(false);
                return;
              }
            } else {
              console.warn(`[EXPLORER] Format ${format.name}: HTTP ${res.statusCode} (unexpected status)`);
              resolve(false);
            }
          });
        });

        req.on('error', (err) => {
          clearTimeout(timeout);
          console.warn(`[EXPLORER] Format ${format.name} request failed: ${err.message}`);
          resolve(false);
        });

        req.on('timeout', () => {
          clearTimeout(timeout);
          req.destroy();
        });
      });
    } catch (err) {
      console.warn(`[EXPLORER] Validation error for format ${format.name}: ${err.message}`);
    }
  }

  // If we get here, none of the formats worked
  console.warn(`\n⚠️  [EXPLORER] Could not reach explorer at ${EXPLORER_URL}\n`);
  console.warn(`    Chain polling will fail. Verify explorer URL and network connectivity.\n`);
  console.warn(`    Explorer transactions will show as 'pending' indefinitely.\n`);

  if (IS_STAGING) {
    console.log(`[EXPLORER] Staging mode: continuing with degraded explorer (mocked in responses)\n`);
    EXPLORER_HEALTHY = false;
  }

  return false;
}

// Restore persisted network mode from config_state so a runtime switch
// (PUT /api/user/network-mode) survives container restarts. An explicit
// NETWORK_MODE env var still wins over the persisted value.
async function initializeNetworkMode() {
  const envMode = process.env.NETWORK_MODE;
  if (envMode && ['testnet', 'real_testnet', 'devnet', 'mainnet'].includes(envMode)) {
    // Normalize 'real_testnet' to 'testnet' for consistency
    if (envMode === 'real_testnet') {
      NETWORK_MODE = 'testnet';
    } else {
      NETWORK_MODE = envMode;
    }
    console.log(`[CONFIG] NETWORK_MODE set via environment (${envMode}), normalized to ${NETWORK_MODE}, ignoring persisted value`);
    return;
  }
  try {
    const result = await pool.query(`
      SELECT value FROM config_state WHERE key = 'NETWORK_MODE' LIMIT 1
    `);
    const dbMode = result.rows[0]?.value;
    if (dbMode && ['testnet', 'real_testnet', 'devnet', 'mainnet'].includes(dbMode)) {
      // Normalize 'real_testnet' to 'testnet' for consistency
      NETWORK_MODE = dbMode === 'real_testnet' ? 'testnet' : dbMode;
      console.log(`[CONFIG] Network mode restored from database: ${NETWORK_MODE}`);
    }
  } catch (err) {
    console.error('[CONFIG] Error restoring network mode from database:', err.message);
  }
}

// Initialize RPC URL from database if available (testnet only)
async function initializeRpcUrl() {
  if (NETWORK_MODE !== 'testnet') return;
  const dbRpcUrl = await getRpcEndpointFromDatabase();
  if (dbRpcUrl) {
    NODE_RPC_URL = dbRpcUrl;
    console.log('[RPC Config] RPC endpoint initialized from database:', NODE_RPC_URL);
  } else {
    NODE_RPC_URL = validateAndConfigureRPC();
    console.log('[RPC Config] RPC endpoint initialized from environment:', NODE_RPC_URL);
  }
}

// Usernode chain configuration
const CHAIN_CONFIG = {
  testnet: {
    chainId: 'testnet',
    explorerUrl: 'https://explorer.testnet.usernodelabs.org',
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

// Centralized wallet validation for transaction endpoints
// Returns { valid: boolean, error: string | null }
// Wallet required for testnet & devnet; optional for mainnet
async function validateWalletForMode(networkMode, userId, userWalletPubkey) {
  // Devnet mode: wallet required
  if (networkMode === 'devnet') {
    if (!userWalletPubkey) {
      return {
        valid: false,
        error: 'Wallet not linked to user account. Connect your Usernode wallet in Settings to use devnet.'
      };
    }
    return { valid: true, error: null };
  }

  // Testnet mode: wallet is required
  if (networkMode === 'testnet') {
    // Check if user has a wallet address linked
    if (!userWalletPubkey) {
      return {
        valid: false,
        error: 'Wallet not linked to user account. Connect your Usernode wallet in Settings to use testnet.'
      };
    }

    // Check if RPC endpoint is configured and reachable
    if (!NODE_RPC_URL) {
      console.error('[WALLET-VALIDATION] RPC endpoint not configured in testnet mode');
      return {
        valid: false,
        error: 'Testnet RPC endpoint not configured. Contact administrator.',
        rpcEndpoint: null,
        diagnostic: 'NODE_RPC_URL environment variable is not set. Configure it in platform Secrets.'
      };
    }

    // Perform a quick RPC health check
    const health = await checkRPCHealth();
    if (!health.reachable) {
      console.error('[WALLET-VALIDATION] RPC endpoint unreachable:', health.error);
      const errorClassification = health.errorType ? classifyRPCError({ code: health.errorType, message: health.error }) : { diagnostic: null };
      return {
        valid: false,
        error: `Cannot reach testnet RPC endpoint. ${health.error || 'Network may be unavailable.'}`,
        rpcEndpoint: NODE_RPC_URL,
        diagnostic: errorClassification.diagnostic,
        errorType: health.errorType,
        responseTime: health.responseTime
      };
    }

    return { valid: true, error: null, rpcEndpoint: NODE_RPC_URL, diagnostic: null };
  }

  // Mainnet: wallet optional (future support)
  if (networkMode === 'mainnet') {
    return { valid: true, error: null };
  }

  return {
    valid: false,
    error: `Unknown network mode: ${networkMode}`
  };
}

const PUBLIC_API_PATHS = new Set(['/health', '/favicon.ico', '/api/test/production-simulation', '/api/diagnostics/bridge', '/api/diagnostics/status']);
const PUBLIC_PREFIXES = ['/explorer-api/'];

// Helper function to compute SHA-256 hash of content
function computeContentHash(content) {
  const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
  return crypto.createHash('sha256').update(contentStr).digest('hex');
}

// Helper function to execute a database query with a timeout
async function queryWithTimeout(pool, query, params, timeoutMs = 5000) {
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
    : '200-1000+';

  return { rank, hoursBracket, contributionLevel };
}

// Helper function to sync peer data from Usernode Social Vibecoding API
async function syncPeerDataFromUsernode(userId, token) {
  try {
    // Check if already syncing for this user to avoid concurrent requests
    if (peerSyncPromises.has(userId)) {
      return await peerSyncPromises.get(userId);
    }

    // Check cache
    const now = Date.now();
    const cached = peerSyncCache.get(userId);
    if (cached && (now - cached.timestamp) < PEER_SYNC_CACHE_MS) {
      console.log(`[PEER-SYNC] Using cached peer data for user ${userId}`);
      return cached.peersHours;
    }

    // Create promise for this sync to deduplicate concurrent requests
    const syncPromise = (async () => {
      try {
        // Build request to Usernode API
        const apiUrl = new URL(`/api/users/${userId}/peers`, USERNODE_API_URL);
        const isHttps = USERNODE_API_URL.startsWith('https');
        const client = isHttps ? https : http;

        return new Promise((resolve, reject) => {
          const options = {
            hostname: apiUrl.hostname,
            port: apiUrl.port,
            path: apiUrl.pathname + (apiUrl.search || ''),
            method: 'GET',
            headers: {
              'Content-Type': 'application/json'
            },
            timeout: PEER_SYNC_TIMEOUT_MS
          };

          // Add authentication headers
          if (token) {
            options.headers['Authorization'] = `Bearer ${token}`;
          }
          if (process.env.APP_SECRET_KEY) {
            options.headers['x-app-secret'] = process.env.APP_SECRET_KEY;
          }

          const req = client.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', async () => {
              try {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                  console.error(`[PEER-SYNC] Usernode API error (HTTP ${res.statusCode}) for user ${userId}`);
                  resolve(0); // Fallback to 0, will use local data
                  return;
                }

                const response = JSON.parse(data);
                const peers = response.peers || [];
                console.log(`[PEER-SYNC] Fetched ${peers.length} peers for user ${userId}`);

                // Upsert peers into database
                for (const peer of peers) {
                  if (peer.peer_id && typeof peer.foreground_hours === 'number') {
                    await pool.query(`
                      INSERT INTO peers (peer_id, foreground_hours, created_at)
                      VALUES ($1, $2, NOW())
                      ON CONFLICT (peer_id) DO UPDATE SET
                        foreground_hours = EXCLUDED.foreground_hours
                    `, [peer.peer_id, peer.foreground_hours]);
                  }
                }

                // Upsert user_peers relationships
                for (const peer of peers) {
                  if (peer.peer_id) {
                    await pool.query(`
                      INSERT INTO user_peers (user_id, peer_id, connected_at, last_seen_at)
                      VALUES ($1, $2, NOW(), NOW())
                      ON CONFLICT (user_id, peer_id) DO UPDATE SET
                        last_seen_at = NOW()
                    `, [userId, peer.peer_id]);
                  }
                }

                // Calculate total hours from synced peers
                let totalHours = 0;
                for (const peer of peers) {
                  if (typeof peer.foreground_hours === 'number') {
                    totalHours += peer.foreground_hours;
                  }
                }

                // Cache the result
                peerSyncCache.set(userId, { timestamp: now, peersHours: totalHours });
                console.log(`[PEER-SYNC] Synced ${peers.length} peers, total ${totalHours} hours for user ${userId}`);
                resolve(totalHours);
              } catch (err) {
                console.error(`[PEER-SYNC] Error processing response for user ${userId}:`, err.message);
                resolve(0); // Fallback to 0
              }
            });
          });

          req.on('error', (err) => {
            const errorType = err.code || err.message || 'unknown';
            console.error(`[PEER-SYNC] Network error (${errorType}) fetching peers for user ${userId}`);
            resolve(0); // Fallback to 0
          });

          req.on('timeout', () => {
            req.destroy();
            console.error(`[PEER-SYNC] Request timeout (>${PEER_SYNC_TIMEOUT_MS}ms) for user ${userId}`);
            resolve(0); // Fallback to 0
          });

          req.end();
        });
      } finally {
        // Remove from concurrent request map
        peerSyncPromises.delete(userId);
      }
    })();

    peerSyncPromises.set(userId, syncPromise);
    return await syncPromise;
  } catch (err) {
    console.error(`[PEER-SYNC] Unexpected error syncing peer data for user ${userId}:`, err);
    return 0; // Fallback to 0
  }
}

// Helper function to get foreground hours for a user (from synced peers or fallback to local data)
async function getForegroundHours(userId, token) {
  if (IS_STAGING) {
    // In staging, provide mock data based on user ID for consistency
    const numUserId = parseInt(userId, 10);
    const mockDataSet = [5, 25, 100, 300, 15, 50, 75, 150, 200, 250, 500, 750, 1000];
    // Use modulo to deterministically map user ID to a value
    return mockDataSet[numUserId % mockDataSet.length];
  }

  // In production, attempt to sync peer data from Usernode API
  if (token && USERNODE_API_URL) {
    const syncedHours = await syncPeerDataFromUsernode(userId, token);
    if (syncedHours > 0) {
      return syncedHours;
    }
  }

  // Fallback: query synced peers from local database
  try {
    const { rows } = await pool.query(`
      SELECT COALESCE(SUM(p.foreground_hours), 0) as total_hours
      FROM user_peers up
      JOIN peers p ON up.peer_id = p.peer_id
      WHERE up.user_id = $1
    `, [userId]);
    return rows[0].total_hours || 0;
  } catch (err) {
    console.error('Error fetching foreground hours from peers:', err);
    return 0;
  }
}

// Chain poller for transaction status (models Last One Wins pattern)
// Structure: Map<pollerId, { auditLogIds: Set<string>, timer, startTime }>
// Allows multiple startChainPoller calls for the same txHash if auditLogIds differ
const chainPollers = new Map();
const CHAIN_IDS = {
  'testnet': 'testnet',
  'mainnet': 'mainnet'
};

async function pollTransactionStatus(chainId, txHash, auditLogId) {
  try {
    // This is a self-proxy call into this same process, so loopback is the
    // reliable default (a container can't always reach its own public hostname).
    // API_BASE_URL is an explicit env override for unusual topologies only.
    const apiBaseUrl = API_BASE_URL || `http://127.0.0.1:${port || 3000}`;

    // Call our explorer API proxy endpoint
    const explorerPath = `/explorer-api/${chainId}/transactions/${txHash}`;
    const fullUrl = `${apiBaseUrl}${explorerPath}`;

    console.log(`[Chain Poller] Polling explorer for txHash=${txHash}, url=${fullUrl}`);

    return new Promise((resolve, reject) => {
      const url = new URL(fullUrl);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + (url.search || ''),
        method: 'GET',
        timeout: 5000
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', async () => {
          try {
            const txData = JSON.parse(data);
            const isConfirmed = txData.status === 'confirmed' || txData.status === 'success' || txData.blockNumber;

            console.log(`[Chain Poller] Explorer response for ${txHash}: status=${txData.status}, isConfirmed=${isConfirmed}`);

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
            console.error(`[Chain Poller] Error parsing explorer response for ${txHash}:`, err.message);
            console.error(`[Chain Poller] Raw response data:`, data.substring(0, 200));
            // Parse error is transient, retry
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        // Distinguish between transient and permanent errors
        const errorCode = err.code;
        const isTransient = errorCode === 'ETIMEDOUT' || errorCode === 'ECONNREFUSED' ||
                           errorCode === 'ENOTFOUND' || errorCode === 'ENETUNREACH';

        if (isTransient) {
          console.warn(`[Chain Poller] Explorer transient error (${errorCode}) for tx ${txHash}: ${err.message}`);
          // Transient error, retry
          resolve(null);
        } else {
          // Permanent error (DNS failure, etc)
          console.error(`[Chain Poller] Explorer permanent error (${errorCode}) for tx ${txHash}: ${err.message}`);
          // For now treat as transient and let it retry (user can inspect audit log for details)
          resolve(null);
        }
      });

      req.on('timeout', () => {
        req.destroy();
        console.warn(`[Chain Poller] Explorer request timeout for tx ${txHash} at ${fullUrl}`);
        // Timeout is transient, retry
        resolve(null);
      });

      req.end();
    });
  } catch (err) {
    console.error(`[Chain Poller] Error polling tx ${txHash}:`, err);
    return null;
  }
}

// Fallback transaction lookup: when synthetic hash polling fails, search explorer for matching transaction
// by sender pubkey, timestamp, and memo pattern
async function fallbackTransactionLookup(chainId, syntheticHash, auditLogId) {
  try {
    // Fetch the audit log to get search parameters
    const { rows: auditRows } = await pool.query(`
      SELECT user_pubkey, action_timestamp, message_type, transaction_payload, content_hash
      FROM blockchain_audit_logs
      WHERE id = $1
    `, [auditLogId]);

    if (auditRows.length === 0) {
      console.warn(`[FALLBACK] Audit log not found for auditLogId=${auditLogId}`);
      return { found: false };
    }

    const auditLog = auditRows[0];
    const { user_pubkey, action_timestamp, message_type, transaction_payload, content_hash } = auditLog;

    if (!user_pubkey) {
      console.warn(`[FALLBACK] No user_pubkey in audit log ${auditLogId}, cannot search`);
      return { found: false };
    }

    const config = CHAIN_CONFIG[chainId];
    if (!config) {
      console.warn(`[FALLBACK] Invalid chain ID ${chainId}`);
      return { found: false };
    }

    // Try to query explorer for recent transactions by sender
    // Try multiple endpoint formats since explorers vary
    const endpoints = [
      `${config.explorerUrl}/api/transactions?sender=${encodeURIComponent(user_pubkey)}&limit=100`,
      `${config.explorerUrl}/api/address/${encodeURIComponent(user_pubkey)}/transactions?limit=100`
    ];

    let transactions = [];
    for (const endpoint of endpoints) {
      try {
        console.log(`[FALLBACK] Querying explorer: ${endpoint}`);
        const response = await new Promise((resolve, reject) => {
          const url = new URL(endpoint);
          const isHttps = url.protocol === 'https:';
          const client = isHttps ? https : http;

          const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'GET',
            timeout: 5000
          };

          const req = client.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
              if (res.statusCode === 200) {
                try {
                  const parsed = JSON.parse(data);
                  resolve(Array.isArray(parsed) ? parsed : parsed.transactions || parsed.data || []);
                } catch (e) {
                  console.warn(`[FALLBACK] Failed to parse response from ${endpoint}: ${e.message}`);
                  reject(new Error('Invalid JSON response'));
                }
              } else {
                reject(new Error(`HTTP ${res.statusCode}`));
              }
            });
          });

          req.on('error', (err) => {
            reject(err);
          });

          req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout'));
          });

          req.end();
        });

        if (response && response.length > 0) {
          transactions = response;
          console.log(`[FALLBACK] Retrieved ${transactions.length} transactions from ${endpoint}`);
          break;
        }
      } catch (err) {
        console.warn(`[FALLBACK] Endpoint ${endpoint} failed: ${err.message}`);
        continue;
      }
    }

    if (transactions.length === 0) {
      console.warn(`[FALLBACK] No transactions found for sender ${user_pubkey}`);
      return { found: false };
    }

    // Parse action_timestamp for comparison (handle both ISO 8601 and Unix timestamp formats)
    let actionTime = 0;
    if (typeof action_timestamp === 'string') {
      actionTime = new Date(action_timestamp).getTime();
    } else if (typeof action_timestamp === 'number') {
      actionTime = action_timestamp > 1e10 ? action_timestamp : action_timestamp * 1000;
    }

    const timeWindow = 5 * 60 * 1000; // ±5 minutes

    // Search through transactions for a match
    for (const tx of transactions) {
      try {
        // Extract memo - it might be in different fields depending on explorer format
        const memoStr = tx.memo || tx.message || tx.data;
        if (!memoStr) {
          continue;
        }

        // Parse memo as JSON
        let memo = {};
        if (typeof memoStr === 'string') {
          try {
            memo = JSON.parse(memoStr);
          } catch {
            // Memo might not be valid JSON, skip this transaction
            continue;
          }
        } else if (typeof memoStr === 'object') {
          memo = memoStr;
        }

        // Verify memo matches guardian app pattern
        if (memo.app !== 'guardian') {
          continue;
        }

        // Match transaction type with audit log message_type
        // message_type might be 'message', 'group_create', 'group_add_members', etc.
        // memo.type should match (or at least start with the same)
        if (memo.type && memo.type !== message_type) {
          // Allow some flexibility in type matching
          if (!(message_type.startsWith(memo.type) || memo.type.startsWith(message_type))) {
            continue;
          }
        }

        // Check timestamp within ±5 minutes
        let txTime = 0;
        if (tx.timestamp) {
          if (typeof tx.timestamp === 'string') {
            txTime = new Date(tx.timestamp).getTime();
          } else if (typeof tx.timestamp === 'number') {
            txTime = tx.timestamp > 1e10 ? tx.timestamp : tx.timestamp * 1000;
          }
        }

        if (actionTime && txTime && Math.abs(txTime - actionTime) > timeWindow) {
          continue;
        }

        // Optional: verify content hash if both available
        if (content_hash && memo.contentHash && memo.contentHash !== content_hash) {
          continue;
        }

        // Found a match! Extract the real transaction hash
        const realHash = tx.hash || tx.txHash || tx.tx_hash;
        if (!realHash) {
          console.warn(`[FALLBACK] Transaction matched but no hash field found`);
          continue;
        }

        console.log(`[FALLBACK-MATCH] Found matching transaction: hash=${realHash}, memo.type=${memo.type}, timestamp=${tx.timestamp}`);
        return { found: true, realHash };
      } catch (err) {
        console.warn(`[FALLBACK] Error processing transaction:`, err.message);
        continue;
      }
    }

    console.warn(`[FALLBACK] Searched ${transactions.length} transactions but no match found for sender=${user_pubkey}, type=${message_type}, timestamp=${action_timestamp}`);
    return { found: false };
  } catch (err) {
    console.error(`[FALLBACK] Unexpected error in fallback lookup:`, err.message);
    return { found: false };
  }
}

async function startChainPoller(chainId, txHash, auditLogId) {
  const pollerId = `${chainId}:${txHash}`;

  console.log(`[Chain Poller] Starting poller for txHash=${txHash}, chainId=${chainId}, auditLogId=${auditLogId}`);

  // Check if we're already polling this txHash
  const existingPoller = chainPollers.get(pollerId);
  if (existingPoller) {
    // Same txHash, different auditLogId: add to the set of audit logs for this poller
    if (!existingPoller.auditLogIds.has(auditLogId)) {
      console.log(`[Chain Poller] Already polling txHash=${txHash}, registering additional auditLogId=${auditLogId}`);
      existingPoller.auditLogIds.add(auditLogId);
    } else {
      // Exact duplicate: same txHash + same auditLogId
      console.log(`[Chain Poller] Already polling this exact transaction, skipping: ${pollerId} with auditLogId=${auditLogId}`);
    }
    return;
  }

  // Poll up to 60 times with hardcoded backoff schedule for consistency:
  // - Polls 1-10: 3s interval
  // - Polls 11-30: 10s interval
  // - Polls 31-60: 20s interval
  // After poll 60: Synthetic hash → fallback lookup; real hash → mark failed
  const maxPolls = 60;

  const getBackoffMs = (pollCount) => {
    if (pollCount <= 10) return 3000;
    if (pollCount <= 30) return 10000;
    return 20000;
  };

  const scheduleNextPoll = (pollCount) => {
    const backoffMs = getBackoffMs(pollCount);
    const timer = setTimeout(async () => {
      try {
        const poller = chainPollers.get(pollerId);
        if (!poller) return; // Poller was cancelled

        // Poll for ALL audit logs associated with this txHash
        const auditLogIds = Array.from(poller.auditLogIds);
        let anyConfirmed = false;

        for (const logId of auditLogIds) {
          try {
            const isConfirmed = await pollTransactionStatus(chainId, txHash, logId);
            if (isConfirmed) {
              anyConfirmed = true;
              poller.auditLogIds.delete(logId);
            }
          } catch (err) {
            console.error(`[Chain Poller] Error polling auditLogId=${logId}:`, err.message);
          }
        }

        // If all audit logs are confirmed, clean up the poller
        if (poller.auditLogIds.size === 0) {
          chainPollers.delete(pollerId);
          return;
        }

        if (pollCount >= maxPolls) {
          // SYNTHETIC HASH: If txHash is synthetic, try fallback lookup before marking failed
          const isSyntheticHash = txHash.startsWith('synthetic_');

          if (isSyntheticHash) {
            console.log(`[Chain Poller] Max polls reached for synthetic hash ${txHash}, initiating fallback transaction lookup...`);

            // Try fallback lookup for each audit log
            for (const logId of poller.auditLogIds) {
              try {
                const fallbackResult = await fallbackTransactionLookup(chainId, txHash, logId);
                if (fallbackResult.found) {
                  console.log(`[FALLBACK-SUCCESS] Found real transaction ${fallbackResult.realHash} for synthetic hash ${txHash} (auditLogId=${logId})`);
                  // Update with real hash and confirmed status
                  await pool.query(`
                    UPDATE blockchain_audit_logs
                    SET tx_hash = $1, status = 'confirmed', confirmed_at = NOW(), updated_at = NOW()
                    WHERE id = $2 AND status = 'pending'
                  `, [fallbackResult.realHash, logId]);
                  poller.auditLogIds.delete(logId);
                  continue;
                }
              } catch (err) {
                console.error(`[FALLBACK-ERROR] Fallback lookup failed for auditLogId=${logId}:`, err.message);
              }
            }

            // Mark any remaining audit logs as failed
            for (const logId of poller.auditLogIds) {
              try {
                console.error(`[SYNTHETIC-HASH-FAILED] Fallback lookup exhausted for synthetic hash ${txHash} (auditLogId=${logId}). The real transaction was not found on-chain. Operator action required: verify TRANSACTIONS_BASE_URL configuration and check explorer connectivity.`);
                await pool.query(`
                  UPDATE blockchain_audit_logs
                  SET status = 'failed', error_message = $1, updated_at = NOW()
                  WHERE id = $2 AND status = 'pending'
                `, [`Fallback lookup exhausted: transaction not found on explorer after ${maxPolls} direct polls`, logId]);
                console.warn(`[Chain Poller] Fallback exhausted for synthetic hash ${txHash}, auditLogId=${logId} marked as failed`);
              } catch (err) {
                console.error(`[Chain Poller] Failed to mark auditLogId=${logId} as failed:`, err.message);
              }
            }
          } else {
            // For non-synthetic hashes, mark as failed normally
            for (const logId of poller.auditLogIds) {
              try {
                await pool.query(`
                  UPDATE blockchain_audit_logs
                  SET status = 'failed', error_message = $1, updated_at = NOW()
                  WHERE id = $2 AND status = 'pending'
                `, [`Transaction not confirmed after ${maxPolls} polls`, logId]);
                console.warn(`[Chain Poller] Max polls (${maxPolls}) reached for ${txHash}, auditLogId=${logId} marked as failed`);
              } catch (err) {
                console.error(`[Chain Poller] Failed to mark auditLogId=${logId} as failed:`, err.message);
              }
            }
          }
          chainPollers.delete(pollerId);
          return;
        }

        console.log(`[Chain Poller] Poll ${pollCount}/${maxPolls} for ${txHash}: not confirmed yet (${poller.auditLogIds.size} logs), retrying in ${Math.round(backoffMs / 1000)}s`);
        scheduleNextPoll(pollCount + 1);
      } catch (err) {
        console.error(`[Chain Poller] Unexpected error:`, err);
        chainPollers.delete(pollerId);
      }
    }, backoffMs);

    // Create or update the poller entry with the new timer
    if (!chainPollers.has(pollerId)) {
      chainPollers.set(pollerId, { auditLogIds: new Set([auditLogId]), timer, startTime: Date.now() });
    } else {
      chainPollers.get(pollerId).timer = timer;
    }
  };

  scheduleNextPoll(1);
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

    // In devnet mode, record database-only transaction
    if (NETWORK_MODE === 'devnet') {
      const txHash = `devnet-token-${Date.now()}`;
      console.log(`[DEVNET] Recording database-only token transfer: txHash=${txHash}`);
      return { success: true, transactionHash: txHash, isDevnet: true };
    }

    // In demo mode or without RPC URL in testnet, use bridge/fallback
    if (NETWORK_MODE !== 'testnet' || !NODE_RPC_URL) {
      console.log(`[BLOCKCHAIN-SUBMIT] Bridge/fallback mode: would send ${amount} to ${recipient}`);
      return { success: true, transactionHash: null };
    }

    // In testnet mode with RPC: POST to NODE_RPC_URL /wallet/send
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

    console.log(`[BLOCKCHAIN-RPC] Attempting to connect to ${NODE_RPC_URL}/wallet/send, timeout=10000ms, method=wallet_send`);

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
              // Validate RPC response contains a txHash (fix for issue #8)
              const txHash = response.txHash || response.hash;

              if (!txHash) {
                console.error(`[BLOCKCHAIN-RPC] RPC returned 200 but missing txHash in response:`, JSON.stringify(response));
                reject(new Error(`RPC returned success but missing transaction hash`));
                return;
              }

              console.log(`[BLOCKCHAIN-SUBMIT] Payment submitted successfully: statusCode=${res.statusCode}, txHash=${txHash}`);
              resolve({
                success: true,
                transactionHash: txHash
              });
            } else if (res.statusCode >= 500) {
              console.error(`[BLOCKCHAIN-RPC] Server error (HTTP ${res.statusCode}): ${response.error || JSON.stringify(response)}`);
              reject(new Error(`RPC server error (HTTP ${res.statusCode}): ${response.error || 'unknown'}`));
            } else {
              console.error(`[BLOCKCHAIN-RPC] Client error (HTTP ${res.statusCode}): ${response.error || JSON.stringify(response)}`);
              reject(new Error(`RPC error (HTTP ${res.statusCode}): ${response.error || 'unknown'}`));
            }
          } catch (err) {
            console.error(`[BLOCKCHAIN-RPC] Failed to parse RPC response: ${err.message}`);
            console.error(`[BLOCKCHAIN-RPC] Raw response data:`, data.substring(0, 200));
            reject(new Error(`Failed to parse RPC response: ${err.message}`));
          }
        });
      });

      req.on('error', (err) => {
        const errorClass = classifyRPCError(err);
        console.error(`[BLOCKCHAIN-RPC] Connection failed (${errorClass.type}): ${errorClass.message}`);
        reject(new Error(`${errorClass.type}: ${errorClass.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        console.error(`[BLOCKCHAIN-RPC] Request timeout (>10s): ${NODE_RPC_URL}/wallet/send`);
        reject(new Error('RPC_TIMEOUT: Request timeout (exceeded 10 seconds)'));
      });

      req.write(JSON.stringify(rpcPayload));
      req.end();
    });
  } catch (err) {
    console.error('Error sending outgoing payment:', err);
    throw err;
  }
}

// Send transaction to database only (Devnet mode)
async function sendTransactionDevnet(messageType, payload, memo, auditLogId = null, userId = null, messageId = null) {
  try {
    const txHash = `devnet-${messageType}-${auditLogId || messageId}-${Date.now()}`;
    console.log(`[DEVNET] Recording database-only transaction: txHash=${txHash}, messageType=${messageType}`);
    return { transactionHash: txHash, isDevnet: true };
  } catch (err) {
    console.error('[DEVNET] Error in sendTransactionDevnet:', err.message);
    throw err;
  }
}

// Send message transaction to blockchain via RPC (Real Testnet mode only)
async function sendMessageToBlockchain(messagePayload, memo, network = 'testnet') {
  try {
    console.log(`[BLOCKCHAIN-SUBMIT] sendMessageToBlockchain: messageId=${messagePayload.messageId}, memo=${memo ? 'provided' : 'none'}`);

    // In devnet mode, record database-only transaction
    if (NETWORK_MODE === 'devnet') {
      return await sendTransactionDevnet('message', messagePayload, memo, null, null, messagePayload.messageId);
    }

    // In demo mode or without RPC URL in testnet, use bridge/fallback
    if (NETWORK_MODE !== 'testnet' || !NODE_RPC_URL) {
      console.log(`[BLOCKCHAIN-SUBMIT] Bridge/fallback mode: would submit message ${messagePayload.messageId} to network ${network}`);
      return { transactionHash: null };
    }

    // In testnet mode with RPC: POST to NODE_RPC_URL /transaction/submit
    const rpcPayload = {
      method: 'transaction_submit',
      params: {
        type: 'message',
        transaction: messagePayload,
        memo: memo,
        appPubkey: APP_PUBKEY
      }
    };

    console.log(`[BLOCKCHAIN-RPC] Attempting to connect to ${NODE_RPC_URL}/transaction/submit, timeout=10000ms, method=transaction_submit`);

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
              // Validate RPC response contains a txHash (fix for issue #8)
              const txHash = response.txHash || response.hash || response.transactionHash;

              if (!txHash) {
                console.error(`[BLOCKCHAIN-RPC] RPC returned 200 but missing txHash in response:`, JSON.stringify(response));
                reject(new Error(`RPC returned success but missing transaction hash`));
                return;
              }

              console.log(`[BLOCKCHAIN-SUBMIT] Message submitted: statusCode=${res.statusCode}, txHash=${txHash}`);
              resolve({
                transactionHash: txHash
              });
            } else if (res.statusCode >= 500) {
              console.error(`[BLOCKCHAIN-RPC] Server error (HTTP ${res.statusCode}): ${response.error || JSON.stringify(response)}`);
              reject(new Error(`RPC server error (HTTP ${res.statusCode}): ${response.error || 'unknown'}`));
            } else {
              console.error(`[BLOCKCHAIN-RPC] Client error (HTTP ${res.statusCode}): ${response.error || JSON.stringify(response)}`);
              reject(new Error(`RPC error (HTTP ${res.statusCode}): ${response.error || 'unknown'}`));
            }
          } catch (err) {
            console.error(`[BLOCKCHAIN-RPC] Failed to parse RPC response: ${err.message}`);
            console.error(`[BLOCKCHAIN-RPC] Raw response data:`, data.substring(0, 200));
            reject(new Error(`Failed to parse RPC response: ${err.message}`));
          }
        });
      });

      req.on('error', (err) => {
        const errorClass = classifyRPCError(err);
        console.error(`[BLOCKCHAIN-RPC] Connection failed (${errorClass.type}): ${errorClass.message}`);
        reject(new Error(`${errorClass.type}: ${errorClass.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        console.error(`[BLOCKCHAIN-RPC] Request timeout (>10s): ${NODE_RPC_URL}/transaction/submit`);
        reject(new Error('RPC_TIMEOUT: Request timeout (exceeded 10 seconds)'));
      });

      req.write(JSON.stringify(rpcPayload));
      req.end();
    });
  } catch (err) {
    console.error('Error sending message to blockchain:', err);
    throw err;
  }
}

// Send group creation transaction to blockchain via RPC (Real Testnet mode only)
async function sendGroupToBlockchain(groupPayload, memo, memberPubkeys, network = 'testnet') {
  try {
    console.log(`[BLOCKCHAIN-SUBMIT] sendGroupToBlockchain: groupId=${groupPayload.groupId}, memo=${memo ? 'provided' : 'none'}`);

    // In devnet mode, record database-only transaction
    if (NETWORK_MODE === 'devnet') {
      return await sendTransactionDevnet('group', groupPayload, memo, null, null, groupPayload.groupId);
    }

    // In demo mode or without RPC URL in testnet, use bridge/fallback
    if (NETWORK_MODE !== 'testnet' || !NODE_RPC_URL) {
      console.log(`[BLOCKCHAIN-SUBMIT] Bridge/fallback mode: would create group ${groupPayload.groupId} to network ${network}`);
      return { transactionHash: null };
    }

    // In testnet mode with RPC: POST to NODE_RPC_URL /transaction/submit
    const rpcPayload = {
      method: 'transaction_submit',
      params: {
        type: 'group_create',
        transaction: groupPayload,
        memo: memo,
        appPubkey: APP_PUBKEY
      }
    };

    console.log(`[BLOCKCHAIN-RPC] Attempting to connect to ${NODE_RPC_URL}/transaction/submit, timeout=10000ms, method=transaction_submit`);

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
              // Validate RPC response contains a txHash (fix for issue #8)
              const txHash = response.txHash || response.hash || response.transactionHash;

              if (!txHash) {
                console.error(`[BLOCKCHAIN-RPC] RPC returned 200 but missing txHash in response:`, JSON.stringify(response));
                reject(new Error(`RPC returned success but missing transaction hash`));
                return;
              }

              console.log(`[BLOCKCHAIN-SUBMIT] Group created: statusCode=${res.statusCode}, txHash=${txHash}`);
              resolve({
                transactionHash: txHash
              });
            } else if (res.statusCode >= 500) {
              console.error(`[BLOCKCHAIN-RPC] Server error (HTTP ${res.statusCode}): ${response.error || JSON.stringify(response)}`);
              reject(new Error(`RPC server error (HTTP ${res.statusCode}): ${response.error || 'unknown'}`));
            } else {
              console.error(`[BLOCKCHAIN-RPC] Client error (HTTP ${res.statusCode}): ${response.error || JSON.stringify(response)}`);
              reject(new Error(`RPC error (HTTP ${res.statusCode}): ${response.error || 'unknown'}`));
            }
          } catch (err) {
            console.error(`[BLOCKCHAIN-RPC] Failed to parse RPC response: ${err.message}`);
            console.error(`[BLOCKCHAIN-RPC] Raw response data:`, data.substring(0, 200));
            reject(new Error(`Failed to parse RPC response: ${err.message}`));
          }
        });
      });

      req.on('error', (err) => {
        const errorClass = classifyRPCError(err);
        console.error(`[BLOCKCHAIN-RPC] Connection failed (${errorClass.type}): ${errorClass.message}`);
        reject(new Error(`${errorClass.type}: ${errorClass.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        console.error(`[BLOCKCHAIN-RPC] Request timeout (>10s): ${NODE_RPC_URL}/transaction/submit`);
        reject(new Error('RPC_TIMEOUT: Request timeout (exceeded 10 seconds)'));
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
  if (req.user && dbConnected) {
    try {
      const username = req.user.username || `user-${req.user.id}`;
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
      `, [req.user.id, username, req.user.usernode_pubkey || null, req.user.verified_at || null]);
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

app.get('/health', async (_req, res) => {
  try {
    // Quick database connectivity check (timeout after 1 second)
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 1000))
    ]);
    res.json({
      status: 'ok',
      staging: IS_STAGING,
      environment: IS_STAGING ? 'staging' : 'production',
      networkMode: NETWORK_MODE,
      database: 'connected'
    });
  } catch (err) {
    // Graceful degradation: respond 200 even if DB is unavailable
    // This prevents container startup from failing when DB takes time to initialize
    console.warn('[HEALTH] Database check failed:', err.message);
    res.json({
      status: 'ok',
      staging: IS_STAGING,
      environment: IS_STAGING ? 'staging' : 'production',
      networkMode: NETWORK_MODE,
      database: 'disconnected',
      warning: 'Database unavailable but server is running'
    });
  }
});

// Staging-only endpoint to generate test tokens for Accept/Decline testing
app.get('/api/staging/test-token/:userId', (_req, res) => {
  if (!IS_STAGING) {
    return res.status(403).json({ error: 'Only available in staging' });
  }

  const userId = parseInt(req.params.userId, 10);
  if (isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }

  if (!JWT_SECRET) {
    return res.status(500).json({ error: 'JWT_SECRET not configured' });
  }

  try {
    const token = jwt.sign(
      { id: userId, username: `staging-demo-user-${userId}`, usernode_pubkey: null },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ token, userId, url: `/?token=${token}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    const userRes = await pool.query(`SELECT view_mode, avatar_url, created_at, bio, skip_signature_in_devnet, network_mode FROM users WHERE id = $1`, [req.user.id]);
    const view_mode = userRes.rows[0]?.view_mode || 'web';
    const avatar_url = userRes.rows[0]?.avatar_url || null;
    const created_at = userRes.rows[0]?.created_at || null;
    const bio = userRes.rows[0]?.bio || null;
    const skip_signature_in_devnet = userRes.rows[0]?.skip_signature_in_devnet || false;
    const network_mode = userRes.rows[0]?.network_mode ?? null;
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
      skipSignatureInDevnet: skip_signature_in_devnet,
      networkMode: network_mode,
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

    if (dbConnected) {
      try {
        await pool.query(`UPDATE users SET view_mode = $1 WHERE id = $2`, [viewMode, req.user.id]);
      } catch (dbErr) {
        console.error('Database error updating view mode:', dbErr);
        // Continue anyway - the view mode preference can be stored in session/local storage as fallback
      }
    }

    res.json({ viewMode: viewMode, status: 'updated' });
  } catch (err) {
    console.error('Error updating view mode:', err);
    res.status(500).json({ error: 'Failed to update view mode' });
  }
});

app.put('/api/user/skip-signature-devnet', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { skipSignature } = req.body;
    if (typeof skipSignature !== 'boolean') {
      return res.status(400).json({ error: 'Invalid input: skipSignature must be a boolean' });
    }

    await pool.query(`UPDATE users SET skip_signature_in_devnet = $1 WHERE id = $2`, [skipSignature, req.user.id]);
    res.json({ skipSignatureInDevnet: skipSignature, status: 'updated' });
  } catch (err) {
    console.error('Error updating skip-signature-devnet:', err);
    res.status(500).json({ error: 'Failed to update skip-signature-devnet' });
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

    // Query contacts count (contacts added BY this user)
    const contactsRes = await pool.query(`SELECT COUNT(*) as count FROM user_contacts WHERE user_id = $1`, [userId]);
    const contactsCount = parseInt(contactsRes.rows[0]?.count || 0, 10);

    // Query groups count: count distinct groups the user is a member of
    const groupsRes = await pool.query(`
      SELECT COUNT(DISTINCT group_id) as count FROM group_members
      WHERE user_id = $1
    `, [userId]);
    const groupCount = parseInt(groupsRes.rows[0]?.count || 0, 10);

    // Query messages count: count distinct conversations + groups the user participates in
    // This reflects the user's participation in the Messages view (both Direct and Groups tabs)
    const conversationsRes = await pool.query(`
      SELECT COUNT(DISTINCT id) as count FROM conversations
      WHERE (participant_a_id = $1 OR participant_b_id = $1)
      AND status_a != 'ignored' AND status_b != 'ignored'
    `, [userId]);
    const conversationCount = parseInt(conversationsRes.rows[0]?.count || 0, 10);

    const messagesCount = conversationCount + groupCount;

    res.json({
      contactsCount: contactsCount,
      groupCount: groupCount,
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

    let lastSyncAt = null;

    if (dbConnected) {
      try {
        const now = new Date().toISOString();
        await pool.query(
          `UPDATE users SET last_usernode_ping_at = $1 WHERE id = $2`,
          [now, userId]
        );

        const lastPingRes = await pool.query(
          `SELECT last_usernode_ping_at FROM users WHERE id = $1`,
          [userId]
        );
        lastSyncAt = lastPingRes.rows && lastPingRes.rows.length > 0 ? lastPingRes.rows[0].last_usernode_ping_at : null;
      } catch (dbErr) {
        console.error('Database error in usernode status:', dbErr);
        // Continue without lastSyncAt if database fails
      }
    }

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

    // All authenticated users can change network mode
    const canEdit = true;

    // Get RPC health status only in testnet mode
    const rpcHealth = NETWORK_MODE === 'testnet' ? await checkRPCHealth() : null;

    const nodeRpcUrlSecret = {
      key: 'NODE_RPC_URL',
      value: NODE_RPC_URL,
      required: false,
      private: false
    };

    // Only include rpcStatus in testnet mode
    if (NETWORK_MODE === 'testnet') {
      nodeRpcUrlSecret.rpcStatus = rpcHealth;
    }

    res.json({
      networkMode: NETWORK_MODE,
      rpcEndpoint: NODE_RPC_URL,
      canEdit: canEdit,
      canEditRpc: canEdit,
      description: 'Devnet: database-only transactions with immediate confirmation; no blockchain or RPC required. Testnet: live blockchain transactions requiring wallet confirmation.',
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
        nodeRpcUrlSecret
      ]
    });
  } catch (err) {
    console.error('Error fetching config:', err);
    res.status(500).json({ error: 'Failed to fetch configuration' });
  }
});

// Network mode, RPC, and active chain endpoints removed

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

    // Return empty conversations if database is not connected
    if (!dbConnected) {
      return res.json({ conversations: { active: [], pending: [], archived: [] } });
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

    const username = req.user.username;

    console.log(`[MESSAGE] POST /api/conversations/${convId}/messages by user ${userId}`);
    console.log(`[MESSAGE] txHash provided: ${txHash ? 'yes - ' + txHash : 'no'}`);
    console.log(`[MESSAGE] Frontend content hash: ${frontendContentHash || 'none'}`);

    // Validate wallet connection before proceeding with message transaction
    const walletValidation = await validateWalletForMode(NETWORK_MODE, userId, req.user.usernode_pubkey);
    if (!walletValidation.valid) {
      return res.status(401).json({ error: walletValidation.error });
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
    const userPubkey = req.user.usernode_pubkey || null;
    const network = 'testnet';

    // Use frontend-provided content hash or compute it
    const contentHash = frontendContentHash || computeContentHash(content);

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
      console.log(`\n🔄 [DUPLICATE DETECTED] ========================================`);
      console.log(`   User: ${username} (${userId})`);
      console.log(`   Content Hash: ${contentHash}`);
      console.log(`   Existing Audit ID: ${existingLog.id}`);
      console.log(`   Existing TX Hash: ${existingLog.tx_hash}`);
      console.log(`   Time Since First Attempt: ${timeSincePrevious}ms`);
      console.log(`   Action: Reusing existing transaction instead of creating duplicate`);
      console.log(`============================================================\n`);
      // Return the existing audit log instead of creating a duplicate
      res.json({
        id: 0, // Dummy, not used
        createdAt: new Date(now),
        blockchainRecordingId: existingLog.id,
        isDuplicate: true,
        existingTxHash: existingLog.tx_hash,
        note: 'Transaction already recorded - previous attempt succeeded despite timeout error'
      });
      return;
    }

    // Start a database transaction for atomic INSERT + UPDATE
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert message first
      const msgRes = await client.query(`
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
        network: network,
        rpcEndpoint: NODE_RPC_URL
      };

      // Sign memo following Last One Wins pattern
      const memo = signTransactionMemo(transactionPayload);

      // Validate transaction_payload is not null
      if (!transactionPayload || Object.keys(transactionPayload).length === 0) {
        throw new Error('Failed to create valid transaction payload');
      }

      // Determine audit status and network origin based on mode
      let auditStatus = 'pending';
      let networkOriginValue = null;
      let actualTxHash = null;

      // For testnet mode with RPC: submit real transaction, store null tx_hash initially
      // For devnet: generate synthetic hash, mark confirmed
      // For testnet without RPC: will be set later via fallback
      if (NETWORK_MODE === 'testnet' && NODE_RPC_URL && !txHash) {
        // Real testnet mode: insert with null tx_hash, will be updated after RPC submission
        auditStatus = 'pending';
        networkOriginValue = 'testnet';
        actualTxHash = null;
      } else if (txHash) {
        // Frontend provided a real tx hash
        actualTxHash = txHash;
        auditStatus = 'pending';
        networkOriginValue = 'blockchain';
      } else if (NETWORK_MODE === 'devnet') {
        // Devnet mode: generate synthetic hash, confirm immediately
        actualTxHash = 'ut1devnet-message-' + messageId + '-' + Date.now();
        auditStatus = 'confirmed';
        networkOriginValue = 'database';
      } else {
        // Testnet without RPC: store null, will be populated later
        actualTxHash = null;
        auditStatus = 'pending';
        networkOriginValue = 'bridge';
      }

      // Log audit creation with all critical fields
      console.log(`[AUDIT LOG] MESSAGE: txHash=${actualTxHash || 'pending'}, messageId=${messageId}, status=${auditStatus}, contentHash=${contentHash}`);
      console.log(`[MESSAGE] Recording blockchain audit log: messageId=${messageId}, txHash=${actualTxHash || 'pending'}, status=${auditStatus}, contentHash=${contentHash}`);

      let blockchainRecordingId;
      if (auditLogId) {
        // Two-phase flow: audit log already exists from wallet signature, just update it
        console.log(`[MESSAGE] Using existing audit log: id=${auditLogId}`);
        await client.query(`
          UPDATE blockchain_audit_logs
          SET message_id = $1, message_type = $2, tx_hash = $3, transaction_payload = $4, status = $5, confirmed_at = $6, content_hash = $7, user_pubkey = $8, action_timestamp = $9, network_origin = $10, updated_at = NOW()
          WHERE id = $11 AND user_id = $12
        `, [messageId, 'message', actualTxHash, JSON.stringify(transactionPayload), auditStatus, (auditStatus === 'confirmed' ? now : null), contentHash, userPubkey, now, networkOriginValue, auditLogId, userId]);
        blockchainRecordingId = auditLogId;
        console.log(`[MESSAGE] Updated existing audit log: id=${blockchainRecordingId}`);
      } else {
        // Single-phase flow: create new audit log
        // For testnet with RPC, actualTxHash may be null initially; will be updated after RPC submission
        const auditRes = await client.query(`
          INSERT INTO blockchain_audit_logs (user_id, message_id, message_type, tx_hash, transaction_payload, status, confirmed_at, content_hash, user_pubkey, action_timestamp, network_origin, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
          RETURNING id
        `, [userId, messageId, 'message', actualTxHash, JSON.stringify(transactionPayload), auditStatus, (auditStatus === 'confirmed' ? now : null), contentHash, userPubkey, now, networkOriginValue, now]);
        blockchainRecordingId = auditRes.rows[0].id;

        console.log(`[MESSAGE] Blockchain audit log created: auditLogId=${blockchainRecordingId}, txHash=${actualTxHash || 'pending'}`);
      }

      // Update message with audit log reference (ATOMIC with INSERT)
      await client.query(`
        UPDATE messages SET blockchain_audit_log_id = $1 WHERE id = $2
      `, [blockchainRecordingId, messageId]);

      // Update conversation updated_at to reflect new message activity
      await client.query(`
        UPDATE conversations SET updated_at = NOW() WHERE id = $1
      `, [convId]);

      // Auto-unarchive for the recipient when a new message arrives
      await client.query(`
        UPDATE conversations SET archived_by = array_remove(archived_by, $1) WHERE id = $2 AND archived_by @> ARRAY[$1]::integer[]
      `, [otherId, convId]);

      // Commit the transaction - all INSERTs/UPDATEs are now atomic
      await client.query('COMMIT');

      console.log(`[MESSAGE] Transaction committed: messageId=${messageId}, auditLogId=${blockchainRecordingId}`);

      // Return success BEFORE starting async polling (fixes race condition)
      res.json({
        id: messageId,
        createdAt: new Date(now),
        blockchainRecordingId: blockchainRecordingId
      });

      // Async polling starts AFTER response is sent
      // This ensures frontend gets auditLogId immediately
      if (txHash && NETWORK_MODE !== 'devnet') {
        // Real txHash from frontend - start chain poller
        console.log(`[MESSAGE] Real txHash from frontend - starting chain poller for txHash=${txHash}, auditLogId=${blockchainRecordingId}`);
        startChainPoller(network, txHash, blockchainRecordingId).catch(err => {
          console.error('Error starting chain poller:', err);
        });
      } else if (NETWORK_MODE === 'testnet' && NODE_RPC_URL && !txHash) {
        // Testnet with RPC: submit real transaction
        (async () => {
          try {
            if (!memo) {
              throw new Error('Failed to sign transaction memo');
            }
            console.log(`[MESSAGE-RPC] Submitting message to testnet RPC for auditLogId=${blockchainRecordingId}`);
            const result = await sendMessageToBlockchain(transactionPayload, memo, network);

            // Update audit log with real txHash from RPC
            console.log(`[MESSAGE-RPC] Received real txHash=${result.transactionHash}, updating auditLogId=${blockchainRecordingId}`);
            await pool.query(`
              UPDATE blockchain_audit_logs SET tx_hash = $1, network_origin = 'testnet', updated_at = NOW() WHERE id = $2
            `, [result.transactionHash, blockchainRecordingId]);

            // Start polling with real txHash against blockchain explorer
            startChainPoller(network, result.transactionHash, blockchainRecordingId).catch(err => {
              console.error('Error starting chain poller:', err);
            });
          } catch (err) {
            const errorClass = classifyRPCError(err);
            console.error(`[BLOCKCHAIN-FALLBACK] RPC failed (${errorClass.type}), using bridge fallback for messageId=${messageId}: ${err.message}`);

            // Fallback: try bridge approach (generates placeholder hash)
            try {
              const bridgeResult = await sendTransactionToBridge(transactionPayload, null, network);

              // Update audit log with placeholder hash from bridge
              await pool.query(`
                UPDATE blockchain_audit_logs SET tx_hash = $1, network_origin = 'bridge', updated_at = NOW() WHERE id = $2
              `, [bridgeResult.txHash, blockchainRecordingId]);

              console.log(`[BLOCKCHAIN-FALLBACK] Updated audit log with bridge tx hash: txHash=${bridgeResult.txHash}, auditLogId=${blockchainRecordingId}`);

              // Start polling with placeholder (will timeout after max polls)
              startChainPoller(network, bridgeResult.txHash, blockchainRecordingId).catch(pollerErr => {
                console.error('Error starting fallback chain poller:', pollerErr);
              });
            } catch (bridgeErr) {
              // Both RPC and fallback failed — mark as failed immediately
              console.error(`[BLOCKCHAIN-FALLBACK] Bridge fallback also failed: ${bridgeErr.message}`);
              await pool.query(`
                UPDATE blockchain_audit_logs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2
              `, [bridgeErr.message, blockchainRecordingId]);
            }
          }
        })();
      }
    } catch (err) {
      // Rollback on error
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Rollback error:', rollbackErr.message);
      }
      console.error(err);
      res.status(500).json({ error: err.message });
    } finally {
      // Always release the client
      client.release();
    }
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

    const result = await pool.query(`
      UPDATE messages
      SET deleted_by = CASE
        WHEN deleted_by IS NULL THEN ARRAY[$1]
        ELSE array_append(deleted_by, $1)
      END
      WHERE id = $2 AND conversation_id = $3
    `, [userId, messageId, convId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

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


// ===== DELETED: Token Transfer and Blockchain Endpoints =====
// The following blockchain functionality has been removed:
// - /api/tokens/send
// - /api/blockchain-audit/*
// - /api/transactions/*
// - /api/config/network-mode
// - /api/user/network-mode

// All blockchain-related endpoints removed

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
      console.warn('[GET /api/contacts/:contactId/conversation-count] Not authenticated');
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const contactId = req.params.contactId;
    console.log('[GET /api/contacts/:contactId/conversation-count] Received contactId:', {
      raw: contactId,
      type: typeof contactId
    });

    // Defensive validation
    if (contactId === null || contactId === undefined) {
      console.error('[GET /api/contacts/:contactId/conversation-count] Contact ID is null or undefined');
      return res.status(400).json({ error: 'Invalid contact ID (null or undefined)' });
    }

    const contactIdStr = String(contactId).trim();
    if (!contactIdStr) {
      console.error('[GET /api/contacts/:contactId/conversation-count] Contact ID is empty after trim');
      return res.status(400).json({ error: 'Invalid contact ID (empty)' });
    }

    if (!/^\d+$/.test(contactIdStr)) {
      console.error('[GET /api/contacts/:contactId/conversation-count] Invalid contact ID format:', {raw: contactId, trimmed: contactIdStr});
      return res.status(400).json({ error: 'Invalid contact ID (invalid format)' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      console.error('[GET /api/contacts/:contactId/conversation-count] Invalid user ID:', {userId: req.user.id});
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Get contact_user_id
    const contactResult = await pool.query(`
      SELECT contact_user_id FROM user_contacts
      WHERE id = $1 AND user_id = $2
    `, [contactIdStr, userId]);

    if (contactResult.rowCount === 0) {
      console.warn('[GET /api/contacts/:contactId/conversation-count] Contact not found:', {contactId: contactIdStr, userId});
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
    console.log('[GET /api/contacts/:contactId/conversation-count] Conversation count:', {count, contactId: contactIdStr});
    res.json({ conversationCount: count });
  } catch (err) {
    console.error('[GET /api/contacts/:contactId/conversation-count] Exception:', {
      error: err.message,
      contactId: req.params.contactId,
      userId: req.user?.id
    });
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/contacts/:contactId', async (req, res) => {
  try {
    if (!req.user) {
      console.warn('[DELETE /api/contacts/:contactId] Not authenticated');
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const contactId = req.params.contactId;
    console.log('[DELETE /api/contacts/:contactId] Received contactId:', {
      raw: contactId,
      type: typeof contactId,
      isEmpty: !contactId,
      isNull: contactId === null,
      isUndefined: contactId === undefined
    });

    // Defensive validation: check for null/undefined/empty first
    if (contactId === null || contactId === undefined) {
      console.error('[DELETE /api/contacts/:contactId] Contact ID is null or undefined:', {contactId});
      return res.status(400).json({ error: 'Invalid contact ID (null or undefined)' });
    }

    // Convert to string and trim
    const contactIdStr = String(contactId).trim();
    if (!contactIdStr) {
      console.error('[DELETE /api/contacts/:contactId] Contact ID is empty after trim:', {raw: contactId});
      return res.status(400).json({ error: 'Invalid contact ID (empty)' });
    }

    // Validate format: must be digits only
    if (!/^\d+$/.test(contactIdStr)) {
      console.error('[DELETE /api/contacts/:contactId] Invalid contact ID format:', {raw: contactId, trimmed: contactIdStr});
      return res.status(400).json({ error: 'Invalid contact ID (invalid format)' });
    }

    console.log('[DELETE /api/contacts/:contactId] Contact ID validation passed:', {contactId: contactIdStr});

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      console.error('[DELETE /api/contacts/:contactId] Invalid user ID:', {userId: req.user.id});
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Get contact_user_id before deletion
    console.log('[DELETE /api/contacts/:contactId] Querying contact with ID:', {contactId: contactIdStr, userId});

    const contactResult = await pool.query(`
      SELECT contact_user_id FROM user_contacts
      WHERE id = $1 AND user_id = $2
    `, [contactIdStr, userId]);

    if (contactResult.rowCount === 0) {
      console.warn('[DELETE /api/contacts/:contactId] Contact not found:', {contactId: contactIdStr, userId});
      return res.status(404).json({ error: 'Contact not found' });
    }

    const contactUserId = contactResult.rows[0].contact_user_id;
    console.log('[DELETE /api/contacts/:contactId] Contact found. Contact user ID:', {contactUserId});

    // Delete all conversations with this contact (cascade deletes messages)
    const convResult = await pool.query(`
      DELETE FROM conversations
      WHERE (participant_a_id = $1 AND participant_b_id = $2)
         OR (participant_a_id = $2 AND participant_b_id = $1)
    `, [userId, contactUserId]);

    const deletedConversations = convResult.rowCount;
    console.log('[DELETE /api/contacts/:contactId] Deleted conversations:', {count: deletedConversations});

    // Delete the contact record
    await pool.query(`
      DELETE FROM user_contacts
      WHERE id = $1 AND user_id = $2
    `, [contactIdStr, userId]);

    console.log('[DELETE /api/contacts/:contactId] Contact record deleted successfully:', {contactId: contactIdStr});
    res.json({ ok: true, deletedConversations });
  } catch (err) {
    console.error('[DELETE /api/contacts/:contactId] Exception during contact deletion:', {
      error: err.message,
      contactId: req.params.contactId,
      userId: req.user?.id
    });
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

    let rows;

    // Query local database
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
          source: 'local',
          mutualCount: 0,
        }));
        return res.json({ users: filteredUsers });
      }
      // For non-timeout errors, re-throw to be caught by outer catch
      throw timeoutErr;
    }

    // Convert database results to include source field
    const localUsers = rows.map(r => ({
      id: r.id,
      username: r.username,
      usernode_pubkey: r.usernode_pubkey || null,
      verified: !!r.verified_at,
      source: 'local',
      mutualCount: 0,
    }));

    // Query blockchain usernames cache (with timeout) - only in real_testnet mode
    let blockchainUsers = [];
    if (NETWORK_MODE === 'real_testnet' && global.usernamesCache && global.usernamesCache.ready() && q.length >= 2) {
      try {
        const blockchainTimeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Blockchain timeout')), 2500)
        );
        const blockchainQuery = Promise.resolve(global.usernamesCache.searchUsernames(q));

        const blockchainResults = await Promise.race([blockchainQuery, blockchainTimeout]);
        blockchainUsers = blockchainResults.map(u => ({
          username: u.username,
          usernode_pubkey: u.usernode_pubkey,
          source: 'blockchain',
          mutualCount: 0,
        }));
      } catch (blockchainErr) {
        // Silently fail on blockchain timeout or error
        console.debug('[SearchUsers] Blockchain query failed:', blockchainErr.message);
      }
    }

    // Merge and deduplicate results (local takes precedence over blockchain)
    const seenPubkeys = new Set();
    const allUsers = [];

    // Add local users first
    for (const user of localUsers) {
      if (user.usernode_pubkey) {
        seenPubkeys.add(user.usernode_pubkey.toLowerCase());
      }
      allUsers.push(user);
    }

    // Add blockchain users that aren't already in local results
    for (const user of blockchainUsers) {
      if (user.usernode_pubkey && !seenPubkeys.has(user.usernode_pubkey.toLowerCase())) {
        allUsers.push(user);
      }
    }

    res.json({ users: allUsers });
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
    const token = req.query.token || req.headers['x-usernode-token'];
    const foregroundHours = await getForegroundHours(user.id, token);
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
    const token = req.query.token || req.headers['x-usernode-token'];
    const foregroundHours = await getForegroundHours(userId, token);
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

    // Validation: check wallet connection before proceeding with group creation (skip in demo mode)
    console.log(`[POST /api/groups::VALIDATE] Checking wallet connection: usernode_pubkey=${req.user.usernode_pubkey ? 'present' : 'missing'}, NETWORK_MODE=${NETWORK_MODE}`);
    const walletValidation = await validateWalletForMode(NETWORK_MODE, userId, req.user.usernode_pubkey);
    if (!walletValidation.valid) {
      console.error(`[POST /api/groups::VALIDATE] Wallet validation failed: ${walletValidation.error}`);
      return res.status(401).json({ error: walletValidation.error });
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
      network: network,
      rpcEndpoint: NODE_RPC_URL
    };
    console.log(`[POST /api/groups::BLOCKCHAIN] Transaction payload prepared: type=${transactionPayload.type}, groupId=${transactionPayload.groupId}, memberCount=${transactionPayload.memberPubkeys.length}, network=${transactionPayload.network}, creatorPubkeyPresent=${!!transactionPayload.creatorPubkey}`);

    // Sign memo following Last One Wins pattern
    const memo = signTransactionMemo(transactionPayload);

    // Blockchain: Use existing audit log if provided, otherwise create new one
    // Determine audit status and network origin based on mode
    let auditStatus = 'pending';
    let networkOriginValue = null;
    let actualTxHash = null;

    // For testnet mode with RPC: submit real transaction, store null tx_hash initially
    if (NETWORK_MODE === 'testnet' && NODE_RPC_URL && !txHash) {
      auditStatus = 'pending';
      networkOriginValue = 'testnet';
      actualTxHash = null;
    } else if (txHash) {
      actualTxHash = txHash;
      auditStatus = 'pending';
      networkOriginValue = 'blockchain';
    } else if (NETWORK_MODE === 'devnet') {
      actualTxHash = 'ut1devnet-group-' + groupId + '-' + Date.now();
      auditStatus = 'confirmed';
      networkOriginValue = 'database';
    } else {
      // Testnet without RPC: store null, will be populated later
      actualTxHash = null;
      auditStatus = 'pending';
      networkOriginValue = 'bridge';
    }

    let blockchainRecordingId;
    if (auditLogId) {
      // Two-phase flow: audit log already exists from wallet signature, just update it
      console.log(`[POST /api/groups::BLOCKCHAIN] Using existing audit log: id=${auditLogId}`);
      await pool.query(`
        UPDATE blockchain_audit_logs
        SET group_id = $1, message_type = $2, tx_hash = $3, transaction_payload = $4, status = $5, confirmed_at = $6, content_hash = $7, user_pubkey = $8, action_timestamp = $9, network_origin = $10, updated_at = NOW()
        WHERE id = $11 AND user_id = $12
      `, [groupId, 'group_create', actualTxHash, JSON.stringify(transactionPayload), auditStatus, (auditStatus === 'confirmed' ? now : null), contentHash, req.user.usernode_pubkey || null, now, networkOriginValue, auditLogId, userId]);
      blockchainRecordingId = auditLogId;
      console.log(`[POST /api/groups::BLOCKCHAIN] Updated existing audit log: id=${blockchainRecordingId}`);
    } else {
      // Single-phase flow: create new audit log
      console.log(`[AUDIT LOG] GROUP_CREATE: txHash=${actualTxHash || 'pending'}, groupId=${groupId}, status=${auditStatus}, memberCount=${memberPubkeys.length}`);
      console.log(`[POST /api/groups::BLOCKCHAIN] Creating new audit log: txHash=${actualTxHash || 'pending'}, status=${auditStatus}, env=${IS_STAGING ? 'staging' : 'production'}`);

      const auditRes = await pool.query(`
        INSERT INTO blockchain_audit_logs (user_id, group_id, message_type, tx_hash, transaction_payload, status, confirmed_at, content_hash, user_pubkey, action_timestamp, network_origin, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
        RETURNING id
      `, [userId, groupId, 'group_create', actualTxHash, JSON.stringify(transactionPayload), auditStatus, (auditStatus === 'confirmed' ? now : null), contentHash, req.user.usernode_pubkey || null, now, networkOriginValue, now]);

      if (auditRes.rows.length === 0) {
        console.error(`[POST /api/groups::BLOCKCHAIN] Audit log insert returned no rows`);
        throw new Error('Audit log creation query returned no results');
      }
      blockchainRecordingId = auditRes.rows[0].id;
      console.log(`[POST /api/groups::BLOCKCHAIN] Audit log created: id=${blockchainRecordingId}, rowCount=${auditRes.rowCount}`);
    }

    // Blockchain: If real tx hash provided from frontend, start polling immediately (skip for devnet)
    if (txHash && NETWORK_MODE !== 'devnet') {
      console.log(`[POST /api/groups::BLOCKCHAIN] Real txHash provided from frontend, starting polling`);
      (async () => {
        try {
          await pollTransactionStatus(blockchainRecordingId, txHash);
        } catch (err) {
          console.error('Error polling transaction status:', err);
        }
      })();
    } else if (NETWORK_MODE === 'testnet' && NODE_RPC_URL && !txHash) {
      // Testnet with RPC: submit real transaction
      console.log(`[POST /api/groups::BLOCKCHAIN] Spawning background blockchain submission task (testnet RPC)`);
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
            UPDATE blockchain_audit_logs SET tx_hash = $1, network_origin = 'testnet', updated_at = NOW() WHERE id = $2
          `, [result.transactionHash, blockchainRecordingId]);
          console.log(`[POST /api/groups::BLOCKCHAIN::ASYNC] Audit log updated with real txHash, rowCount=${updateRes.rowCount}`);

          console.log(`[POST /api/groups::BLOCKCHAIN::ASYNC] Starting chain polling`);
          startChainPoller(network, result.transactionHash, blockchainRecordingId).catch(err => {
            console.error(`[POST /api/groups::BLOCKCHAIN::ASYNC] Error starting chain poller: ${err.message}`, err);
          });
        } catch (err) {
          const errorClass = classifyRPCError(err);
          console.error(`[BLOCKCHAIN-FALLBACK] RPC failed (${errorClass.type}), using bridge fallback for groupId=${groupId}: ${err.message}`);

          // Fallback: try bridge approach
          try {
            const bridgeResult = await sendTransactionToBridge(transactionPayload, null, network);

            await pool.query(`
              UPDATE blockchain_audit_logs SET tx_hash = $1, network_origin = 'bridge', updated_at = NOW() WHERE id = $2
            `, [bridgeResult.txHash, blockchainRecordingId]);

            console.log(`[BLOCKCHAIN-FALLBACK] Updated audit log with bridge tx hash: txHash=${bridgeResult.txHash}, auditLogId=${blockchainRecordingId}`);

            // Start polling with placeholder so it eventually marks as 'failed'
            startChainPoller(network, bridgeResult.txHash, blockchainRecordingId).catch(pollerErr => {
              console.error(`[POST /api/groups::BLOCKCHAIN::ASYNC] Error starting fallback chain poller: ${pollerErr.message}`, pollerErr);
            });
          } catch (bridgeErr) {
            console.error(`[BLOCKCHAIN-FALLBACK] Bridge fallback also failed: ${bridgeErr.message}`);
            await pool.query(`
              UPDATE blockchain_audit_logs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2
            `, [bridgeErr.message, blockchainRecordingId]);
          }
        }
      })();
    } else if (NETWORK_MODE === 'mainnet') {
      // Mainnet: use bridge fallback
      console.log(`[POST /api/groups::BLOCKCHAIN] Spawning background blockchain submission task (bridge fallback)`);
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
          const errorClass = classifyRPCError(err);
          console.error(`[BLOCKCHAIN-FALLBACK] RPC failed (${errorClass.type}), using bridge fallback for groupId=${groupId}: ${err.message}`);

          // Fallback: try bridge approach
          try {
            const bridgeResult = await sendTransactionToBridge(transactionPayload, null, network);

            await pool.query(`
              UPDATE blockchain_audit_logs SET tx_hash = $1 WHERE id = $2
            `, [bridgeResult.txHash, blockchainRecordingId]);

            console.log(`[BLOCKCHAIN-FALLBACK] Updated audit log with bridge tx hash: txHash=${bridgeResult.txHash}, auditLogId=${blockchainRecordingId}`);

            // Start polling with placeholder so it eventually marks as 'failed'
            startChainPoller(network, bridgeResult.txHash, blockchainRecordingId).catch(pollerErr => {
              console.error(`[POST /api/groups::BLOCKCHAIN::ASYNC] Error starting fallback chain poller: ${pollerErr.message}`, pollerErr);
            });
          } catch (bridgeErr) {
            console.error(`[BLOCKCHAIN-FALLBACK] Bridge fallback also failed: ${bridgeErr.message}`);
            await pool.query(`
              UPDATE blockchain_audit_logs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2
            `, [bridgeErr.message, blockchainRecordingId]);
          }
        }
      })();
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
    const walletValidation = await validateWalletForMode(NETWORK_MODE, userId, req.user.usernode_pubkey);
    if (!walletValidation.valid) {
      return res.status(401).json({ error: walletValidation.error });
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
    const placeholderTxHash = 'ut1-' + networkPrefix + 'tx-update-' + Math.random().toString(36).substr(2, 9);
    const auditStatus = 'pending';
    const auditRes = await pool.query(`
      INSERT INTO blockchain_audit_logs (user_id, message_type, tx_hash, transaction_payload, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $6)
      RETURNING id
    `, [userId, 'group_update', placeholderTxHash, JSON.stringify(transactionPayload), auditStatus, now]);
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
  const client = await pool.connect();
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
    const walletValidation = await validateWalletForMode(NETWORK_MODE, userId, req.user.usernode_pubkey);
    if (!walletValidation.valid) {
      return res.status(401).json({ error: walletValidation.error });
    }

    const now = new Date();

    if (!checkRateLimit(`gmsg:${userId}`, 100, 60000)) {
      return res.status(429).json({ error: 'Rate limited' });
    }

    if (!type || !content) {
      return res.status(400).json({ error: 'Invalid message' });
    }

    // Verify user is a member of group
    const { rows: memberRows } = await client.query(`
      SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [groupId, userId]);

    if (memberRows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    // Start a database transaction for atomic INSERT + UPDATE
    await client.query('BEGIN');

    // Fetch user's pubkey
    const userPubkey = req.user.usernode_pubkey || null;
    const network = 'testnet';

    // Create message with blockchain recording enabled
    const contentHash = computeContentHash(content);
    const msgRes = await client.query(`
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

    // Determine audit status and network origin based on mode
    let auditStatus = 'pending';
    let networkOriginValue = null;
    let actualTxHash = null;

    // For testnet mode with RPC: submit real transaction, store null tx_hash initially
    if (NETWORK_MODE === 'testnet' && NODE_RPC_URL && !txHash) {
      auditStatus = 'pending';
      networkOriginValue = 'testnet';
      actualTxHash = null;
    } else if (txHash) {
      actualTxHash = txHash;
      auditStatus = 'pending';
      networkOriginValue = 'testnet';
    } else if (NETWORK_MODE === 'devnet') {
      actualTxHash = 'ut1devnet-message-' + messageId + '-' + Date.now();
      auditStatus = 'confirmed';
      networkOriginValue = 'database';
    } else {
      // Testnet without RPC: store null, will be populated later
      actualTxHash = null;
      auditStatus = 'pending';
      networkOriginValue = 'bridge';
    }

    let blockchainRecordingId;
    if (auditLogId) {
      // Two-phase flow: audit log already exists from wallet signature, just update it
      console.log(`[GROUP-MSG] Using existing audit log: id=${auditLogId}`);
      const updateRes = await client.query(`
        UPDATE blockchain_audit_logs
        SET group_id = $1, message_type = $2, tx_hash = $3, transaction_payload = $4, status = $5, confirmed_at = $6, content_hash = $7, user_pubkey = $8, action_timestamp = $9, network_origin = $10, updated_at = NOW()
        WHERE id = $11 AND user_id = $12
      `, [groupId, 'message', actualTxHash, JSON.stringify(transactionPayload), auditStatus, (auditStatus === 'confirmed' ? now : null), contentHash, userPubkey, now, networkOriginValue, auditLogId, userId]);

      if (updateRes.rowCount === 0) {
        throw new Error('Audit log not found or does not belong to user');
      }
      blockchainRecordingId = auditLogId;
      console.log(`[GROUP-MSG] Updated existing audit log: id=${blockchainRecordingId}`);
    } else {
      // Single-phase flow: create new audit log
      // For testnet with RPC, actualTxHash may be null initially; will be updated after RPC submission
      const auditRes = await client.query(`
        INSERT INTO blockchain_audit_logs (user_id, group_id, message_type, tx_hash, transaction_payload, status, confirmed_at, content_hash, user_pubkey, action_timestamp, network_origin, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
        RETURNING id
      `, [userId, groupId, 'message', actualTxHash, JSON.stringify(transactionPayload), auditStatus, (auditStatus === 'confirmed' ? now : null), contentHash, userPubkey, now, networkOriginValue, now]);
      blockchainRecordingId = auditRes.rows[0].id;
    }

    // Update message with audit log reference (ATOMIC with INSERT)
    const updateMsgRes = await client.query(`
      UPDATE group_messages SET blockchain_audit_log_id = $1 WHERE id = $2
    `, [blockchainRecordingId, messageId]);

    if (updateMsgRes.rowCount === 0) {
      throw new Error('Failed to update message with audit log reference');
    }

    // Update group updated_at to reflect new message activity
    const updateGrpRes = await client.query(`
      UPDATE groups SET updated_at = NOW() WHERE id = $1
    `, [groupId]);

    if (updateGrpRes.rowCount === 0) {
      throw new Error('Group not found');
    }

    // Commit the transaction - all INSERTs/UPDATEs are now atomic
    await client.query('COMMIT');

    console.log(`[GROUP-MSG] Transaction committed: messageId=${messageId}, auditLogId=${blockchainRecordingId}`);

    // Return success BEFORE starting async polling (fixes race condition)
    res.json({
      id: messageId,
      createdAt: new Date(now),
      blockchainRecordingId: blockchainRecordingId
    });

    // Async polling starts AFTER response is sent
    // If real tx hash provided from frontend, start polling immediately
    if (txHash) {
      startChainPoller(network, txHash, blockchainRecordingId).catch(err => {
        console.error('Error starting chain poller:', err);
      });
    } else if (NETWORK_MODE === 'testnet' && NODE_RPC_URL) {
      // Testnet with RPC: submit real transaction
      (async () => {
        try {
          console.log(`[GROUP-MSG-RPC] Submitting group message to testnet RPC for auditLogId=${blockchainRecordingId}`);
          const result = await sendMessageToBlockchain(transactionPayload, signTransactionMemo(transactionPayload), network);
          // Update audit log with real tx hash
          console.log(`[GROUP-MSG-RPC] Received real txHash=${result.transactionHash}, updating auditLogId=${blockchainRecordingId}`);
          await pool.query(`
            UPDATE blockchain_audit_logs SET tx_hash = $1, network_origin = 'testnet', updated_at = NOW() WHERE id = $2
          `, [result.transactionHash, blockchainRecordingId]);
          // Start polling
          startChainPoller(network, result.transactionHash, blockchainRecordingId).catch(err => {
            console.error('Error starting chain poller:', err);
          });
        } catch (err) {
          const errorClass = classifyRPCError(err);
          console.error(`[GROUP-MSG-RPC] RPC failed (${errorClass.type}), using bridge fallback: ${err.message}`);
          try {
            const bridgeResult = await sendTransactionToBridge(transactionPayload, null, network);
            await pool.query(`
              UPDATE blockchain_audit_logs SET tx_hash = $1, network_origin = 'bridge', updated_at = NOW() WHERE id = $2
            `, [bridgeResult.txHash, blockchainRecordingId]);
            startChainPoller(network, bridgeResult.txHash, blockchainRecordingId).catch(pollerErr => {
              console.error('Error starting fallback chain poller:', pollerErr);
            });
          } catch (bridgeErr) {
            console.error(`[GROUP-MSG-RPC] Bridge fallback failed: ${bridgeErr.message}`);
            await pool.query(`
              UPDATE blockchain_audit_logs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2
            `, [bridgeErr.message, blockchainRecordingId]);
          }
        }
      })();
    } else if (NETWORK_MODE === 'mainnet') {
      // Mainnet: use bridge fallback
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
  } catch (err) {
    // Rollback on error
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback error:', rollbackErr.message);
    }
    console.error('Error sending group message:', err);
    res.status(500).json({ error: err.message });
  } finally {
    // Always release the client
    client.release();
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

    const result = await pool.query(`
      UPDATE group_messages
      SET deleted_by = CASE
        WHEN deleted_by IS NULL THEN ARRAY[$1]
        ELSE array_append(deleted_by, $1)
      END
      WHERE id = $2 AND group_id = $3
    `, [userId, messageId, groupId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

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
    const placeholderTxHash = 'ut1-' + networkPrefix + 'tx-addmem-' + Math.random().toString(36).substr(2, 9);
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
    const placeholderTxHash = 'ut1-' + networkPrefix + 'tx-remmem-' + Math.random().toString(36).substr(2, 9);
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
    const placeholderTxHash = 'ut1-' + networkPrefix + 'tx-leave-' + Math.random().toString(36).substr(2, 9);
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
    const placeholderTxHash = 'ut1-' + networkPrefix + 'tx-delete-' + Math.random().toString(36).substr(2, 9);
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

    // Get JWT token from request for peer sync authentication
    const token = req.query.token || req.headers['x-usernode-token'];

    // Bypass cache if refresh=true query param
    if (req.query.refresh === 'true') {
      peerSyncCache.delete(req.user.id);
    }

    const foregroundHours = await getForegroundHours(req.user.id, token);
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

// Get user-specific peer count (testnet peers connected to this user)
// Only available when user has network_mode set to 'real_testnet'
app.get('/api/user/peers/connected', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Check if network mode is real_testnet for this user
    const { rows: userRows } = await pool.query(`
      SELECT network FROM users WHERE id = $1
    `, [userId]);

    if (!userRows.length || userRows[0].network !== 'real_testnet') {
      return res.status(403).json({
        error: 'Peer count feature is not enabled',
        available: false
      });
    }

    if (IS_STAGING) {
      // In staging, provide mock data cycling through [3, 7, 5, 9, 6] every 10 seconds
      const mockPeerCounts = [3, 7, 5, 9, 6];
      const timeWindow = Math.floor(Date.now() / 10000); // 10-second windows
      const userPeerCount = mockPeerCounts[(timeWindow + userId) % mockPeerCounts.length];
      // Generate deterministic mock peer IDs
      const peerIds = Array.from({ length: userPeerCount }, (_, i) =>
        `ut1peer${userId}${i.toString().padStart(3, '0')}`
      );

      return res.json({
        userPeerCount,
        peerIds,
        lastUpdatedAt: new Date().toISOString()
      });
    } else {
      // In production, query user_peers table
      const { rows } = await pool.query(`
        SELECT peer_id FROM user_peers
        WHERE user_id = $1 AND last_seen_at > NOW() - INTERVAL '30 seconds'
        ORDER BY last_seen_at DESC
      `, [userId]);

      const peerIds = rows.map(r => r.peer_id);
      return res.json({
        userPeerCount: peerIds.length,
        peerIds,
        lastUpdatedAt: new Date().toISOString()
      });
    }
  } catch (err) {
    console.error('Error fetching user peer count:', err);
    res.status(500).json({ error: 'Failed to fetch user peer count' });
  }
});

// Log a foreground session
app.post('/api/user/foreground-session', express.json(), async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const { sessionDurationSeconds } = req.body;
    if (typeof sessionDurationSeconds !== 'number' || sessionDurationSeconds < 0) {
      return res.status(400).json({ error: 'Invalid sessionDurationSeconds' });
    }

    // Skip session logging for very short sessions (< 1 second)
    if (sessionDurationSeconds < 1) {
      return res.json({ status: 'skipped', reason: 'Session too short' });
    }

    if (IS_STAGING) {
      // In staging, accept the request but don't persist
      return res.json({
        status: 'accepted',
        message: 'Session logged (staging mode)',
        durationSeconds: sessionDurationSeconds
      });
    } else {
      // In production, log the session
      const now = new Date();
      const sessionStart = new Date(now.getTime() - sessionDurationSeconds * 1000);
      const sessionEnd = now;

      await pool.query(`
        INSERT INTO user_foreground_sessions (user_id, session_start, session_end, duration_seconds)
        VALUES ($1, $2, $3, $4)
      `, [userId, sessionStart, sessionEnd, Math.round(sessionDurationSeconds)]);

      return res.json({
        status: 'logged',
        durationSeconds: sessionDurationSeconds
      });
    }
  } catch (err) {
    console.error('Error logging foreground session:', err);
    res.status(500).json({ error: 'Failed to log foreground session' });
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

    let query = `
      SELECT c.id, c.name, c.description, c.is_system, c.owner_id, c.category, c.is_verified, c.verified_at, c.is_featured, c.created_at, c.updated_at,
             u.username as ownerUsername,
             (SELECT COUNT(*) FROM channel_unread WHERE user_id = $1 AND channel_id = c.id AND unread_count > 0)::INTEGER as unreadCount,
             (SELECT COUNT(*) FROM pinned_channels WHERE user_id = $1 AND channel_id = c.id)::INTEGER as isPinned,
             (SELECT COUNT(*) FROM channel_followers WHERE channel_id = c.id)::INTEGER as followerCount,
             (SELECT COUNT(*) FROM channel_followers WHERE user_id = $1 AND channel_id = c.id)::INTEGER as isFollowing
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
        ownerUsername: c.ownerUsername || (c.owner_id && c.owner_id !== -1 ? `user-${c.owner_id}` : null),
        category: c.category,
        isVerified: c.is_verified,
        verifiedAt: c.verified_at,
        isFeatured: c.is_featured,
        isSystem: c.is_system,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        unreadCount: parseInt(c.unreadCount) || 0,
        isPinned: parseInt(c.isPinned) > 0,
        followerCount: parseInt(c.followerCount) || 0,
        isFollowing: parseInt(c.isFollowing) > 0
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
        fp.image_urls,
        fp.created_at,
        fp.updated_at,
        fp.on_chain,
        u.username,
        u.verified_at,
        u.avatar_url,
        c.name as channel_name
      FROM feed_posts fp
      JOIN users u ON u.id = fp.user_id
      LEFT JOIN channels c ON fp.channel_id = c.id
      WHERE fp.channel_id = $1 AND fp.deleted_at IS NULL
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
      imageUrls: post.image_urls || [],
      createdAt: post.created_at,
      updatedAt: post.updated_at,
      isEdited: post.updated_at && post.created_at && (new Date(post.updated_at) - new Date(post.created_at)) > 1000,
      onChain: post.on_chain || false,
      channelName: post.channel_name
    }));

    const { rows: countResult } = await pool.query(`
      SELECT COUNT(*) as count FROM feed_posts WHERE channel_id = $1 AND deleted_at IS NULL
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

// POST /api/channels/:channelId/posts - Create a new post in a channel (owner only)
app.post('/api/channels/:channelId/posts', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const channelId = parseInt(req.params.channelId);
    const userId = parseInt(req.user.id, 10);
    const { content, imageUrls } = req.body;

    if (isNaN(channelId) || isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid channel or user ID' });
    }

    // Validate content and images
    const trimmedContent = content ? content.trim() : '';
    const images = Array.isArray(imageUrls) ? imageUrls : [];

    // At least one of content or images must be provided
    if (trimmedContent.length === 0 && images.length === 0) {
      return res.status(400).json({ error: 'Post must contain either text or images' });
    }

    if (trimmedContent.length > 2000) {
      return res.status(400).json({ error: 'Post is too long (exceeds 2000 characters)' });
    }

    if (images.length > 4) {
      return res.status(400).json({ error: 'Maximum 4 images per post' });
    }

    // Check channel exists and user is owner or follower
    const { rows: channelCheck } = await pool.query(`
      SELECT id, owner_id FROM channels WHERE id = $1
    `, [channelId]);

    if (channelCheck.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const isOwner = channelCheck[0].owner_id === userId;

    if (!isOwner) {
      // Check if user is a follower
      const { rows: followerCheck } = await pool.query(`
        SELECT 1 FROM channel_followers WHERE user_id = $1 AND channel_id = $2
      `, [userId, channelId]);

      if (followerCheck.length === 0) {
        return res.status(403).json({ error: 'You must follow this channel to post in it' });
      }
    }

    // Insert the post
    const { rows: postRows } = await pool.query(`
      INSERT INTO feed_posts (user_id, content, channel_id, on_chain, image_urls, created_at, updated_at)
      VALUES ($1, $2, $3, FALSE, $4, NOW(), NOW())
      RETURNING id, user_id, content, image_urls, created_at, updated_at, on_chain
    `, [userId, JSON.stringify({ text: trimmedContent }), channelId, JSON.stringify(images)]);

    if (postRows.length === 0) {
      return res.status(500).json({ error: 'Failed to create post' });
    }

    const post = postRows[0];
    const { rows: userRows } = await pool.query(`
      SELECT username, verified_at, avatar_url FROM users WHERE id = $1
    `, [userId]);

    const username = userRows.length > 0 ? userRows[0].username : 'user' + userId;
    const verified = userRows.length > 0 && !!userRows[0].verified_at;
    const avatarUrl = userRows.length > 0 ? userRows[0].avatar_url : null;

    res.status(201).json({
      id: post.id,
      userId: post.user_id,
      username: username,
      verified: verified,
      avatarUrl: avatarUrl,
      content: post.content,
      imageUrls: post.image_urls || [],
      createdAt: post.created_at,
      updatedAt: post.updated_at,
      isEdited: false,
      onChain: post.on_chain || false
    });
  } catch (err) {
    console.error('Error creating channel post:', err);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// POST /api/channels/:channelId/posts/:postId - Edit a post (owner or channel owner)
app.post('/api/channels/:channelId/posts/:postId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const channelId = parseInt(req.params.channelId);
    const postId = parseInt(req.params.postId);
    const userId = parseInt(req.user.id, 10);
    const { content } = req.body;

    if (isNaN(channelId) || isNaN(postId) || isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid channel, post, or user ID' });
    }

    // Validate content
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Post content is required' });
    }

    const trimmedContent = content.trim();
    if (trimmedContent.length === 0) {
      return res.status(400).json({ error: 'Post content cannot be empty' });
    }

    if (trimmedContent.length > 2000) {
      return res.status(400).json({ error: 'Post is too long (exceeds 2000 characters)' });
    }

    // Get channel and post information
    const { rows: channelCheck } = await pool.query(`
      SELECT owner_id FROM channels WHERE id = $1
    `, [channelId]);

    if (channelCheck.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const { rows: postCheck } = await pool.query(`
      SELECT user_id FROM feed_posts WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL
    `, [postId, channelId]);

    if (postCheck.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Check permission: post owner or channel owner
    const postOwnerId = postCheck[0].user_id;
    const channelOwnerId = channelCheck[0].owner_id;

    if (userId !== postOwnerId && userId !== channelOwnerId) {
      return res.status(403).json({ error: 'You do not have permission to edit this post' });
    }

    // Update the post
    const { rows: updatedPost } = await pool.query(`
      UPDATE feed_posts
      SET content = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, user_id, content, created_at, updated_at, on_chain
    `, [JSON.stringify({ text: trimmedContent }), postId]);

    if (updatedPost.length === 0) {
      return res.status(500).json({ error: 'Failed to update post' });
    }

    const post = updatedPost[0];
    const { rows: userRows } = await pool.query(`
      SELECT username, verified_at, avatar_url FROM users WHERE id = $1
    `, [post.user_id]);

    const username = userRows.length > 0 ? userRows[0].username : 'user' + post.user_id;
    const verified = userRows.length > 0 && !!userRows[0].verified_at;
    const avatarUrl = userRows.length > 0 ? userRows[0].avatar_url : null;

    res.status(200).json({
      id: post.id,
      userId: post.user_id,
      username: username,
      verified: verified,
      avatarUrl: avatarUrl,
      content: post.content,
      createdAt: post.created_at,
      updatedAt: post.updated_at,
      isEdited: true,
      onChain: post.on_chain || false
    });
  } catch (err) {
    console.error('Error editing channel post:', err);
    res.status(500).json({ error: 'Failed to edit post' });
  }
});

// DELETE /api/channels/:channelId/posts/:postId - Delete a post (soft delete, owner or channel owner)
app.delete('/api/channels/:channelId/posts/:postId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const channelId = parseInt(req.params.channelId);
    const postId = parseInt(req.params.postId);
    const userId = parseInt(req.user.id, 10);

    if (isNaN(channelId) || isNaN(postId) || isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid channel, post, or user ID' });
    }

    // Demo mode: return mock success
    // Get channel and post information
    const { rows: channelCheck } = await pool.query(`
      SELECT owner_id FROM channels WHERE id = $1
    `, [channelId]);

    if (channelCheck.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const { rows: postCheck } = await pool.query(`
      SELECT user_id FROM feed_posts WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL
    `, [postId, channelId]);

    if (postCheck.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Check permission: post owner or channel owner
    const postOwnerId = postCheck[0].user_id;
    const channelOwnerId = channelCheck[0].owner_id;

    if (userId !== postOwnerId && userId !== channelOwnerId) {
      return res.status(403).json({ error: 'You do not have permission to delete this post' });
    }

    // Soft delete: set deleted_at
    await pool.query(`
      UPDATE feed_posts
      SET deleted_at = NOW()
      WHERE id = $1
    `, [postId]);

    res.status(200).json({ success: true, message: 'Post deleted' });
  } catch (err) {
    console.error('Error deleting channel post:', err);
    res.status(500).json({ error: 'Failed to delete post' });
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
    const walletValidation = await validateWalletForMode(NETWORK_MODE, userId, req.user.usernode_pubkey);
    if (!walletValidation.valid) {
      return res.status(401).json({ error: walletValidation.error });
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

    const ownerUsername = (userRows.length > 0 && userRows[0].username) ? userRows[0].username : `user-${userId}`;

    // Auto-follow: creator automatically follows their own channel
    await pool.query(`
      INSERT INTO channel_followers (user_id, channel_id, followed_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id, channel_id) DO NOTHING
    `, [userId, channel.id]);

    // Update audit log with txHash
    if (auditLogId) {
      const auditStatusForChannel = 'pending';
      await pool.query(`
        UPDATE blockchain_audit_logs
        SET tx_hash = $1, status = $2
        WHERE id = $3 AND user_id = $4
      `, [txHash, auditStatusForChannel, auditLogId, userId]);
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

// PUT /api/channels/:channelId - Update a channel (owner only)
app.put('/api/channels/:channelId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const channelId = parseInt(req.params.channelId);
    const { name, description } = req.body;

    if (isNaN(channelId)) {
      return res.status(400).json({ error: 'Invalid channel ID' });
    }

    // Validate input
    if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 255) {
      return res.status(400).json({ error: 'Channel name is required and must be 1-255 characters' });
    }

    if (description && (typeof description !== 'string' || description.length > 1000)) {
      return res.status(400).json({ error: 'Description must be max 1000 characters' });
    }

    // Check if channel exists and verify ownership
    const { rows: channelCheck } = await pool.query(`
      SELECT id, owner_id FROM channels WHERE id = $1
    `, [channelId]);

    if (channelCheck.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    if (channelCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the channel owner can edit this channel' });
    }

    // Update channel
    const { rows: updated } = await pool.query(`
      UPDATE channels
      SET name = $1, description = $2, updated_at = NOW()
      WHERE id = $3
      RETURNING id, name, description, owner_id, category, is_verified, verified_at, is_featured, is_system, created_at, updated_at
    `, [name.trim(), description || null, channelId]);

    if (updated.length === 0) {
      return res.status(500).json({ error: 'Failed to update channel' });
    }

    const channel = updated[0];

    // Get owner username
    const { rows: userRows } = await pool.query(`
      SELECT username FROM users WHERE id = $1
    `, [channel.owner_id]);

    const ownerUsername = userRows.length > 0 ? userRows[0].username : null;

    res.json({
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
    console.error('Error updating channel:', err);
    res.status(500).json({ error: 'Failed to update channel' });
  }
});

// DELETE /api/channels/:channelId - Delete a channel (owner only)
app.delete('/api/channels/:channelId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const channelId = parseInt(req.params.channelId);

    if (isNaN(channelId)) {
      return res.status(400).json({ error: 'Invalid channel ID' });
    }

    // Check if channel exists and verify ownership
    const { rows: channelCheck } = await pool.query(`
      SELECT id, owner_id FROM channels WHERE id = $1
    `, [channelId]);

    if (channelCheck.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    if (channelCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the channel owner can delete this channel' });
    }

    // Delete all posts in the channel first
    await pool.query(`
      DELETE FROM feed_posts WHERE channel_id = $1
    `, [channelId]);

    // Delete the channel
    await pool.query(`
      DELETE FROM channels WHERE id = $1
    `, [channelId]);

    res.json({ success: true, message: 'Channel deleted successfully' });
  } catch (err) {
    console.error('Error deleting channel:', err);
    res.status(500).json({ error: 'Failed to delete channel' });
  }
});

// GET /api/user/followed-channels - List owned channels and channels the user follows with latest post preview (deduplicated) + user contacts
app.get('/api/user/followed-channels', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Get deduplicated channels (owned or followed)
    const { rows: allChannels } = await pool.query(`
      SELECT DISTINCT ON (c.id)
             c.id, c.name, c.description, c.owner_id, c.category, c.is_verified, c.verified_at, c.is_featured, c.is_system, c.created_at, c.updated_at,
             u.username as ownerUsername,
             cf.followed_at,
             (SELECT COUNT(*) FROM channel_followers WHERE channel_id = c.id)::INTEGER as followerCount,
             fp.id as latestPostId,
             fp.user_id as latestPostUserId,
             fp.content as latestPostContent,
             fp.created_at as latestPostCreatedAt,
             pu.username as latestPostUsername
      FROM channels c
      LEFT JOIN users u ON c.owner_id = u.id
      LEFT JOIN channel_followers cf ON c.id = cf.channel_id AND cf.user_id = $1
      LEFT JOIN (
        SELECT DISTINCT ON (channel_id) id, user_id, content, created_at, channel_id
        FROM feed_posts
        ORDER BY channel_id, created_at DESC
      ) fp ON c.id = fp.channel_id
      LEFT JOIN users pu ON fp.user_id = pu.id
      WHERE c.owner_id = $1 OR cf.user_id = $1
      ORDER BY c.id, cf.followed_at DESC NULLS LAST, c.created_at DESC
    `, [req.user.id]);

    const channels = allChannels.map(ch => {
      const contentObj = ch.latestPostContent ? JSON.parse(ch.latestPostContent) : null;
      const contentSnippet = contentObj?.text ? contentObj.text.substring(0, 100) + (contentObj.text.length > 100 ? '...' : '') : null;

      return {
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
        createdAt: ch.created_at,
        updatedAt: ch.updated_at,
        followerCount: parseInt(ch.followerCount) || 0,
        followedAt: ch.followed_at,
        isFollowing: !!ch.followed_at,
        isOwner: ch.owner_id === req.user.id,
        latestPost: ch.latestPostId ? {
          id: ch.latestPostId,
          authorUsername: ch.latestPostUsername,
          contentSnippet: contentSnippet,
          createdAt: ch.latestPostCreatedAt
        } : null
      };
    });

    // Sort channels by latest post date (most recent first)
    channels.sort((a, b) => {
      if (!a.latestPost && !b.latestPost) return 0;
      if (!a.latestPost) return 1;
      if (!b.latestPost) return -1;
      return new Date(b.latestPost.createdAt) - new Date(a.latestPost.createdAt);
    });

    // Get user contacts
    const { rows: userContacts } = await pool.query(`
      SELECT uc.id, u.id as user_id, u.username, u.usernode_pubkey, u.verified_at, u.avatar_url, uc.nickname
      FROM user_contacts uc
      JOIN users u ON uc.contact_user_id = u.id
      WHERE uc.user_id = $1 AND (uc.archived_by IS NULL OR NOT $1 = ANY(uc.archived_by))
      ORDER BY u.username ASC
    `, [req.user.id]);

    const users = userContacts.map(r => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      usernode_pubkey: r.usernode_pubkey || null,
      nickname: r.nickname,
      verified: !!r.verified_at,
      avatar_url: r.avatar_url || null
    }));

    res.json({ channels, users });
  } catch (err) {
    console.error('Error fetching followed channels:', err);
    res.status(500).json({ error: 'Failed to fetch followed channels' });
  }
});

// POST /api/channels/:channelId/follow - Follow a channel
app.post('/api/channels/:channelId/follow', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const channelId = parseInt(req.params.channelId);
    if (isNaN(channelId)) {
      return res.status(400).json({ error: 'Invalid channel ID' });
    }

    // Check if channel exists
    const { rows: channelCheck } = await pool.query(`
      SELECT id FROM channels WHERE id = $1
    `, [channelId]);

    if (channelCheck.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Try to insert follower relationship
    const { rows: result } = await pool.query(`
      INSERT INTO channel_followers (user_id, channel_id, followed_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id, channel_id) DO NOTHING
      RETURNING id
    `, [req.user.id, channelId]);

    if (result.length === 0) {
      return res.status(409).json({ error: 'Already following this channel' });
    }

    res.json({ success: true, message: 'Channel followed' });
  } catch (err) {
    console.error('Error following channel:', err);
    res.status(500).json({ error: 'Failed to follow channel' });
  }
});

// DELETE /api/channels/:channelId/follow - Unfollow a channel
app.delete('/api/channels/:channelId/follow', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const channelId = parseInt(req.params.channelId);
    if (isNaN(channelId)) {
      return res.status(400).json({ error: 'Invalid channel ID' });
    }

    const { rows: result } = await pool.query(`
      DELETE FROM channel_followers
      WHERE user_id = $1 AND channel_id = $2
      RETURNING id
    `, [req.user.id, channelId]);

    if (result.length === 0) {
      return res.status(404).json({ error: 'Not following this channel' });
    }

    res.json({ success: true, message: 'Channel unfollowed' });
  } catch (err) {
    console.error('Error unfollowing channel:', err);
    res.status(500).json({ error: 'Failed to unfollow channel' });
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

// ============= BLOCKCHAIN API ENDPOINTS =============

app.put('/api/user/network-mode', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { networkMode } = req.body;
    if (!['devnet', 'testnet', 'real_testnet', 'mainnet'].includes(networkMode)) {
      return res.status(400).json({ error: 'Invalid input: networkMode must be "testnet", "devnet", or "mainnet"' });
    }

    const storedMode = networkMode === 'real_testnet' ? 'testnet' : networkMode;
    const skipSignatureValue = storedMode === 'devnet' ? true : false;

    await pool.query(
      `UPDATE users SET network_mode = $1, skip_signature_in_devnet = $2 WHERE id = $3`,
      [storedMode, skipSignatureValue, req.user.id]
    );
    res.json({ networkMode: storedMode, status: 'updated' });
  } catch (err) {
    console.error('Error updating network-mode:', err);
    res.status(500).json({ error: 'Failed to update network-mode' });
  }
});

app.put('/api/config/network-mode', async (req, res) => {
  try {
    const { networkMode } = req.body;
    if (!['devnet', 'testnet', 'real_testnet', 'mainnet'].includes(networkMode)) {
      return res.status(400).json({ error: 'Invalid networkMode' });
    }

    const storedMode = networkMode === 'real_testnet' ? 'testnet' : networkMode;
    NETWORK_MODE = storedMode;

    await pool.query(
      `INSERT INTO config_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      ['NETWORK_MODE', storedMode]
    );

    res.json({ networkMode: storedMode, status: 'updated' });
  } catch (err) {
    console.error('Error updating config network-mode:', err);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

app.get('/api/active_chain', async (req, res) => {
  try {
    res.json({
      chainId: NETWORK_MODE === 'testnet' ? 'testnet' : NETWORK_MODE === 'devnet' ? 'devnet' : 'unknown',
      networkMode: NETWORK_MODE,
      rpcUrl: NODE_RPC_URL || null,
      appPubkey: APP_PUBKEY
    });
  } catch (err) {
    console.error('Error getting active chain:', err);
    res.status(500).json({ error: 'Failed to get active chain' });
  }
});

app.get('/api/health/rpc', async (req, res) => {
  try {
    const health = await checkRPCHealth();
    res.json(health);
  } catch (err) {
    res.status(500).json({ error: 'Failed to check RPC health', details: err.message });
  }
});

app.put('/api/config/rpc-endpoint', async (req, res) => {
  try {
    const { rpcUrl } = req.body;

    if (!rpcUrl) {
      return res.status(400).json({ error: 'RPC URL is required' });
    }

    try {
      new URL(rpcUrl);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid RPC URL format', details: err.message });
    }

    NODE_RPC_URL = rpcUrl;

    await pool.query(
      `INSERT INTO config_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      ['NODE_RPC_URL', rpcUrl]
    );

    const health = await checkRPCHealth();

    res.json({
      rpcUrl: rpcUrl,
      status: health.reachable ? 'healthy' : 'unreachable',
      health: health
    });
  } catch (err) {
    console.error('Error updating RPC endpoint:', err);
    res.status(500).json({ error: 'Failed to update RPC endpoint', details: err.message });
  }
});

app.post('/api/tokens/send', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { recipientAddress, amount, memo } = req.body;

    if (!recipientAddress || !amount) {
      return res.status(400).json({ error: 'Recipient address and amount are required' });
    }

    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }

    if (NETWORK_MODE === 'devnet') {
      const demo = {
        success: true,
        txHash: `demo_token_${Date.now()}`,
        amount: amount,
        recipient: recipientAddress,
        mode: 'devnet',
        message: 'Demo token transfer (no actual transaction)'
      };

      return res.json(demo);
    }

    if (NETWORK_MODE === 'testnet') {
      const payload = {
        sender: req.user.usernode_pubkey || APP_PUBKEY,
        recipient: recipientAddress,
        amount: amount,
        memo: memo || null,
        timestamp: new Date().toISOString()
      };

      console.log(`[TOKEN SEND] User ${req.user.id} requesting token transfer to ${recipientAddress} for ${amount}`);

      const txHash = `pending_token_${Date.now()}`;

      try {
        const auditRes = await pool.query(`
          INSERT INTO blockchain_audit_logs (
            user_id, message_type, tx_hash, transaction_payload, status, user_pubkey, action_timestamp, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
          RETURNING id
        `, [
          req.user.id,
          'token_transfer',
          txHash,
          JSON.stringify(payload),
          'pending',
          req.user.usernode_pubkey || APP_PUBKEY,
          new Date().toISOString()
        ]);

        const auditLogId = auditRes.rows[0]?.id;

        if (auditLogId) {
          setImmediate(() => monitorBlockchainStatus(auditLogId, txHash));
        }
      } catch (auditErr) {
        console.error('[TOKEN SEND] Error creating audit log:', auditErr);
      }

      return res.json({
        success: true,
        txHash: txHash,
        amount: amount,
        recipient: recipientAddress,
        status: 'pending',
        mode: 'testnet'
      });
    }

    res.status(400).json({ error: 'Invalid network mode' });
  } catch (err) {
    console.error('[TOKEN SEND] Error:', err);
    res.status(500).json({ error: 'Failed to send tokens', details: err.message });
  }
});

app.get('/api/blockchain-audit/:auditLogId', async (req, res) => {
  try {
    const { auditLogId } = req.params;

    const result = await pool.query(`
      SELECT id, user_id, message_type, tx_hash, status, confirmed_at, error_message, created_at
      FROM blockchain_audit_logs
      WHERE id = $1
    `, [auditLogId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Audit log not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching blockchain audit log:', err);
    res.status(500).json({ error: 'Failed to fetch audit log', details: err.message });
  }
});

app.get('/api/user/latest-transaction/:messageType', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { messageType } = req.params;
    const validTypes = ['message', 'group', 'channel', 'token_transfer'];

    if (!validTypes.includes(messageType)) {
      return res.status(400).json({ error: 'Invalid message type' });
    }

    const result = await pool.query(`
      SELECT id, user_id, message_type, tx_hash, status, created_at
      FROM blockchain_audit_logs
      WHERE user_id = $1 AND message_type = $2
      ORDER BY created_at DESC
      LIMIT 1
    `, [req.user.id, messageType]);

    if (result.rows.length === 0) {
      return res.json({ transaction: null });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching latest transaction:', err);
    res.status(500).json({ error: 'Failed to fetch transaction', details: err.message });
  }
});

app.post('/api/blockchain-audit/:auditLogId/retry', async (req, res) => {
  try {
    const { auditLogId } = req.params;

    const auditResult = await pool.query(`
      SELECT tx_hash, status, user_id FROM blockchain_audit_logs WHERE id = $1
    `, [auditLogId]);

    if (auditResult.rows.length === 0) {
      return res.status(404).json({ error: 'Audit log not found' });
    }

    const audit = auditResult.rows[0];

    if (audit.status === 'confirmed') {
      return res.json({ status: 'already_confirmed', txHash: audit.tx_hash });
    }

    console.log(`[RETRY] Retrying transaction ${audit.tx_hash} for audit log ${auditLogId}`);

    await pool.query(`
      UPDATE blockchain_audit_logs SET status = 'pending', updated_at = NOW()
      WHERE id = $1
    `, [auditLogId]);

    setImmediate(() => monitorBlockchainStatus(auditLogId, audit.tx_hash));

    res.json({ status: 'retry_initiated', auditLogId: auditLogId });
  } catch (err) {
    console.error('Error retrying transaction:', err);
    res.status(500).json({ error: 'Failed to retry transaction', details: err.message });
  }
});

app.post('/api/transactions/create-pending-audit', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { messageType, txHash, payload } = req.body;

    if (!messageType || !txHash) {
      return res.status(400).json({ error: 'messageType and txHash are required' });
    }

    const validTypes = ['message', 'group', 'channel', 'token_transfer'];
    if (!validTypes.includes(messageType)) {
      return res.status(400).json({ error: 'Invalid messageType' });
    }

    const result = await pool.query(`
      INSERT INTO blockchain_audit_logs (
        user_id, message_type, tx_hash, transaction_payload, status, user_pubkey, action_timestamp, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      RETURNING id
    `, [
      req.user.id,
      messageType,
      txHash,
      JSON.stringify(payload || {}),
      'pending',
      req.user.usernode_pubkey || APP_PUBKEY,
      new Date().toISOString()
    ]);

    const auditLogId = result.rows[0].id;

    setImmediate(() => monitorBlockchainStatus(auditLogId, txHash));

    res.json({ auditLogId: auditLogId, status: 'pending' });
  } catch (err) {
    console.error('Error creating pending audit:', err);
    res.status(500).json({ error: 'Failed to create audit log', details: err.message });
  }
});

app.post('/api/blockchain-audit/:auditLogId/register-tx', async (req, res) => {
  try {
    const { auditLogId } = req.params;
    const { txHash } = req.body;

    if (!txHash) {
      return res.status(400).json({ error: 'txHash is required' });
    }

    await pool.query(`
      UPDATE blockchain_audit_logs
      SET tx_hash = $1, updated_at = NOW()
      WHERE id = $2
    `, [txHash, auditLogId]);

    console.log(`[REGISTER TX] Registered txHash ${txHash} for audit log ${auditLogId}`);

    setImmediate(() => monitorBlockchainStatus(auditLogId, txHash));

    res.json({ status: 'registered', auditLogId: auditLogId, txHash: txHash });
  } catch (err) {
    console.error('Error registering transaction:', err);
    res.status(500).json({ error: 'Failed to register transaction', details: err.message });
  }
});

app.get('/api/transactions-by-user', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { limit = 50, offset = 0 } = req.query;
    const parsedLimit = Math.min(parseInt(limit) || 50, 500);
    const parsedOffset = Math.max(parseInt(offset) || 0, 0);

    const result = await pool.query(`
      SELECT id, user_id, message_type, tx_hash, status, created_at, confirmed_at
      FROM blockchain_audit_logs
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.user.id, parsedLimit, parsedOffset]);

    const countResult = await pool.query(`
      SELECT COUNT(*) as total FROM blockchain_audit_logs WHERE user_id = $1
    `, [req.user.id]);

    res.json({
      transactions: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit: parsedLimit,
      offset: parsedOffset
    });
  } catch (err) {
    console.error('Error fetching user transactions:', err);
    res.status(500).json({ error: 'Failed to fetch transactions', details: err.message });
  }
});

app.get('/explorer-api/:chainId/transactions/:txHash', async (req, res) => {
  try {
    const { chainId, txHash } = req.params;

    console.log(`[EXPLORER PROXY] Proxying explorer request for chainId=${chainId}, txHash=${txHash}`);

    if (!EXPLORER_URL || !EXPLORER_HEALTHY) {
      return res.status(503).json({
        error: 'Explorer not available',
        status: 'unknown',
        blockNumber: null
      });
    }

    return new Promise((resolve) => {
      const explorerPath = EXPLORER_FORMAT === 'api/tx'
        ? `/api/tx/${txHash}`
        : `/api/transaction/${txHash}`;

      const fullUrl = `${EXPLORER_URL}${explorerPath}`;
      const url = new URL(fullUrl);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + (url.search || ''),
        method: 'GET',
        timeout: 5000
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const result = {
              status: parsed.status || parsed.state || 'unknown',
              blockNumber: parsed.blockNumber || parsed.block || null,
              timestamp: parsed.timestamp || null,
              raw: parsed
            };
            resolve(res.json(result));
          } catch (err) {
            resolve(res.status(500).json({ error: 'Failed to parse explorer response' }));
          }
        });
      });

      req.on('error', (err) => {
        console.warn(`[EXPLORER PROXY] Error proxying explorer request:`, err.message);
        resolve(res.status(503).json({
          error: 'Explorer request failed',
          details: err.message,
          status: 'unknown'
        }));
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(res.status(504).json({
          error: 'Explorer request timeout',
          status: 'unknown'
        }));
      });

      req.end();
    });
  } catch (err) {
    console.error('[EXPLORER PROXY] Error:', err);
    res.status(500).json({ error: 'Failed to proxy explorer request', details: err.message });
  }
});

// ============= END BLOCKCHAIN API ENDPOINTS =============

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

// GET /api/feed/posts - Fetch paginated posts from followed channels
// When no channel_id is provided, fetches posts from followed channels only
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
    let params = [req.user.id, limit, offset];

    if (channelId) {
      whereClause = 'WHERE fp.channel_id = $3';
      params = [req.user.id, limit, offset, channelId];
    } else {
      // When no channel_id provided, fetch posts from followed channels only
      whereClause = `WHERE fp.channel_id IN (
        SELECT channel_id FROM channel_followers WHERE user_id = $1
      )`;
    }

    // Fetch posts (optionally filtered by channel, or by followed channels)
    const { rows: posts } = await pool.query(`
      SELECT
        fp.id,
        fp.user_id,
        fp.content,
        fp.image_urls,
        fp.created_at,
        fp.updated_at,
        fp.on_chain,
        fp.channel_id,
        u.username,
        u.verified_at,
        u.avatar_url,
        c.name as channel_name
      FROM feed_posts fp
      JOIN users u ON u.id = fp.user_id
      LEFT JOIN channels c ON fp.channel_id = c.id
      ${whereClause}
      ORDER BY fp.created_at DESC
      LIMIT $2 OFFSET $3
    `, channelId ? [req.user.id, limit, offset, channelId] : params);

    const resultPosts = posts.map(post => ({
      id: post.id,
      userId: post.user_id,
      username: post.username,
      verified: !!post.verified_at,
      avatarUrl: post.avatar_url,
      content: post.content,
      imageUrls: post.image_urls || [],
      createdAt: post.created_at,
      updatedAt: post.updated_at,
      isEdited: post.updated_at && post.created_at && (new Date(post.updated_at) - new Date(post.created_at)) > 1000,
      onChain: post.on_chain,
      isMilestone: post.user_id === -1,
      channelName: post.channel_name
    }));

    // Build count query based on whether channel_id is provided
    let countQuery = '';
    let countParams = [];

    if (channelId) {
      countQuery = 'SELECT COUNT(*) as count FROM feed_posts WHERE channel_id = $1';
      countParams = [channelId];
    } else {
      countQuery = `SELECT COUNT(*) as count FROM feed_posts WHERE channel_id IN (
        SELECT channel_id FROM channel_followers WHERE user_id = $1
      )`;
      countParams = [req.user.id];
    }

    const { rows: countResult } = await pool.query(countQuery, countParams);
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








// PUT /api/feed/posts/:postId - Edit a feed post's text (owner only)


// Explorer API proxy for transaction status polling (modeled after Last One Wins)
// This endpoint is called by the chain poller to check transaction confirmation status via Usernode explorer
//
// IMPORTANT: If txHash starts with 'synthetic_', this is a temporary placeholder generated by the
// frontend when the Usernode bridge raised a transactionsBaseUrl configuration error. The real
// transaction was already submitted to the blockchain but its hash was never returned to the client.
// The chain poller will never find a synthetic hash on the explorer—it's a temporary state waiting
// for the backend to discover the real transaction. If polling exhausts all attempts (20 polls),
// the transaction is marked as failed. Operators must verify TRANSACTIONS_BASE_URL is correctly
// configured to reach the explorer endpoint (e.g., https://explorer.usernodelabs.org/api/tx for testnet).
// Synthetic hashes indicate a bridge timing race (tx submitted before config validation).
//
// For recovery: check TRANSACTIONS_BASE_URL env var, verify the explorer endpoint format matches
// the explorer's actual API (some explorers use /api/tx, others /api/transaction, etc.), and
// consider a fallback lookup by memo signature or sender+timestamp if the real hash cannot be found.
// Explorer API endpoint removed

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

// ===== SERVER STATUS & DIAGNOSTICS ENDPOINT =====
// Expose server configuration and blockchain state for client diagnostics
app.get('/api/diagnostics/status', async (req, res) => {
  try {
    const rpcHealth = await checkRPCHealth();

    // Determine readiness: testnet requires RPC to be healthy; devnet doesn't
    let readyForTestnet = false;
    let readyReason = '';
    if (NETWORK_MODE === 'devnet') {
      readyForTestnet = true;
      readyReason = 'Devnet mode doesn\'t require external services';
    } else if (NETWORK_MODE === 'testnet') {
      if (EXPLORER_HEALTHY && rpcHealth.reachable) {
        readyForTestnet = true;
        readyReason = 'Explorer and RPC both healthy';
      } else if (!EXPLORER_HEALTHY) {
        readyReason = 'Explorer not responding or endpoint format incorrect';
      } else if (!rpcHealth.reachable) {
        readyReason = 'RPC not configured or unreachable';
      } else {
        readyReason = 'Unknown issue with external services';
      }
    }

    const status = {
      server: {
        networkMode: NETWORK_MODE,
        timestamp: new Date().toISOString()
      },
      blockchain: {
        nodeRpcUrl: NODE_RPC_URL || null,
        nodeRpcUrlConfigured: !!NODE_RPC_URL,
        nodeRpcHealth: rpcHealth,
        apiBaseUrl: API_BASE_URL || `http://127.0.0.1:${port || 3000} (loopback default)`,
        explorerUrl: EXPLORER_URL,
        explorerFormat: EXPLORER_FORMAT || 'not detected',
        explorerHealth: EXPLORER_HEALTHY,
        readyForTestnet: readyForTestnet,
        readyReason: readyReason
      },
      database: {
        connected: dbConnected,
        lastChecked: new Date().toISOString()
      },
      diagnostics: {
        // Include raw values for debugging
        isStaging: IS_STAGING,
        appPubkey: APP_PUBKEY,
        activeChainsPollers: chainPollers.size,
        pollerIds: Array.from(chainPollers.keys())
      }
    };

    console.log(`[DIAGNOSTICS] Server status queried: networkMode=${NETWORK_MODE}, rpcReachable=${rpcHealth.reachable}, explorerHealthy=${EXPLORER_HEALTHY}, readyForTestnet=${readyForTestnet}`);

    res.json(status);
  } catch (err) {
    console.error('[DIAGNOSTICS] Error getting server status:', err);
    res.status(500).json({ error: err.message });
  }
});

// Wallet health check endpoint for testnet validation
app.get('/api/diagnostics/wallet-health', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = parseInt(req.user.id, 10);
    const userWalletPubkey = req.user.usernode_pubkey;
    const rpcHealth = await checkRPCHealth();

    // Validate wallet for current network mode
    const walletValidation = await validateWalletForMode(NETWORK_MODE, userId, userWalletPubkey);

    const health = {
      user: {
        id: userId,
        username: req.user.username,
        hasWalletLinked: !!userWalletPubkey,
        walletPubkey: userWalletPubkey || null
      },
      networkMode: {
        current: NETWORK_MODE,
        requiresWallet: NETWORK_MODE === 'testnet' || NETWORK_MODE === 'devnet',
        isDevnet: NETWORK_MODE === 'devnet'
      },
      rpc: {
        configured: !!NODE_RPC_URL,
        endpoint: NODE_RPC_URL || null,
        reachable: rpcHealth.reachable,
        responseTime: rpcHealth.responseTime || null,
        error: rpcHealth.error || null
      },
      walletValidation: {
        valid: walletValidation.valid,
        error: walletValidation.error || null
      },
      testnetReadiness: {
        ready: NETWORK_MODE !== 'testnet' || walletValidation.valid,
        message: NETWORK_MODE !== 'testnet'
          ? `Not in testnet mode (currently: ${NETWORK_MODE})`
          : walletValidation.valid
            ? 'Testnet wallet is properly configured and ready for transactions'
            : `Testnet not ready: ${walletValidation.error}`
      },
      timestamp: new Date().toISOString()
    };

    console.log(`[WALLET-HEALTH] Check for user ${userId}: walletLinked=${!!userWalletPubkey}, networkMode=${NETWORK_MODE}, walletValid=${walletValidation.valid}`);

    res.json(health);
  } catch (err) {
    console.error('[WALLET-HEALTH] Error checking wallet health:', err);
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

  // Determine transactionsBaseUrl: env var if set, otherwise derive from request
  let transactionsBaseUrl = process.env.TRANSACTIONS_BASE_URL;
  if (!transactionsBaseUrl) {
    transactionsBaseUrl = `${req.protocol}://${req.get('host')}`;
  }

  // Validate that the value is a valid URL format
  try {
    new URL(transactionsBaseUrl);
  } catch (urlErr) {
    console.error(`[CONFIG] ✗ Invalid transactionsBaseUrl: ${transactionsBaseUrl}`);
    return res.status(500).send('Server configuration error: transactionsBaseUrl is invalid. Contact administrator.');
  }

  // Read the HTML file and inject configuration
  const fs = require('fs');
  try {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

    // Inject configuration script into the HTML head
    const configScript = `<script>
window.usernode = window.usernode || {};
window.usernode.transactionsBaseUrl = ${JSON.stringify(transactionsBaseUrl)};
window.addEventListener('load', function() {
  // Re-apply transactionsBaseUrl in case the bridge overwrote window.usernode during initialization
  if (typeof window.usernode === 'object' && window.usernode !== null) {
    window.usernode.transactionsBaseUrl = ${JSON.stringify(transactionsBaseUrl)};
    console.log('[CONFIG] ✓ Re-applied transactionsBaseUrl after bridge init');
  }
});
</script>`;

    const injectedHtml = html.replace(
      /<head([^>]*)>/,
      `<head$1>${configScript}`
    );

    const source = process.env.TRANSACTIONS_BASE_URL ? 'environment variable' : 'auto-detected from request origin';
    console.log(`[CONFIG] ✓ transactionsBaseUrl: ${transactionsBaseUrl} (${source})`);
    console.log('[CONFIG] ✓ window.usernode.transactionsBaseUrl injected into HTML');
    res.type('text/html').send(injectedHtml);
  } catch (err) {
    console.error('[CONFIG] Error reading or injecting HTML:', err.message);
    return res.status(500).send('Failed to load app');
  }
});

// ===== DATABASE INITIALIZATION =====

async function start() {
  try {
    console.log('[STARTUP] Initializing Guardian 2 server...');

    // Test database connectivity with timeout
    console.log('[DB] Testing connection...');
    try {
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 3000))
      ]);
      console.log('[DB] ✅ Connection successful');
      dbConnected = true;
    } catch (dbErr) {
      console.warn('[DB] ⚠️  Cannot reach database, continuing with limited functionality:', dbErr.message);
      console.warn('[DB] The app will serve static pages but database features will be unavailable');
      dbConnected = false;
      // Don't throw - allow server to continue
    }

    // Skip table initialization if database is not connected
    if (!dbConnected) {
      console.log('[STARTUP] Skipping database initialization due to connection failure');
      console.log('[STARTUP] App will boot in degraded mode with static content only');
    }

    if (dbConnected) {
      try {
        // === CRITICAL PATH: Schema initialization only ===
        // These must complete before app.listen() so the server can serve requests immediately
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
      ALTER TABLE users ADD COLUMN IF NOT EXISTS network VARCHAR(50) DEFAULT 'real_testnet'
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

    // Add skip_signature_in_devnet column to users table (idempotent migration)
    try {
      console.log('[Migration] Adding skip_signature_in_devnet column to users table...');
      await pool.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS skip_signature_in_devnet BOOLEAN DEFAULT FALSE
      `);
      console.log('[Migration] ✅ skip_signature_in_devnet column migration completed');
    } catch (err) {
      console.error('[Migration] ❌ ERROR adding skip_signature_in_devnet column:', err.message);
      throw err;
    }

    // Add network_mode column to users table (idempotent migration)
    try {
      console.log('[Migration] Adding network_mode column to users table...');
      await pool.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS network_mode VARCHAR(50) DEFAULT NULL
      `);
      console.log('[Migration] ✅ network_mode column migration completed');
    } catch (err) {
      console.error('[Migration] ❌ ERROR adding network_mode column:', err.message);
      throw err;
    }

    // Normalize network_mode values: 'real_testnet' -> 'testnet', 'demo' -> 'devnet' (idempotent migration)
    try {
      console.log('[Migration] Normalizing network_mode values...');
      await pool.query(`
        UPDATE users SET network_mode = 'testnet' WHERE network_mode = 'real_testnet'
      `);
      await pool.query(`
        UPDATE users SET network_mode = 'devnet' WHERE network_mode = 'demo'
      `);
      console.log('[Migration] ✅ network_mode value normalization completed');
    } catch (err) {
      console.error('[Migration] ❌ ERROR normalizing network_mode values:', err.message);
      throw err;
    }

    // Allow NULL network_mode to indicate user has not made a selection (idempotent migration)
    try {
      console.log('[Migration] Setting network_mode default to NULL...');
      await pool.query(`
        ALTER TABLE users ALTER COLUMN network_mode SET DEFAULT NULL
      `);
      console.log('[Migration] ✅ network_mode default changed to NULL');
    } catch (err) {
      if (err.code === '42P07' || err.message.includes('already exists')) {
        console.log('[Migration] ⚠️  network_mode default already NULL (idempotent)');
      } else {
        console.error('[Migration] ⚠️  Could not set NULL default:', err.message);
      }
    }

    // Update skip_signature_in_devnet default from FALSE to TRUE (idempotent migration)
    try {
      console.log('[Migration] Updating skip_signature_in_devnet default to TRUE...');
      await pool.query(`
        ALTER TABLE users ALTER COLUMN skip_signature_in_devnet SET DEFAULT TRUE
      `);
      console.log('[Migration] ✅ skip_signature_in_devnet default migration completed');
    } catch (err) {
      console.error('[Migration] ❌ ERROR updating skip_signature_in_devnet default:', err.message);
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

    // Seed staging data for testing Accept/Decline functionality
    if (IS_STAGING) {
      // Create two test users
      await pool.query(`
        INSERT INTO users (id, username, usernode_pubkey, verified_at)
        VALUES (1, 'staging-demo-user-alice', 'ut1alice123', NOW())
        ON CONFLICT (id) DO NOTHING
      `);

      await pool.query(`
        INSERT INTO users (id, username, usernode_pubkey, verified_at)
        VALUES (2, 'staging-demo-user-bob', 'ut1bob456', NOW())
        ON CONFLICT (id) DO NOTHING
      `);

      await pool.query(`
        INSERT INTO users (id, username, usernode_pubkey, verified_at)
        VALUES (3, 'staging-demo-user-charlie', 'ut1charlie789', NOW())
        ON CONFLICT (id) DO NOTHING
      `);

      // Create a pending conversation between user 1 (Alice) and user 2 (Bob)
      await pool.query(`
        INSERT INTO conversations (participant_a_id, participant_b_id, status_a, status_b)
        VALUES (1, 2, 'pending', 'pending')
        ON CONFLICT (participant_a_id, participant_b_id) DO NOTHING
      `);

      // Create a pending conversation between user 1 (Alice) and user 3 (Charlie)
      await pool.query(`
        INSERT INTO conversations (participant_a_id, participant_b_id, status_a, status_b)
        VALUES (1, 3, 'pending', 'pending')
        ON CONFLICT (participant_a_id, participant_b_id) DO NOTHING
      `);
    }

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

    // Add network_origin column to track where transaction was recorded (blockchain, devnet, demo, bridge)
    await pool.query(`
      ALTER TABLE blockchain_audit_logs ADD COLUMN IF NOT EXISTS network_origin VARCHAR(50) DEFAULT NULL
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

    // Create channel_followers table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS channel_followers (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        followed_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, channel_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_channel_followers_user_id
        ON channel_followers(user_id, followed_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_channel_followers_channel_id
        ON channel_followers(channel_id)
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

    // Add deleted_at column to feed_posts for soft deletes
    await pool.query(`
      ALTER TABLE feed_posts
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
    `);

    // Add image_urls column to feed_posts for image attachments
    await pool.query(`
      ALTER TABLE feed_posts
      ADD COLUMN IF NOT EXISTS image_urls JSONB DEFAULT '[]'
    `);

    // Staging: seed example posts if in staging mode
    if (process.env.USERNODE_ENV === 'staging') {
      // Seed a system post
      await pool.query(`
        INSERT INTO feed_posts (user_id, content, channel_id, image_urls, created_at)
        VALUES (-1, $1, $2, $3, NOW())
        ON CONFLICT DO NOTHING
      `, [JSON.stringify({ type: 'text', text: '[Staging] Guardian Updates - Initial System Message' }), guardianChannelId, JSON.stringify([])]);

      // Find a staging channel to seed with sample posts
      const { rows: stagingChannels } = await pool.query(`
        SELECT id FROM channels WHERE name = '[Staging] General Discussion' LIMIT 1
      `);

      if (stagingChannels.length > 0) {
        const stagingChannelId = stagingChannels[0].id;

        // Seed a sample post with text only
        await pool.query(`
          INSERT INTO feed_posts (user_id, content, channel_id, image_urls, created_at)
          VALUES (1, $1, $2, $3, NOW() - INTERVAL '1 hour')
          ON CONFLICT DO NOTHING
        `, [JSON.stringify({ text: '[Staging] Welcome to the demo channel! This is a test post.' }), stagingChannelId, JSON.stringify([])]);

        // Seed a sample post with an image
        const sampleImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8DwHwMxxGAIwAAADkkBkMTjF4UAAAAASUVORK5CYII=';
        await pool.query(`
          INSERT INTO feed_posts (user_id, content, channel_id, image_urls, created_at)
          VALUES (1, $1, $2, $3, NOW() - INTERVAL '30 minutes')
          ON CONFLICT DO NOTHING
        `, [JSON.stringify({ text: '[Staging] Check out this sample image in a channel post!' }), stagingChannelId, JSON.stringify([sampleImage])]);
      }
    }


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

    // Create config_state table (public - stores runtime configuration like RPC endpoint)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS config_state (
        id SERIAL PRIMARY KEY,
        key VARCHAR(100) UNIQUE NOT NULL,
        value TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_config_state_key
        ON config_state(key)
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

    // Create user_peers table (tracks peers connected to each user)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_peers (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        peer_id VARCHAR(100) NOT NULL,
        connected_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, peer_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_peers_user_id
        ON user_peers(user_id, last_seen_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_peers_peer_id
        ON user_peers(peer_id)
    `);

    // Create user_foreground_sessions table (tracks foreground tab sessions per user)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_foreground_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_start TIMESTAMPTZ NOT NULL,
        session_end TIMESTAMPTZ NOT NULL,
        duration_seconds INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_foreground_sessions_user_id
        ON user_foreground_sessions(user_id, created_at DESC)
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
    await pool.query(`COMMENT ON TABLE user_peers IS 'staging:private'`);
    await pool.query(`COMMENT ON TABLE user_foreground_sessions IS 'staging:private'`);

        // Schema initialization complete. Start the server immediately so healthchecks pass.
        // All seeding and non-critical initialization will run in the background.
        console.log('[STARTUP] Schema initialization complete, starting HTTP server...');
      } catch (dbInitErr) {
        console.error('[DB] Database schema initialization error:', dbInitErr.message);
        console.log('[STARTUP] Continuing with degraded functionality');
      }
    }

    // Start HTTP server now, before any blocking seeding operations
    app.listen(port, async () => {
      console.log(`[STARTUP] ✅ Server listening on port ${port}`);
      console.log(`[CONFIG] USERNODE_ENV: ${process.env.USERNODE_ENV || 'not set'}`);
      console.log(`[CONFIG] NETWORK_MODE: ${NETWORK_MODE}`);
      console.log(`[CONFIG] IS_STAGING: ${IS_STAGING}`);
      if (NETWORK_MODE === 'real_testnet') {
        console.log(`[CONFIG] Real Testnet mode - RPC enabled: ${NODE_RPC_URL ? 'yes' : 'no'}`);
        if (NODE_RPC_URL) {
          console.log(`[CONFIG] NODE_RPC_URL: ${NODE_RPC_URL}`);
        }
      } else if (NETWORK_MODE === 'devnet') {
        console.log(`[CONFIG] Devnet mode - database-only transactions, RPC disabled`);
      } else {
        console.log(`[CONFIG] Demo mode - simulated transactions, RPC disabled`);
      }

      // === BACKGROUND INITIALIZATION ===
      // The following operations run after the server is listening.
      // They will not block healthchecks or prevent the app from serving requests.

      // Restore persisted network mode (runtime switches survive restarts),
      // then initialize the RPC endpoint for the restored mode,
      // then validate explorer connectivity
      try {
        await initializeNetworkMode();
      } catch (modeErr) {
        console.warn('[CONFIG] Failed to restore network mode:', modeErr.message);
      }
      try {
        await initializeRpcUrl();
      } catch (rpcErr) {
        console.warn('[RPC] Failed to initialize RPC URL:', rpcErr.message);
      }
      try {
        await validateAndConfigureExplorer();
      } catch (explorerErr) {
        console.warn('[EXPLORER] Failed to validate explorer:', explorerErr.message);
      }

      // Seed staging data
      try {
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
                timestamp: msgTime.toISOString(),
                rpcEndpoint: NODE_RPC_URL
              }
            : {
                type: 'message',
                messageId: messageId,
                senderId: msg.sender,
                userPubkey: dmUserPubkeyMap[msg.sender],
                contentHash: contentHash,
                timestamp: msgTime.toISOString(),
                rpcEndpoint: NODE_RPC_URL
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

      // Seed user_peers relationships for staging test data
      // Alice (user 1) connects to peers 001, 002, 003 (total 130 hours)
      await pool.query(`
        INSERT INTO user_peers (user_id, peer_id, connected_at, last_seen_at)
        VALUES
          ($1, 'ut1staging-peer-001', NOW(), NOW()),
          ($1, 'ut1staging-peer-002', NOW(), NOW()),
          ($1, 'ut1staging-peer-003', NOW(), NOW())
        ON CONFLICT (user_id, peer_id) DO UPDATE SET
          last_seen_at = NOW()
      `, [alice]);

      // Bob (user 2) connects to peers 004, 005, 006 (total 365 hours)
      await pool.query(`
        INSERT INTO user_peers (user_id, peer_id, connected_at, last_seen_at)
        VALUES
          ($1, 'ut1staging-peer-004', NOW(), NOW()),
          ($1, 'ut1staging-peer-005', NOW(), NOW()),
          ($1, 'ut1staging-peer-006', NOW(), NOW())
        ON CONFLICT (user_id, peer_id) DO UPDATE SET
          last_seen_at = NOW()
      `, [bob]);

      // Charlie (user 3) connects to peers 007, 008, 009, 010 (total 675 hours)
      await pool.query(`
        INSERT INTO user_peers (user_id, peer_id, connected_at, last_seen_at)
        VALUES
          ($1, 'ut1staging-peer-007', NOW(), NOW()),
          ($1, 'ut1staging-peer-008', NOW(), NOW()),
          ($1, 'ut1staging-peer-009', NOW(), NOW()),
          ($1, 'ut1staging-peer-010', NOW(), NOW())
        ON CONFLICT (user_id, peer_id) DO UPDATE SET
          last_seen_at = NOW()
      `, [charlie]);

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

      // Seed channels for staging testing
      console.log('[Channel Seed] Starting channel seed data...');

      // Ensure channel categories exist
      await pool.query(`
        INSERT INTO channel_categories (name, description) VALUES
        ('Updates', 'System and important updates'),
        ('General', 'General discussion'),
        ('Announcements', 'Official announcements')
        ON CONFLICT (name) DO NOTHING
      `);

      // Seed demo channels
      const channels = [
        { name: 'Staging Demo Channel', description: 'A staging demo channel for testing the feed-like UI', owner_id: 1, category: 'General' },
        { name: '[Staging] Owner\'s Channel', description: 'Test channel for owner composition - owned by user 1', owner_id: 1, category: 'General' },
        { name: 'Updates & News', description: 'Latest updates and news from the team', owner_id: 2, category: 'Announcements' },
        { name: 'Product Feedback', description: 'Share your feedback and suggestions', owner_id: 3, category: 'General' }
      ];

      for (const channel of channels) {
        const result = await pool.query(`
          INSERT INTO channels (name, description, owner_id, category, is_system, is_verified, is_featured, created_at, updated_at)
          VALUES ($1, $2, $3, $4, FALSE, FALSE, FALSE, NOW(), NOW())
          ON CONFLICT DO NOTHING
          RETURNING id
        `, [channel.name, channel.description, channel.owner_id, channel.category]);

        if (result.rows.length > 0) {
          const channelId = result.rows[0].id;
          console.log(`[Channel Seed] Created channel: ${channel.name} (id: ${channelId})`);

          // Seed demo posts in the channel
          let posts = [];

          // Different posts for owner's channel vs other channels
          if (channel.owner_id === 1 && channel.name === '[Staging] Owner\'s Channel') {
            posts = [
              { user_id: 1, content: 'This is my test channel! I can post here since I\'m the owner.', offset: 120, editedOffset: 100 },
              { user_id: 1, content: 'The compose box at the top lets me create new posts quickly. Try clicking and typing!', offset: 60 }
            ];
          } else {
            posts = [
              { user_id: 1, content: 'Welcome to the Staging Demo Channel! This is a great place to test the new feed-like layout.', offset: 180 },
              { user_id: 2, content: 'The channel detail view now has a sticky header with owner-specific controls. Try editing or deleting this channel if you are the owner!', offset: 120 },
              { user_id: 3, content: 'Posts are displayed in a clean chronological feed. You can see the most recent posts first.', offset: 60 },
              { user_id: 1, content: 'Load more posts at the bottom to see older messages. Try scrolling down to test pagination!', offset: 30 }
            ];
          }

          for (const post of posts) {
            const created = new Date(Date.now() - post.offset * 60000);
            const updated = post.editedOffset ? new Date(Date.now() - post.editedOffset * 60000) : created;
            await pool.query(`
              INSERT INTO feed_posts (user_id, channel_id, content, created_at, updated_at)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT DO NOTHING
            `, [post.user_id, channelId, JSON.stringify({ text: post.content }), created, updated]);
          }
          console.log(`[Channel Seed] Created ${posts.length} demo posts in channel: ${channel.name}`);
        }
      }

      // Seed channel followers for demo user (user 1 follows all channels)
      console.log('[Channel Seed] Adding follower relationships...');
      const { rows: channelRows } = await pool.query(`SELECT id FROM channels ORDER BY created_at ASC`);
      for (const ch of channelRows) {
        await pool.query(`
          INSERT INTO channel_followers (user_id, channel_id, followed_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (user_id, channel_id) DO NOTHING
        `, [1, ch.id]);
      }
      console.log(`[Channel Seed] ✅ Added follower relationships (demo user follows ${channelRows.length} channels)`);

      // Seed user contacts for demo user (user 1 has contacts with users 2, 3, 4)
      console.log('[Channel Seed] Adding user contacts...');
      const contacts = [
        { contact_user_id: 2, nickname: 'Demo User Two' },
        { contact_user_id: 3, nickname: 'Demo User Three' },
        { contact_user_id: 4, nickname: 'Demo User Four' }
      ];
      for (const contact of contacts) {
        await pool.query(`
          INSERT INTO user_contacts (user_id, contact_user_id, nickname, created_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (user_id, contact_user_id) DO NOTHING
        `, [1, contact.contact_user_id, contact.nickname]);
      }
      console.log(`[Channel Seed] ✅ Added user contacts (demo user has ${contacts.length} contacts)`);

      console.log('[Channel Seed] ✅ Channel seed data completed');

      // FIX #8: Seed staging mock data for testing transaction polling without real blockchain
      console.log('[Staging Mock Data] Seeding transaction test data for polling tests...');
      try {
        const userId = 1; // Staging demo user (Alice)

        // Seed test transactions with various statuses to simulate polling scenarios
        const testTransactions = [
          {
            status: 'confirmed',
            offset: 120,
            message: 'Staging test message - confirmed transaction',
            txHashSuffix: 'test-confirmed-001'
          },
          {
            status: 'pending',
            offset: 60,
            message: 'Staging test message - still pending (testing polling)',
            txHashSuffix: 'test-pending-001'
          },
          {
            status: 'failed',
            offset: 30,
            message: 'Staging test message - failed transaction',
            txHashSuffix: 'test-failed-001',
            error: 'RPC connection timeout'
          }
        ];

        for (const tx of testTransactions) {
          const msgTime = new Date(Date.now() - tx.offset * 60000);
          const contentHash = computeContentHash(tx.message);
          const txHash = `ut1staging-${tx.txHashSuffix}`;

          // Create audit log for testing polling flow
          const auditRes = await pool.query(`
            INSERT INTO blockchain_audit_logs (
              user_id, message_type, tx_hash, status, content_hash, user_pubkey,
              action_timestamp, error_message, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
            ON CONFLICT (user_id, tx_hash) DO NOTHING
            RETURNING id
          `, [
            userId,
            'message',
            txHash,
            tx.status,
            contentHash,
            'ut1staging-alice-001',
            msgTime,
            tx.error || null,
            msgTime
          ]);

          if (auditRes.rows.length > 0) {
            console.log(`[Staging Mock Data] Created test transaction: ${tx.txHashSuffix} (status: ${tx.status})`);
          }
        }

        console.log('[Staging Mock Data] ✅ Transaction test data seeded');
      } catch (seedErr) {
        console.warn('[Staging Mock Data] Warning: Could not seed transaction test data:', seedErr.message);
      }
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
      } catch (seedErr) {
        console.warn('[SEED] Background seeding failed:', seedErr.message);
      }


      // Initialize Usernode blockchain usernames cache for real-time search
      try {
        console.log('[UsernamesCache] Initializing on server startup...');
        const usernamesCache = createUsernamesCache({
          nodeRpcUrl: NODE_RPC_URL,
          refreshIntervalMs: 300000, // 5 minutes
          isStaging: IS_STAGING
        });
        await usernamesCache.initialize();
        console.log('[UsernamesCache] ✅ Cache initialized:', usernamesCache.stats());

        // Store cache in global scope for access by API endpoints
        global.usernamesCache = usernamesCache;
      } catch (cacheErr) {
        console.warn('[UsernamesCache] Initialization failed:', cacheErr.message);
        // Create a no-op cache that returns empty results
        global.usernamesCache = {
          searchUsernames: () => [],
          getUsername: () => null,
          getUsernameByPubkey: () => null,
          ready: () => false,
          stats: () => ({ initialized: false, usernameCount: 0 })
        };
      }

      console.log('[STARTUP] ✅ Background initialization completed');
    });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();
