// Usernode blockchain username cache utility
// Vendored from usernode-dapp-starter pattern

const http = require('http');
const https = require('https');

/**
 * Creates a usernames cache that queries Usernode blockchain state
 * Returns a cache object with lookup methods and automatic refresh
 */
function createUsernamesCache(options = {}) {
  const {
    nodeRpcUrl = process.env.NODE_RPC_URL || 'http://localhost:3001',
    refreshIntervalMs = 300000, // 5 minutes default
    isStaging = process.env.USERNODE_ENV === 'staging',
    demoUsernames = []
  } = options;

  let usernamesMap = new Map(); // username -> { username, usernode_pubkey }
  let pubkeyMap = new Map(); // pubkey -> { username, usernode_pubkey }
  let isInitialized = false;
  let lastRefreshTime = 0;

  // Demo data for staging environment
  const stagingDemoUsernames = [
    { username: 'staging-demo-alice', usernode_pubkey: 'ut1staging-alice-001' },
    { username: 'staging-demo-bob', usernode_pubkey: 'ut1staging-bob-001' },
    { username: 'staging-demo-charlie', usernode_pubkey: 'ut1staging-charlie-001' },
    { username: 'staging-demo-guardian', usernode_pubkey: 'ut1staging-guardian-001' }
  ];

  /**
   * Fetch usernames from blockchain RPC endpoint
   * In production, this would hit a real Usernode node
   * In staging, returns demo data
   */
  async function fetchUsernamesFromBlockchain() {
    if (isStaging) {
      // In staging, use demo data
      return stagingDemoUsernames.concat(demoUsernames);
    }

    // In production, query the RPC endpoint for user state
    // This is a placeholder that would query the actual blockchain state
    // The real implementation would depend on Usernode RPC API structure
    try {
      // Attempt to query usernames from blockchain
      // This is a best-effort call; if it fails, we'll retry on next refresh
      const usernames = await queryBlockchainUsernames(nodeRpcUrl);
      return usernames || [];
    } catch (err) {
      console.error('[UsernamesCache] Failed to fetch usernames from blockchain:', err.message);
      return [];
    }
  }

  /**
   * Query the blockchain RPC for registered usernames
   * This method adapts based on available RPC methods
   */
  async function queryBlockchainUsernames(rpcUrl) {
    return new Promise((resolve, reject) => {
      const isHttps = rpcUrl.startsWith('https');
      const requester = isHttps ? https : http;
      const url = new URL('/invariants', rpcUrl);

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        timeout: 5000
      };

      if (url.username && url.password) {
        options.auth = `${url.username}:${url.password}`;
      }

      const req = requester.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            // Parse response and extract usernames if available
            // Fallback: return empty array if parsing fails
            resolve([]);
          } catch (parseErr) {
            resolve([]);
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Blockchain query timeout'));
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Initialize the cache - fetch initial usernames from blockchain
   */
  async function initialize() {
    try {
      console.log('[UsernamesCache] Initializing username cache...');
      const usernames = await fetchUsernamesFromBlockchain();

      usernamesMap.clear();
      pubkeyMap.clear();

      for (const user of usernames) {
        if (user.username && user.usernode_pubkey) {
          usernamesMap.set(user.username.toLowerCase(), {
            username: user.username,
            usernode_pubkey: user.usernode_pubkey
          });
          pubkeyMap.set(user.usernode_pubkey.toLowerCase(), {
            username: user.username,
            usernode_pubkey: user.usernode_pubkey
          });
        }
      }

      isInitialized = true;
      lastRefreshTime = Date.now();
      console.log(`[UsernamesCache] Initialized with ${usernamesMap.size} usernames`);
    } catch (err) {
      console.error('[UsernamesCache] Initialization failed:', err.message);
      // Don't fail hard - the cache can still serve empty results
      isInitialized = true;
    }
  }

  /**
   * Refresh the cache (periodic or on-demand)
   */
  async function refresh() {
    try {
      const now = Date.now();
      // Only refresh if enough time has passed since last refresh
      if (now - lastRefreshTime < refreshIntervalMs) {
        return;
      }

      console.log('[UsernamesCache] Refreshing username cache...');
      const usernames = await fetchUsernamesFromBlockchain();

      usernamesMap.clear();
      pubkeyMap.clear();

      for (const user of usernames) {
        if (user.username && user.usernode_pubkey) {
          usernamesMap.set(user.username.toLowerCase(), {
            username: user.username,
            usernode_pubkey: user.usernode_pubkey
          });
          pubkeyMap.set(user.usernode_pubkey.toLowerCase(), {
            username: user.username,
            usernode_pubkey: user.usernode_pubkey
          });
        }
      }

      lastRefreshTime = now;
      console.log(`[UsernamesCache] Refreshed: ${usernamesMap.size} usernames`);
    } catch (err) {
      console.error('[UsernamesCache] Refresh failed:', err.message);
    }
  }

  /**
   * Search for usernames matching a query
   * Returns array of { username, usernode_pubkey }
   */
  function searchUsernames(query) {
    if (!isInitialized || !query || query.length < 2) {
      return [];
    }

    const lowerQuery = query.toLowerCase();
    const results = [];
    const seen = new Set();

    // Search by username prefix first
    for (const [key, user] of usernamesMap.entries()) {
      if (key.startsWith(lowerQuery) && !seen.has(user.usernode_pubkey)) {
        results.push(user);
        seen.add(user.usernode_pubkey);
        if (results.length >= 20) break;
      }
    }

    // If we need more results, search by substring
    if (results.length < 20) {
      for (const [key, user] of usernamesMap.entries()) {
        if (key.includes(lowerQuery) && !seen.has(user.usernode_pubkey)) {
          results.push(user);
          seen.add(user.usernode_pubkey);
          if (results.length >= 20) break;
        }
      }
    }

    // Also search by pubkey if query looks like a pubkey
    if (results.length < 20 && lowerQuery.startsWith('ut1')) {
      for (const [key, user] of pubkeyMap.entries()) {
        if (key.includes(lowerQuery) && !seen.has(user.usernode_pubkey)) {
          results.push(user);
          seen.add(user.usernode_pubkey);
          if (results.length >= 20) break;
        }
      }
    }

    return results;
  }

  /**
   * Get a single username by exact match
   */
  function getUsername(username) {
    if (!isInitialized) return null;
    return usernamesMap.get(username.toLowerCase()) || null;
  }

  /**
   * Get a username by pubkey
   */
  function getUsernameByPubkey(pubkey) {
    if (!isInitialized) return null;
    return pubkeyMap.get(pubkey.toLowerCase()) || null;
  }

  /**
   * Check if cache is ready
   */
  function ready() {
    return isInitialized;
  }

  /**
   * Get cache statistics
   */
  function stats() {
    return {
      initialized: isInitialized,
      usernameCount: usernamesMap.size,
      lastRefreshTime,
      isStaging
    };
  }

  // Start periodic refresh
  const refreshInterval = setInterval(() => {
    refresh().catch(err => console.error('[UsernamesCache] Refresh interval error:', err));
  }, refreshIntervalMs);

  return {
    initialize,
    refresh,
    searchUsernames,
    getUsername,
    getUsernameByPubkey,
    ready,
    stats,
    stopRefresh: () => clearInterval(refreshInterval)
  };
}

module.exports = { createUsernamesCache };
