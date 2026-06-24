const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Guardian 2 - Build PR #147: Modal dialogs for group management
const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
let ENABLE_DEMO_MODE = process.env.ENABLE_DEMO_MODE === 'true' || IS_STAGING;

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

const PUBLIC_API_PATHS = new Set(['/health', '/favicon.ico']);
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

// Send transaction to blockchain via bridge
async function sendTransactionToBridge(payload, network = 'testnet') {
  try {
    if (IS_STAGING) {
      // Mock implementation: return immediate confirmation with network prefix
      const networkPrefix = network === 'mainnet' ? 'ut1staging-mainnet-tx-' : 'ut1staging-testnet-tx-';
      const txHash = networkPrefix + Date.now();
      return { txHash, status: 'pending' };
    }

    // In production: call the real bridge sendTransaction
    // This would integrate with usernode-bridge.js with network parameter
    // For now, simulate with a unique tx hash including network
    const networkPrefix = network === 'mainnet' ? 'ut1mainnet-tx-' : 'ut1testnet-tx-';
    const txHash = networkPrefix + Math.random().toString(36).substr(2, 9);
    return { txHash, status: 'pending' };
  } catch (err) {
    console.error('Error sending transaction to bridge:', err);
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

app.use(express.json());
app.use(async (req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch (e) {
      console.error('JWT verification failed:', e.message);
    }
  }

  // Provide a default test user if no valid token (staging + production for testing)
  if (!req.user) {
    req.user = { id: 1, username: 'staging-demo-alice', usernode_pubkey: 'ut1staging-alice-001', verified_at: new Date() };
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

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/favicon.ico', (_req, res) => {
  res.status(204).send();
});

// ===== USER ENDPOINTS =====

app.get('/api/user', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const userRes = await pool.query(`SELECT network, view_mode, avatar_url, created_at, bio FROM users WHERE id = $1`, [req.user.id]);
    const network = userRes.rows[0]?.network || 'testnet';
    const view_mode = userRes.rows[0]?.view_mode || 'web';
    const avatar_url = userRes.rows[0]?.avatar_url || null;
    const created_at = userRes.rows[0]?.created_at || null;
    const bio = userRes.rows[0]?.bio || null;
    res.json({
      id: req.user.id,
      username: req.user.username,
      usernode_pubkey: req.user.usernode_pubkey || null,
      verified: !!req.user.verified_at,
      network: network,
      view_mode: view_mode,
      avatar_url: avatar_url,
      created_at: created_at,
      bio: bio,
      isDemoMode: ENABLE_DEMO_MODE,
    });
  } catch (err) {
    console.error('Error fetching user:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.put('/api/user/network', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { network } = req.body;
    if (!network || !['testnet', 'mainnet'].includes(network)) {
      return res.status(400).json({ error: 'Invalid network. Must be "testnet" or "mainnet"' });
    }

    await pool.query(`UPDATE users SET network = $1 WHERE id = $2`, [network, req.user.id]);
    res.json({ network: network, status: 'updated' });
  } catch (err) {
    console.error('Error updating network:', err);
    res.status(500).json({ error: 'Failed to update network' });
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

app.post('/api/user/avatar', async (req, res) => {
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
    const userRes = await pool.query(`SELECT network FROM users WHERE id = $1`, [userId]);
    const network = userRes.rows[0]?.network || 'testnet';
    const nodeId = network === 'mainnet' ? 'UserNode Mainnet' : 'UserNode Testnet';

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
      nodeId: network,
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
      isDemoMode: ENABLE_DEMO_MODE,
      canEdit: canEdit,
      description: 'When enabled, all blockchain transactions use fake tx hashes and audit logs are immediately confirmed. When disabled, real wallet interaction is required and audit logs are pending until blockchain confirmation.'
    });
  } catch (err) {
    console.error('Error fetching config:', err);
    res.status(500).json({ error: 'Failed to fetch configuration' });
  }
});

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

    // Update in-memory state
    ENABLE_DEMO_MODE = enabled;
    console.log(`[CONFIG] Demo mode updated: ${enabled} (by user ${userId})`);

    res.json({
      isDemoMode: ENABLE_DEMO_MODE,
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
      };

      if (isArchived) {
        archived.push(convData);
      } else if (isSavedContact) {
        active.push(convData);
      } else {
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
      const result = await pool.query(`
        INSERT INTO conversations (participant_a_id, participant_b_id, created_at, updated_at)
        VALUES ($1, $2, NOW(), NOW())
        RETURNING id
      `, [a, b]);
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
    const { type, content } = req.body;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
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

    // Fetch user's network preference and pubkey
    const userRes = await pool.query(`SELECT network, usernode_pubkey FROM users WHERE id = $1`, [userId]);
    const network = userRes.rows[0]?.network || 'testnet';
    const userPubkey = userRes.rows[0]?.usernode_pubkey || null;

    // Create message with blockchain recording enabled
    const contentHash = computeContentHash(content);
    const msgRes = await pool.query(`
      INSERT INTO messages (conversation_id, sender_id, type, content, blockchain_recorded, blockchain_audit_log_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, created_at
    `, [convId, userId, type, JSON.stringify(content), true, null, now]);
    const messageId = msgRes.rows[0].id;

    // Prepare transaction payload
    const transactionPayload = {
      type: 'message',
      messageId: messageId,
      senderId: userId,
      userPubkey: userPubkey,
      contentHash: contentHash,
      timestamp: now.toISOString(),
      network: network
    };

    // Create audit log entry for message
    const networkPrefix = network === 'mainnet' ? 'mainnet-' : 'testnet-';
    const placeholderTxHash = ENABLE_DEMO_MODE ? 'ut1staging-' + networkPrefix + 'message-' + messageId + '-' + Date.now() : 'ut1-' + networkPrefix + 'tx-msg-' + Math.random().toString(36).substr(2, 9);
    const auditStatus = ENABLE_DEMO_MODE ? 'confirmed' : 'pending';
    const confirmedAt = ENABLE_DEMO_MODE ? now : null;
    const auditRes = await pool.query(`
      INSERT INTO blockchain_audit_logs (user_id, message_id, message_type, tx_hash, transaction_payload, status, confirmed_at, content_hash, user_pubkey, action_timestamp, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
      RETURNING id
    `, [userId, messageId, 'message', placeholderTxHash, JSON.stringify(transactionPayload), auditStatus, confirmedAt, contentHash, userPubkey, now, now]);
    const blockchainRecordingId = auditRes.rows[0].id;

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

    // Async: submit to blockchain in the background (production only)
    if (!ENABLE_DEMO_MODE) {
      (async () => {
        try {
          const result = await sendTransactionToBridge(transactionPayload, network);
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

    const { recipientId, amount, memo } = req.body;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }
    const now = new Date();

    if (!recipientId || !amount) {
      return res.status(400).json({ error: 'Invalid token transfer' });
    }

    if (!checkRateLimit(`token:${userId}`, 20, 60000)) {
      return res.status(429).json({ error: 'Rate limited' });
    }

    // Fetch user's network preference
    const userRes = await pool.query(`SELECT network FROM users WHERE id = $1`, [userId]);
    const network = userRes.rows[0]?.network || 'testnet';

    // Prepare transaction payload
    const transactionPayload = {
      type: 'token_transfer',
      sender: userId,
      recipient: recipientId,
      amount: parseInt(amount),
      memo: memo || '',
      network: network
    };

    // Create audit log entry with placeholder tx hash
    const networkPrefix = network === 'mainnet' ? 'mainnet-' : 'testnet-';
    const placeholderTxHash = ENABLE_DEMO_MODE ? 'ut1staging-' + networkPrefix + 'token-' + Date.now() : 'ut1-' + networkPrefix + 'tx-token-' + Math.random().toString(36).substr(2, 9);
    const auditStatus = ENABLE_DEMO_MODE ? 'confirmed' : 'pending';
    const confirmedAt = ENABLE_DEMO_MODE ? now : null;
    const auditRes = await pool.query(`
      INSERT INTO blockchain_audit_logs (user_id, message_type, tx_hash, transaction_payload, status, confirmed_at, content_hash, user_pubkey, action_timestamp, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
      RETURNING id
    `, [userId, 'token_transfer', placeholderTxHash, JSON.stringify(transactionPayload), auditStatus, confirmedAt, null, req.user.usernode_pubkey || null, now, now]);
    const blockchainRecordingId = auditRes.rows[0].id;

    // Async: submit to blockchain in the background (production only, skipped in demo mode)
    if (!ENABLE_DEMO_MODE) {
      (async () => {
        try {
          const result = await sendTransactionToBridge(transactionPayload, network);
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
      blockchainRecordingId: blockchainRecordingId,
      txHash: placeholderTxHash,
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
        const result = await sendTransactionToBridge(payload, network);
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

    res.json({ ok: true });
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
      SELECT uc.id, u.id as user_id, u.username, u.usernode_pubkey, u.verified_at, u.avatar_url, uc.nickname
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

    const { contactId } = req.params;
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

    const { contactId } = req.params;
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

    // Get groups where user is a member
    const { rows: groupRows } = await pool.query(`
      SELECT DISTINCT g.id, g.creator_id, g.name, g.description, g.avatar_url, g.created_at, g.updated_at,
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
      };
    }));

    res.json({ groups });
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

    const { name, description, initialMemberIds } = req.body;

    // Validation: parse and validate user ID
    const userId = parseInt(req.user.id, 10);
    console.log(`[POST /api/groups::VALIDATE] User ID parsing: raw=${req.user.id}, parsed=${userId}, isNaN=${isNaN(userId)}`);
    if (isNaN(userId)) {
      console.error(`[POST /api/groups::VALIDATE] Invalid user ID: ${req.user.id}`);
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    // Validation: check group name
    console.log(`[POST /api/groups::VALIDATE] Group name validation: provided="${name}", trimmed="${name ? name.trim() : '(null)'}", length=${name ? name.trim().length : 0}`);
    if (!name || name.trim().length === 0) {
      console.error(`[POST /api/groups::VALIDATE] Group name validation failed: empty or missing`);
      return res.status(400).json({ error: 'Group name is required' });
    }
    console.log(`[POST /api/groups::VALIDATE] All validations passed`);

    // Database: Fetch user's network preference
    console.log(`[POST /api/groups::DB] Fetching user network preference for userId=${userId}`);
    const userRes = await pool.query(`SELECT network FROM users WHERE id = $1`, [userId]);
    console.log(`[POST /api/groups::DB] User query returned ${userRes.rows.length} row(s)`);
    if (userRes.rows.length === 0) {
      console.warn(`[POST /api/groups::DB] User not found in database, using default network='testnet'`);
    } else {
      console.log(`[POST /api/groups::DB] User network from database: ${userRes.rows[0].network}`);
    }
    const network = userRes.rows[0]?.network || 'testnet';
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
    if (initialMemberIds && Array.isArray(initialMemberIds) && initialMemberIds.length > 0) {
      console.log(`[POST /api/groups::DB] Processing ${initialMemberIds.length} initial member(s)`);
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

    // Blockchain: Prepare transaction payload for blockchain
    const transactionPayload = {
      type: 'group_create',
      groupId: groupId,
      groupName: name.trim(),
      creatorId: userId,
      memberIds: initialMemberIds && initialMemberIds.length > 0 ? initialMemberIds : [userId],
      userPubkey: req.user.usernode_pubkey,
      timestamp: now.toISOString(),
      network: network
    };
    console.log(`[POST /api/groups::BLOCKCHAIN] Transaction payload prepared: type=${transactionPayload.type}, groupId=${transactionPayload.groupId}, memberCount=${transactionPayload.memberIds.length}, network=${transactionPayload.network}, userPubkeyPresent=${!!transactionPayload.userPubkey}`);

    // Blockchain: Create audit log entry
    const networkPrefix = network === 'mainnet' ? 'mainnet-' : 'testnet-';
    const placeholderTxHash = ENABLE_DEMO_MODE ? 'ut1staging-' + networkPrefix + 'group-create-' + groupId + '-' + Date.now() : 'ut1-' + networkPrefix + 'tx-group-' + Math.random().toString(36).substr(2, 9);
    const auditStatus = ENABLE_DEMO_MODE ? 'confirmed' : 'pending';
    const confirmedAt = ENABLE_DEMO_MODE ? now : null;
    console.log(`[POST /api/groups::BLOCKCHAIN] Creating audit log: txHash=${placeholderTxHash}, status=${auditStatus}, confirmedAt=${confirmedAt ? confirmedAt.toISOString() : 'null'}, env=${IS_STAGING ? 'staging' : 'production'}, demoMode=${ENABLE_DEMO_MODE}`);

    const auditRes = await pool.query(`
      INSERT INTO blockchain_audit_logs (user_id, group_id, message_type, tx_hash, transaction_payload, status, confirmed_at, content_hash, user_pubkey, action_timestamp, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
      RETURNING id
    `, [userId, groupId, 'group_create', placeholderTxHash, JSON.stringify(transactionPayload), auditStatus, confirmedAt, null, req.user.usernode_pubkey || null, now, now]);

    if (auditRes.rows.length === 0) {
      console.error(`[POST /api/groups::BLOCKCHAIN] Audit log insert returned no rows`);
      throw new Error('Audit log creation query returned no results');
    }
    const blockchainRecordingId = auditRes.rows[0].id;
    console.log(`[POST /api/groups::BLOCKCHAIN] Audit log created: id=${blockchainRecordingId}, rowCount=${auditRes.rowCount}`);

    // Blockchain: Async background task launch
    if (!ENABLE_DEMO_MODE) {
      console.log(`[POST /api/groups::BLOCKCHAIN] Spawning background blockchain submission task (production only)`);
      (async () => {
        try {
          console.log(`[POST /api/groups::BLOCKCHAIN::ASYNC] Background task started for auditId=${blockchainRecordingId}`);
          const result = await sendTransactionToBridge(transactionPayload, network);
          console.log(`[POST /api/groups::BLOCKCHAIN::ASYNC] Bridge returned txHash=${result.txHash}, status=${result.status}`);

          // Update audit log with real tx hash
          const updateRes = await pool.query(`
            UPDATE blockchain_audit_logs SET tx_hash = $1 WHERE id = $2
          `, [result.txHash, blockchainRecordingId]);
          console.log(`[POST /api/groups::BLOCKCHAIN::ASYNC] Audit log updated with real txHash, rowCount=${updateRes.rowCount}`);

          // Start monitoring
          console.log(`[POST /api/groups::BLOCKCHAIN::ASYNC] Starting blockchain status monitoring`);
          monitorBlockchainStatus(blockchainRecordingId, result.txHash).catch(err => {
            console.error(`[POST /api/groups::BLOCKCHAIN::ASYNC] Error monitoring blockchain status: ${err.message}`, err);
          });
        } catch (err) {
          console.error(`[POST /api/groups::BLOCKCHAIN::ASYNC] Background blockchain submission error: ${err.message}`, err);
          await pool.query(`
            UPDATE blockchain_audit_logs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2
          `, [err.message, blockchainRecordingId]);
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
    const userRes = await pool.query(`SELECT network FROM users WHERE id = $1`, [userId]);
    const network = userRes.rows[0]?.network || 'testnet';

    // Update group
    await pool.query(`
      UPDATE groups SET name = $1, description = $2, updated_at = NOW() WHERE id = $3
    `, [name || groupRows[0].name, description || null, groupId]);

    // Prepare transaction payload for blockchain
    const transactionPayload = {
      type: 'group_update',
      groupId: groupId,
      groupName: name || groupRows[0].name,
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
        const result = await sendTransactionToBridge(transactionPayload, network);
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
    const { type, content } = req.body;
    const userId = parseInt(req.user.id, 10);
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
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

    // Fetch user's network preference and pubkey
    const userRes = await pool.query(`SELECT network, usernode_pubkey FROM users WHERE id = $1`, [userId]);
    const network = userRes.rows[0]?.network || 'testnet';
    const userPubkey = userRes.rows[0]?.usernode_pubkey || null;

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

    // Create audit log entry for message
    const networkPrefix = network === 'mainnet' ? 'mainnet-' : 'testnet-';
    const placeholderTxHash = ENABLE_DEMO_MODE ? 'ut1staging-' + networkPrefix + 'message-' + messageId + '-' + Date.now() : 'ut1-' + networkPrefix + 'tx-msg-' + Math.random().toString(36).substr(2, 9);
    const auditStatus = ENABLE_DEMO_MODE ? 'confirmed' : 'pending';
    const confirmedAt = ENABLE_DEMO_MODE ? now : null;
    const auditRes = await pool.query(`
      INSERT INTO blockchain_audit_logs (user_id, message_id, group_id, message_type, tx_hash, transaction_payload, status, confirmed_at, content_hash, user_pubkey, action_timestamp, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
      RETURNING id
    `, [userId, messageId, groupId, 'message', placeholderTxHash, JSON.stringify(transactionPayload), auditStatus, confirmedAt, contentHash, userPubkey, now, now]);
    const blockchainRecordingId = auditRes.rows[0].id;

    // Update message with audit log reference
    await pool.query(`
      UPDATE group_messages SET blockchain_audit_log_id = $1 WHERE id = $2
    `, [blockchainRecordingId, messageId]);

    // Update group updated_at to reflect new message activity
    await pool.query(`
      UPDATE groups SET updated_at = NOW() WHERE id = $1
    `, [groupId]);

    // Async: submit to blockchain in the background (production only)
    if (!ENABLE_DEMO_MODE) {
      (async () => {
        try {
          const result = await sendTransactionToBridge(transactionPayload, network);
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
    const userRes = await pool.query(`SELECT network FROM users WHERE id = $1`, [userId]);
    const network = userRes.rows[0]?.network || 'testnet';
    const now = new Date();

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
      addedMemberIds: userIds.filter(id => id !== userId),
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
        const result = await sendTransactionToBridge(transactionPayload, network);
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
    const userRes = await pool.query(`SELECT network FROM users WHERE id = $1`, [userId]);
    const network = userRes.rows[0]?.network || 'testnet';

    // Remove member
    await pool.query(`
      DELETE FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [groupId, targetId]);

    // Prepare transaction payload for blockchain
    const transactionPayload = {
      type: 'group_remove_member',
      groupId: groupId,
      removedUserId: targetId,
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
        const result = await sendTransactionToBridge(transactionPayload, network);
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
    const userRes = await pool.query(`SELECT network FROM users WHERE id = $1`, [userId]);
    const network = userRes.rows[0]?.network || 'testnet';

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
        const result = await sendTransactionToBridge(transactionPayload, network);
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
    const userRes = await pool.query(`SELECT network FROM users WHERE id = $1`, [userId]);
    const network = userRes.rows[0]?.network || 'testnet';

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
        const result = await sendTransactionToBridge(transactionPayload, network);
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

    // For now, just mark as read to simulate archiving
    // TODO: Add archived_by column to groups table for persistence
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

// GET /api/feed/posts - Fetch paginated feed posts
app.get('/api/feed/posts', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const limit = Math.min(parseInt(req.query.limit || 50), 100);
    const offset = parseInt(req.query.offset || 0);

    const { rows: posts } = await pool.query(`
      SELECT
        fp.id,
        fp.user_id,
        fp.content,
        fp.created_at,
        fp.on_chain,
        u.username,
        u.verified_at,
        u.avatar_url,
        (SELECT COUNT(*) FROM feed_likes WHERE post_id = fp.id)::INTEGER as like_count,
        (SELECT COUNT(*) FROM feed_comments WHERE post_id = fp.id)::INTEGER as comment_count
      FROM feed_posts fp
      JOIN users u ON u.id = fp.user_id
      ORDER BY fp.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const { rows: countResult } = await pool.query(`
      SELECT COUNT(*) as count FROM feed_posts
    `);

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
        onChain: p.on_chain,
        likeCount: p.like_count || 0,
        commentCount: p.comment_count || 0
      })),
      hasMore
    });
  } catch (err) {
    console.error('Error fetching feed posts:', err);
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
});

// POST /api/feed/posts - Create a new feed post
app.post('/api/feed/posts', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    let { text, link } = req.body;
    text = text ? text.trim() : '';

    // Extract URL from text if no explicit link provided
    if (!link && text) {
      const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
      if (urlMatch) {
        link = urlMatch[1];
        text = text.replace(urlMatch[0], '').trim();
      }
    }

    if (!text && !link) {
      return res.status(400).json({ error: 'Post must contain text or a link' });
    }

    const content = { text };

    if (link) {
      // Validate URL format
      let urlObj;
      try {
        urlObj = new URL(link);
      } catch {
        return res.status(400).json({ error: 'Invalid URL format' });
      }

      // Check domain reachability
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(urlObj.origin + '/', {
          method: 'HEAD',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Guardian/1.0)'
          },
          signal: controller.signal,
          redirect: 'follow'
        });

        clearTimeout(timeoutId);

        if (!response.ok && response.status >= 500) {
          return res.status(400).json({ error: 'Could not reach that domain. Please check the URL.' });
        }
      } catch (err) {
        return res.status(400).json({ error: 'Could not reach that domain. Please check the URL.' });
      }

      content.link = link;

      // Fetch preview metadata
      const preview = await fetchLinkPreview(link);
      if (preview) {
        content.linkTitle = preview.title;
        content.linkImage = preview.image;
      }
    }

    const { rows: postRows } = await pool.query(`
      INSERT INTO feed_posts (user_id, content, created_at)
      VALUES ($1, $2, NOW())
      RETURNING id, user_id, content, created_at
    `, [req.user.id, JSON.stringify(content)]);

    const post = postRows[0];
    const { rows: userRows } = await pool.query(`
      SELECT username, verified_at, avatar_url FROM users WHERE id = $1
    `, [req.user.id]);

    const user = userRows[0];

    res.json({
      id: post.id,
      userId: post.user_id,
      username: user.username,
      verified: !!user.verified_at,
      avatarUrl: user.avatar_url,
      content: post.content,
      createdAt: post.created_at
    });
  } catch (err) {
    console.error('Error creating feed post:', err);
    res.status(500).json({ error: 'Failed to create post' });
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

    // Fetch comments (only top-level comments)
    const { rows: comments } = await pool.query(`
      SELECT
        fc.id,
        fc.user_id,
        fc.content,
        fc.created_at,
        u.username,
        u.verified_at,
        u.avatar_url,
        (SELECT COUNT(*) FROM feed_comments WHERE parent_comment_id = fc.id)::INTEGER as reply_count
      FROM feed_comments fc
      JOIN users u ON u.id = fc.user_id
      WHERE fc.post_id = $1 AND fc.parent_comment_id IS NULL
      ORDER BY fc.created_at ASC
      LIMIT $2 OFFSET $3
    `, [postId, limit, offset]);

    // Get total count (only top-level comments)
    const { rows: countResult } = await pool.query(`
      SELECT COUNT(*) as count FROM feed_comments WHERE post_id = $1 AND parent_comment_id IS NULL
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
        createdAt: c.created_at,
        replyCount: c.reply_count || 0
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

    // Verify post exists
    const { rows: postRows } = await pool.query(`
      SELECT id FROM feed_posts WHERE id = $1
    `, [postId]);

    if (postRows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

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

// GET /api/feed/posts/:postId/comments/:commentId/replies - Fetch replies to a comment
app.get('/api/feed/posts/:postId/comments/:commentId/replies', async (req, res) => {
  try {
    const { postId, commentId } = req.params;
    const limit = Math.min(parseInt(req.query.limit || 50), 100);
    const offset = parseInt(req.query.offset || 0);

    // Verify post exists
    const { rows: postRows } = await pool.query(`
      SELECT id FROM feed_posts WHERE id = $1
    `, [postId]);

    if (postRows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Verify parent comment exists
    const { rows: parentCommentRows } = await pool.query(`
      SELECT id FROM feed_comments WHERE id = $1 AND post_id = $2
    `, [commentId, postId]);

    if (parentCommentRows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    // Fetch replies
    const { rows: replies } = await pool.query(`
      SELECT
        fc.id,
        fc.user_id,
        fc.content,
        fc.created_at,
        u.username,
        u.verified_at,
        u.avatar_url,
        (SELECT COUNT(*) FROM feed_comments WHERE parent_comment_id = fc.id)::INTEGER as reply_count
      FROM feed_comments fc
      JOIN users u ON u.id = fc.user_id
      WHERE fc.parent_comment_id = $1
      ORDER BY fc.created_at ASC
      LIMIT $2 OFFSET $3
    `, [commentId, limit, offset]);

    // Get total count
    const { rows: countResult } = await pool.query(`
      SELECT COUNT(*) as count FROM feed_comments WHERE parent_comment_id = $1
    `, [commentId]);

    const total = parseInt(countResult[0].count);
    const hasMore = offset + limit < total;

    res.json({
      replies: replies.map(r => ({
        id: r.id,
        userId: r.user_id,
        username: r.username,
        verified: !!r.verified_at,
        avatarUrl: r.avatar_url,
        content: r.content,
        createdAt: r.created_at,
        replyCount: r.reply_count || 0,
        parentCommentId: commentId
      })),
      total,
      hasMore
    });
  } catch (err) {
    console.error('Error fetching replies:', err);
    res.status(500).json({ error: 'Failed to fetch replies' });
  }
});

// POST /api/feed/posts/:postId/comments/:commentId/replies - Create a reply to a comment
app.post('/api/feed/posts/:postId/comments/:commentId/replies', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { postId, commentId } = req.params;
    const { content } = req.body;
    const userId = req.user.id;

    if (!checkRateLimit(`comment:${userId}`, 200, 60000)) {
      return res.status(429).json({ error: 'Rate limited' });
    }

    if (!content || content.trim() === '') {
      return res.status(400).json({ error: 'Reply content is required' });
    }

    // Verify post exists
    const { rows: postRows } = await pool.query(`
      SELECT id FROM feed_posts WHERE id = $1
    `, [postId]);

    if (postRows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Verify parent comment exists
    const { rows: parentCommentRows } = await pool.query(`
      SELECT id FROM feed_comments WHERE id = $1 AND post_id = $2
    `, [commentId, postId]);

    if (parentCommentRows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    // Create reply
    const { rows: replyRows } = await pool.query(`
      INSERT INTO feed_comments (post_id, user_id, parent_comment_id, content, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      RETURNING id, created_at
    `, [postId, userId, commentId, content.trim()]);

    const reply = replyRows[0];

    // Fetch user info
    const { rows: userRows } = await pool.query(`
      SELECT username, verified_at, avatar_url FROM users WHERE id = $1
    `, [userId]);

    const user = userRows[0];

    res.json({
      id: reply.id,
      userId: userId,
      username: user.username,
      verified: !!user.verified_at,
      avatarUrl: user.avatar_url,
      content: content.trim(),
      createdAt: reply.created_at,
      replyCount: 0,
      parentCommentId: commentId
    });
  } catch (err) {
    console.error('Error creating reply:', err);
    res.status(500).json({ error: 'Failed to create reply' });
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

// Simple proxy for explorer API to avoid CORS issues
app.use('/explorer-api', (req, res) => {
  // Forward requests to testnet explorer
  // This is a no-op in staging (explorer-api not actively used since mock returns status instantly)
  // In production, this could be used to verify transaction status independently
  res.status(501).json({ error: 'Explorer API proxy not yet fully configured' });
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
        avatar_url VARCHAR(500),
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
        UNIQUE(user_id, contact_user_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_contacts_user_id
        ON user_contacts(user_id)
    `);

    // Create blockchain_audit_logs table (marked private)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blockchain_audit_logs (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id BIGINT REFERENCES messages(id) ON DELETE CASCADE,
        message_type VARCHAR(50),
        tx_hash VARCHAR(255) UNIQUE NOT NULL,
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
        avatar_url VARCHAR(500),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
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
        parent_comment_id BIGINT REFERENCES feed_comments(id) ON DELETE CASCADE,
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
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_feed_comments_parent_id
        ON feed_comments(parent_comment_id)
    `);

    // Add parent_comment_id column if it doesn't exist (for existing DBs)
    await pool.query(`
      ALTER TABLE feed_comments
      ADD COLUMN IF NOT EXISTS parent_comment_id BIGINT REFERENCES feed_comments(id) ON DELETE CASCADE
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

    // Add on_chain column to feed_posts if it doesn't exist
    await pool.query(`
      ALTER TABLE feed_posts
      ADD COLUMN IF NOT EXISTS on_chain BOOLEAN DEFAULT FALSE
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
          creatorId: alice,
          memberIds: [alice, bob, charlie],
          userPubkey: userPubkeyMap[alice],
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
            senderId: msg.sender,
            userPubkey: userPubkeyMap[msg.sender],
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

        await pool.query(`
          INSERT INTO feed_comments (post_id, user_id, content, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $4)
          ON CONFLICT DO NOTHING
        `, [alicePostId, bob, '[Staging demo] Great read! Security is so important in Web3.', commentTime]);
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

      // Seed replies to comments
      if (bobDeployPostRows.length > 0) {
        const bobPostId = bobDeployPostRows[0].id;

        // Get the first two comments on Bob's post
        const { rows: bobCommentRows } = await pool.query(`
          SELECT id FROM feed_comments WHERE post_id = $1 AND parent_comment_id IS NULL ORDER BY created_at ASC LIMIT 2
        `, [bobPostId]);

        if (bobCommentRows.length > 0) {
          const comment1Id = bobCommentRows[0].id;
          const replyTime1 = new Date(feedBaseTime.getTime() - 2100000);
          const replyTime2 = new Date(feedBaseTime.getTime() - 1800000);

          await pool.query(`
            INSERT INTO feed_comments (post_id, user_id, parent_comment_id, content, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $5), ($1, $6, $3, $7, $8, $8)
            ON CONFLICT DO NOTHING
          `, [
            bobPostId,
            emma,
            comment1Id,
            '[Staging demo] Absolutely! This is a game changer.',
            replyTime1,
            frank,
            '[Staging demo] The release notes look super polished too!',
            replyTime2
          ]);
        }

        if (bobCommentRows.length > 1) {
          const comment2Id = bobCommentRows[1].id;
          const replyTime3 = new Date(feedBaseTime.getTime() - 1500000);

          await pool.query(`
            INSERT INTO feed_comments (post_id, user_id, parent_comment_id, content, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $5)
            ON CONFLICT DO NOTHING
          `, [
            bobPostId,
            alice,
            comment2Id,
            '[Staging demo] Same here! Definitely checking it out later today.',
            replyTime3
          ]);
        }
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
    }

    app.listen(port, () => console.log(`Listening on :${port}`));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();
