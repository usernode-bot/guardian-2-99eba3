const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

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

// Helper function to execute a database query with a timeout
async function queryWithTimeout(pool, query, params, timeoutMs = 2000) {
  return Promise.race([
    pool.query(query, params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('QUERY_TIMEOUT')), timeoutMs)
    )
  ]);
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

  // In staging, provide a default test user if no valid token
  if (IS_STAGING && !req.user) {
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
    const userRes = await pool.query(`SELECT network FROM users WHERE id = $1`, [req.user.id]);
    const network = userRes.rows[0]?.network || 'testnet';
    res.json({
      id: req.user.id,
      username: req.user.username,
      usernode_pubkey: req.user.usernode_pubkey || null,
      verified: !!req.user.verified_at,
      network: network,
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

// ===== CONVERSATION ENDPOINTS =====

app.get('/api/conversations', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const limit = Math.min(parseInt(req.query.limit || 50), 100);
    const offset = parseInt(req.query.offset || 0);
    const userId = req.user.id;

    // Optimized query using joins to eliminate N+1 lookups
    const convQuery = `
      SELECT
        c.id,
        c.participant_a_id,
        c.participant_b_id,
        c.archived_by,
        c.muted_by,
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
    res.status(200).json({ conversations: { active: [], pending: [], archived: [] } });
  }
});

app.post('/api/conversations', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { participantId } = req.body;
    const userId = req.user.id;

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
    const { convId } = req.params;
    const limit = Math.min(parseInt(req.query.limit || 50), 100);
    const before = req.query.before ? new Date(req.query.before) : new Date();
    const userId = req.user.id;

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
             (SELECT username FROM users WHERE id = sender_id) as sender_username,
             type, content, created_at, blockchain_recorded, blockchain_audit_log_id
      FROM messages
      WHERE conversation_id = $1
        AND created_at < $2
        AND (deleted_by IS NULL OR NOT (deleted_by @> ARRAY[$3]))
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
    const userId = req.user.id;
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

    // Fetch user's network preference
    const userRes = await pool.query(`SELECT network FROM users WHERE id = $1`, [userId]);
    const network = userRes.rows[0]?.network || 'testnet';

    // Prepare transaction payload
    const transactionPayload = {
      type: 'message',
      messageType: type,
      content: content,
      senderUserId: userId,
      network: network
    };

    // Create audit log entry first with placeholder tx hash
    const networkPrefix = network === 'mainnet' ? 'mainnet-' : 'testnet-';
    const placeholderTxHash = IS_STAGING ? 'ut1staging-' + networkPrefix + 'tx-msg-' + Date.now() : 'ut1-' + networkPrefix + 'tx-msg-' + Math.random().toString(36).substr(2, 9);
    const auditRes = await pool.query(`
      INSERT INTO blockchain_audit_logs (user_id, message_type, tx_hash, transaction_payload, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $6)
      RETURNING id
    `, [userId, 'message', placeholderTxHash, JSON.stringify(transactionPayload), 'pending', now]);
    const blockchainRecordingId = auditRes.rows[0].id;

    // Create message with blockchain recording flag
    const msgRes = await pool.query(`
      INSERT INTO messages (conversation_id, sender_id, type, content, blockchain_recorded, blockchain_audit_log_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, created_at
    `, [convId, userId, type, JSON.stringify(content), true, blockchainRecordingId, now]);
    const messageId = msgRes.rows[0].id;

    // Update audit log with message_id
    await pool.query(`
      UPDATE blockchain_audit_logs SET message_id = $1 WHERE id = $2
    `, [messageId, blockchainRecordingId]);

    // Update conversation updated_at to reflect new message activity
    await pool.query(`
      UPDATE conversations SET updated_at = NOW() WHERE id = $1
    `, [convId]);

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
    const { convId, messageId } = req.params;
    const userId = req.user.id;

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
    const { convId } = req.params;
    const { readUpTo } = req.body;
    const userId = req.user.id;

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
    const { convId } = req.params;
    const userId = req.user.id;

    await pool.query(`
      UPDATE conversations
      SET muted_by = CASE
        WHEN muted_by @> ARRAY[$1] THEN array_remove(muted_by, $1)
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
    const { convId } = req.params;
    const userId = req.user.id;

    await pool.query(`
      UPDATE conversations
      SET archived_by = CASE
        WHEN archived_by @> ARRAY[$1] THEN array_remove(archived_by, $1)
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
    const userId = req.user.id;
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
    const placeholderTxHash = IS_STAGING ? 'ut1staging-' + networkPrefix + 'tx-token-' + Date.now() : 'ut1-' + networkPrefix + 'tx-token-' + Math.random().toString(36).substr(2, 9);
    const auditRes = await pool.query(`
      INSERT INTO blockchain_audit_logs (user_id, message_type, tx_hash, transaction_payload, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $6)
      RETURNING id
    `, [userId, 'token_transfer', placeholderTxHash, JSON.stringify(transactionPayload), 'pending', now]);
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

    res.json({
      blockchainRecordingId: blockchainRecordingId,
      txHash: placeholderTxHash,
      status: 'pending',
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

    const { rows } = await pool.query(`
      SELECT id, user_id, message_id, message_type, tx_hash, status, error_message, confirmed_at
      FROM blockchain_audit_logs
      WHERE id = $1 AND user_id = $2
    `, [auditLogId, req.user.id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Audit log not found' });
    }

    const row = rows[0];
    res.json({
      id: row.id,
      messageId: row.message_id,
      messageType: row.message_type,
      txHash: row.tx_hash,
      status: row.status,
      errorMessage: row.error_message || null,
      confirmedAt: row.confirmed_at || null,
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
    const userId = req.user.id;

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
        const payload = JSON.parse(auditLog.transaction_payload);
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
    const userId = req.user.id;

    const { rows } = await pool.query(`
      SELECT id, message_id, message_type, tx_hash, status, error_message, confirmed_at, created_at
      FROM blockchain_audit_logs
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    const { rows: countRows } = await pool.query(`
      SELECT COUNT(*) as total FROM blockchain_audit_logs WHERE user_id = $1
    `, [userId]);

    const transactions = rows.map(r => ({
      id: r.id,
      messageId: r.message_id,
      messageType: r.message_type,
      txHash: r.tx_hash,
      status: r.status,
      errorMessage: r.error_message || null,
      confirmedAt: r.confirmed_at || null,
      createdAt: r.created_at
    }));

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

// ===== CONVERSATION CONTROL ENDPOINTS =====

app.post('/api/conversations/:convId/accept', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { convId } = req.params;
    const userId = req.user.id;

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
      SET ${statusCol} = 'accepted'
      WHERE id = $1
    `, [convId]);

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
    const userId = req.user.id;

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
    const userId = req.user.id;

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

    const userId = req.user.id;
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
    const userId = req.user.id;

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
    const userId = req.user.id;

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

app.delete('/api/contacts/:contactId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { contactId } = req.params;
    const userId = req.user.id;

    const result = await pool.query(`
      DELETE FROM user_contacts
      WHERE id = $1 AND user_id = $2
    `, [contactId, userId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json({ ok: true });
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
    const q = req.query.q || '';
    let rows;

    try {
      const result = await queryWithTimeout(pool, `
        SELECT id, username, verified_at, usernode_pubkey
        FROM users
        WHERE username ILIKE $1 OR usernode_pubkey ILIKE $2
        ORDER BY
          CASE
            WHEN username = $3 OR usernode_pubkey = $4 THEN 0
            WHEN username ILIKE $5 OR usernode_pubkey ILIKE $6 THEN 1
            ELSE 2
          END,
          username ASC
        LIMIT 20
      `, ['%' + q + '%', '%' + q + '%', q, q, q + '%', q + '%'], 2000);
      rows = result.rows;
    } catch (timeoutErr) {
      // On timeout, return demo fallback users
      if (timeoutErr.message === 'QUERY_TIMEOUT') {
        console.info('Search query timeout after 2000ms, returning demo fallback');
        const users = [
          { id: 1, username: 'staging-demo-alice', usernode_pubkey: 'ut1staging-alice-001', verified: true, mutualCount: 0 },
          { id: 2, username: 'staging-demo-bob', usernode_pubkey: 'ut1staging-bob-001', verified: true, mutualCount: 0 },
          { id: 3, username: 'staging-demo-charlie', usernode_pubkey: 'ut1staging-charlie-001', verified: false, mutualCount: 0 }
        ];
        return res.json({ users });
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
      SELECT id, username, verified_at, usernode_pubkey FROM users WHERE id = $1
    `, [userId]);

    if (!rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = rows[0];
    res.json({
      id: user.id,
      username: user.username,
      usernode_pubkey: user.usernode_pubkey || null,
      verified: !!user.verified_at,
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

    const userId = req.user.id;
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
          const content = JSON.parse(row.last_content || '{}');
          lastMessage = content.text || '';
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
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { name, description, initialMemberIds } = req.body;
    const userId = req.user.id;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    // Create group
    const result = await pool.query(`
      INSERT INTO groups (creator_id, name, description, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      RETURNING id, name, description, avatar_url, creator_id, created_at, updated_at
    `, [userId, name.trim(), description || null]);

    const groupId = result.rows[0].id;

    // Add creator as member
    await pool.query(`
      INSERT INTO group_members (group_id, user_id, role, joined_at)
      VALUES ($1, $2, 'creator', NOW())
    `, [groupId, userId]);

    // Add initial members if provided
    if (initialMemberIds && Array.isArray(initialMemberIds) && initialMemberIds.length > 0) {
      for (const memberId of initialMemberIds) {
        if (memberId !== userId) {
          await pool.query(`
            INSERT INTO group_members (group_id, user_id, role, joined_at)
            VALUES ($1, $2, 'member', NOW())
            ON CONFLICT (group_id, user_id) DO NOTHING
          `, [groupId, memberId]);
        }
      }
    }

    // Initialize read receipt for creator
    await pool.query(`
      INSERT INTO group_read_receipts (user_id, group_id, last_read_at)
      VALUES ($1, $2, NOW())
    `, [userId, groupId]);

    // Get members
    const { rows: memberRows } = await pool.query(`
      SELECT gm.id, gm.user_id, u.username, gm.role, gm.joined_at
      FROM group_members gm
      JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = $1
    `, [groupId]);

    const members = memberRows.map(m => ({
      id: m.id,
      userId: m.user_id,
      username: m.username,
      role: m.role,
      joinedAt: m.joined_at
    }));

    res.json({
      id: groupId,
      name: result.rows[0].name,
      description: result.rows[0].description,
      creatorId: result.rows[0].creator_id,
      members,
      createdAt: result.rows[0].created_at
    });
  } catch (err) {
    console.error('Error creating group:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/groups/:groupId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { groupId } = req.params;
    const userId = req.user.id;

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
    const userId = req.user.id;

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

    // Update group
    await pool.query(`
      UPDATE groups SET name = $1, description = $2, updated_at = NOW() WHERE id = $3
    `, [name || groupRows[0].name, description || null, groupId]);

    res.json({ ok: true });
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
    const userId = req.user.id;
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
             (SELECT username FROM users WHERE id = sender_id) as sender_username,
             type, content, created_at, blockchain_recorded, blockchain_audit_log_id, deleted_by
      FROM group_messages
      WHERE group_id = $1
        AND created_at < $2
        AND (deleted_by IS NULL OR NOT (deleted_by @> ARRAY[$3]))
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
    const userId = req.user.id;
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

    // Fetch user's network preference
    const userRes = await pool.query(`SELECT network FROM users WHERE id = $1`, [userId]);
    const network = userRes.rows[0]?.network || 'testnet';

    // Prepare transaction payload
    const transactionPayload = {
      type: 'message',
      messageType: type,
      content: content,
      senderUserId: userId,
      network: network
    };

    // Create audit log entry first with placeholder tx hash
    const networkPrefix = network === 'mainnet' ? 'mainnet-' : 'testnet-';
    const placeholderTxHash = IS_STAGING ? 'ut1staging-' + networkPrefix + 'tx-gmsg-' + Date.now() : 'ut1-' + networkPrefix + 'tx-gmsg-' + Math.random().toString(36).substr(2, 9);
    const auditRes = await pool.query(`
      INSERT INTO blockchain_audit_logs (user_id, message_type, tx_hash, transaction_payload, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $6)
      RETURNING id
    `, [userId, 'message', placeholderTxHash, JSON.stringify(transactionPayload), 'pending', now]);
    const blockchainRecordingId = auditRes.rows[0].id;

    // Create message with blockchain recording flag
    const msgRes = await pool.query(`
      INSERT INTO group_messages (group_id, sender_id, type, content, blockchain_recorded, blockchain_audit_log_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, created_at
    `, [groupId, userId, type, JSON.stringify(content), true, blockchainRecordingId, now]);
    const messageId = msgRes.rows[0].id;

    // Update audit log with message_id
    await pool.query(`
      UPDATE blockchain_audit_logs SET message_id = $1 WHERE id = $2
    `, [messageId, blockchainRecordingId]);

    // Update group updated_at to reflect new message activity
    await pool.query(`
      UPDATE groups SET updated_at = NOW() WHERE id = $1
    `, [groupId]);

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
    const { groupId, messageId } = req.params;
    const userId = req.user.id;

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
    const userId = req.user.id;

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
          const userRes = await pool.query(`
            SELECT id, username, verified_at, avatar_url FROM users WHERE id = $1
          `, [memberId]);

          if (userRes.rows.length > 0) {
            const u = userRes.rows[0];
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

    res.json({ members: addedMembers });
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
    const userId = req.user.id;
    const targetId = parseInt(targetUserId);

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

    // Remove member
    await pool.query(`
      DELETE FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [groupId, targetId]);

    res.json({ ok: true });
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
    const userId = req.user.id;

    // Verify user is a member
    const { rows: memberRows } = await pool.query(`
      SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [groupId, userId]);

    if (memberRows.length === 0) {
      return res.status(404).json({ error: 'Not a member of this group' });
    }

    // Remove member
    await pool.query(`
      DELETE FROM group_members WHERE group_id = $1 AND user_id = $2
    `, [groupId, userId]);

    res.json({ ok: true });
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
    const userId = req.user.id;

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

    // Delete group (cascades to members and messages)
    await pool.query(`
      DELETE FROM groups WHERE id = $1
    `, [groupId]);

    res.json({ ok: true });
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
    const userId = req.user.id;

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
    const userId = req.user.id;

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
    const userId = req.user.id;

    // For now, just mark as read to simulate archiving
    // TODO: Add archived_by column to groups table for persistence
    res.json({ ok: true });
  } catch (err) {
    console.error('Error archiving group:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== EXPLORER API PROXY =====

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
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
        ON messages(conversation_id, created_at);
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
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_blockchain_audit_logs_message_id
        ON blockchain_audit_logs(message_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_blockchain_audit_logs_user_created
        ON blockchain_audit_logs(user_id, created_at)
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
    if (IS_STAGING) {
      const alice = 1, bob = 2, charlie = 3, david = 4, emma = 5;

      // Create test users with wallet addresses
      await pool.query(`
        INSERT INTO users (id, username, usernode_pubkey, verified_at, created_at) VALUES
          ($1, 'staging-demo-alice', 'ut1staging-alice-001', NOW(), NOW()),
          ($2, 'staging-demo-bob', 'ut1staging-bob-001', NOW(), NOW()),
          ($3, 'staging-demo-charlie', 'ut1staging-charlie-001', null, NOW()),
          ($4, 'staging-demo-david', 'ut1staging-david-001', NOW(), NOW()),
          ($5, 'staging-demo-emma', 'ut1staging-emma-001', NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
          username = EXCLUDED.username,
          usernode_pubkey = EXCLUDED.usernode_pubkey,
          verified_at = EXCLUDED.verified_at
      `, [alice, bob, charlie, david, emma]);

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
          const txHash = 'ut1staging-tx-msg-' + messageId;
          const messageType = msg.type === 'token' ? 'token_transfer' : 'message';
          const transactionPayload = msg.type === 'token'
            ? { type: 'token_transfer', sender: msg.sender, recipient: msg.content.recipientId, amount: msg.content.amount, memo: msg.content.memo }
            : { type: 'message', messageType: msg.type, content: msg.content, senderUserId: msg.sender };

          const auditResult = await pool.query(`
            INSERT INTO blockchain_audit_logs (user_id, message_id, message_type, tx_hash, transaction_payload, status, confirmed_at, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, 'confirmed', $6, $7, $7)
            ON CONFLICT DO NOTHING
            RETURNING id
          `, [msg.sender, messageId, messageType, txHash, JSON.stringify(transactionPayload), msgTime, msgTime]);

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
          const txHash = 'ut1staging-tx-gmsg-' + messageId;
          const transactionPayload = { type: 'message', messageType: msg.type, content: msg.content, senderUserId: msg.sender };

          const auditResult = await pool.query(`
            INSERT INTO blockchain_audit_logs (user_id, message_id, message_type, tx_hash, transaction_payload, status, confirmed_at, created_at, updated_at)
            VALUES ($1, $2, 'message', $3, $4, 'confirmed', $5, $6, $6)
            ON CONFLICT DO NOTHING
            RETURNING id
          `, [msg.sender, messageId, txHash, JSON.stringify(transactionPayload), msgTime, msgTime]);

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
          const txHash = 'ut1staging-tx-gmsg-' + messageId;
          const messageType = msg.type === 'token' ? 'token_transfer' : 'message';
          const transactionPayload = msg.type === 'token'
            ? { type: 'token_transfer', sender: msg.sender, recipient: msg.content.recipientId, amount: msg.content.amount, memo: msg.content.memo }
            : { type: 'message', messageType: msg.type, content: msg.content, senderUserId: msg.sender };

          const auditResult = await pool.query(`
            INSERT INTO blockchain_audit_logs (user_id, message_id, message_type, tx_hash, transaction_payload, status, confirmed_at, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, 'confirmed', $6, $7, $7)
            ON CONFLICT DO NOTHING
            RETURNING id
          `, [msg.sender, messageId, messageType, txHash, JSON.stringify(transactionPayload), msgTime, msgTime]);

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
    }

    app.listen(port, () => console.log(`Listening on :${port}`));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();
