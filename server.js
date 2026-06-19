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

// Background blockchain submission handler
async function submitToBlockchain(userId, auditLogId, messageType, content) {
  try {
    // In staging, instantly confirm transactions
    if (IS_STAGING) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await pool.query(`
        UPDATE blockchain_audit_logs
        SET status = 'confirmed', confirmed_at = NOW()
        WHERE id = $1
      `, [auditLogId]);
      return;
    }

    // In production: simulate calling usernode-bridge.js via sendTransaction
    // For now, we'll just set status to confirmed after a delay
    // In a real implementation, this would call:
    // const bridge = require('./usernode-bridge');
    // const result = await bridge.sendTransaction({ ... });

    await new Promise(resolve => setTimeout(resolve, 3000));
    await pool.query(`
      UPDATE blockchain_audit_logs
      SET status = 'confirmed', confirmed_at = NOW()
      WHERE id = $1
    `, [auditLogId]);
  } catch (err) {
    console.error('Error in submitToBlockchain:', err);
    await pool.query(`
      UPDATE blockchain_audit_logs
      SET status = 'failed', error_message = $1
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
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/favicon.ico', (_req, res) => {
  res.status(204).send();
});

// ===== USER ENDPOINTS =====

app.get('/api/user', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({
    id: req.user.id,
    username: req.user.username,
    usernode_pubkey: req.user.usernode_pubkey || null,
    verified: !!req.user.verified_at,
  });
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

    // Simple query: get all conversations for this user
    const convQuery = `
      SELECT id, participant_a_id, participant_b_id, archived_by, muted_by
      FROM conversations
      WHERE (participant_a_id = $1 OR participant_b_id = $1)
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const { rows: conversations } = await pool.query(convQuery, [userId, limit, offset]);

    // For each conversation, get the last message and unread count
    const result = await Promise.all(conversations.map(async (conv) => {
      const otherId = conv.participant_a_id === userId ? conv.participant_b_id : conv.participant_a_id;

      // Get other user's username, wallet address, and nickname if saved
      const userRes = await pool.query(`
        SELECT u.username, u.usernode_pubkey, uc.nickname
        FROM users u
        LEFT JOIN user_contacts uc ON uc.contact_user_id = u.id AND uc.user_id = $1
        WHERE u.id = $2
      `, [userId, otherId]);
      const username = userRes.rows[0]?.username || 'Unknown';
      const usernode_pubkey = userRes.rows[0]?.usernode_pubkey || null;
      const nickname = userRes.rows[0]?.nickname || null;

      // Get last message
      const msgRes = await pool.query(`
        SELECT content, type, created_at
        FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [conv.id]);

      const lastMsg = msgRes.rows[0];
      const lastMessage = lastMsg
        ? (lastMsg.type === 'text' ? lastMsg.content?.text : lastMsg.type === 'image' ? '[Image]' : '[Token transfer]')
        : '';
      const lastMessageAt = lastMsg?.created_at || null;

      // Get unread count
      const readRes = await pool.query(`
        SELECT last_read_at FROM read_receipts WHERE user_id = $1 AND conversation_id = $2
      `, [userId, conv.id]);

      const lastReadAt = readRes.rows[0]?.last_read_at || new Date('1970-01-01');
      const unreadRes = await pool.query(`
        SELECT COUNT(*) as count
        FROM messages
        WHERE conversation_id = $1 AND sender_id != $2 AND created_at > $3
      `, [conv.id, userId, lastReadAt]);

      const unreadCount = parseInt(unreadRes.rows[0]?.count || 0);

      return {
        id: conv.id,
        otherId,
        username,
        nickname,
        usernode_pubkey,
        lastMessage,
        lastMessageAt,
        unreadCount,
      };
    }));

    res.json({ conversations: result });
  } catch (err) {
    console.error('Error fetching conversations:', err);
    res.status(200).json({ conversations: [] });
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
        INSERT INTO conversations (participant_a_id, participant_b_id)
        VALUES ($1, $2)
        RETURNING id
      `, [a, b]);
      convId = result.rows[0].id;
    }

    const userRes = await pool.query(`
      SELECT u.username, u.usernode_pubkey, uc.nickname
      FROM users u
      LEFT JOIN user_contacts uc ON uc.contact_user_id = u.id AND uc.user_id = $1
      WHERE u.id = $2
    `, [userId, participantId]);
    const username = userRes.rows[0]?.username || 'Unknown';
    const usernode_pubkey = userRes.rows[0]?.usernode_pubkey || null;
    const nickname = userRes.rows[0]?.nickname || null;

    res.json({ id: convId, participantId, username, nickname, usernode_pubkey });
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
        AND (deleted_by IS NULL OR NOT deleted_by @> ARRAY[$3])
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
    const { type, content, recordOnBlockchain } = req.body;
    const userId = req.user.id;
    const now = new Date();

    if (!checkRateLimit(`msg:${userId}`, 100, 60000)) {
      return res.status(429).json({ error: 'Rate limited' });
    }

    if (!type || !content) {
      return res.status(400).json({ error: 'Invalid message' });
    }

    let messageId, blockchainRecordingId = null;

    if (recordOnBlockchain) {
      // Generate placeholder tx hash
      const placeholderTxHash = IS_STAGING ? 'staging-tx-blockchain-' + Date.now() : 'tx-pending-' + Math.random().toString(36).substr(2, 9);

      // Create audit log entry first
      const auditRes = await pool.query(`
        INSERT INTO blockchain_audit_logs (user_id, tx_hash, status, created_at)
        VALUES ($1, $2, 'pending', $3)
        RETURNING id
      `, [userId, placeholderTxHash, now]);
      blockchainRecordingId = auditRes.rows[0].id;

      // Create message with blockchain recording flag
      const msgRes = await pool.query(`
        INSERT INTO messages (conversation_id, sender_id, type, content, blockchain_recorded, blockchain_audit_log_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, created_at
      `, [convId, userId, type, JSON.stringify(content), true, blockchainRecordingId, now]);
      messageId = msgRes.rows[0].id;

      // Update audit log with message_id
      await pool.query(`
        UPDATE blockchain_audit_logs SET message_id = $1 WHERE id = $2
      `, [messageId, blockchainRecordingId]);

      // Async: submit to blockchain in the background
      submitToBlockchain(userId, blockchainRecordingId, type, content).catch(err => {
        console.error('Background blockchain submission error:', err);
      });
    } else {
      // Regular message without blockchain recording
      const msgRes = await pool.query(`
        INSERT INTO messages (conversation_id, sender_id, type, content, created_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, created_at
      `, [convId, userId, type, JSON.stringify(content), now]);
      messageId = msgRes.rows[0].id;
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

    const { recipientId, amount, memo, recordOnBlockchain } = req.body;
    const userId = req.user.id;

    if (!recipientId || !amount) {
      return res.status(400).json({ error: 'Invalid token transfer' });
    }

    if (!checkRateLimit(`token:${userId}`, 20, 60000)) {
      return res.status(429).json({ error: 'Rate limited' });
    }

    // Mock token transfer response
    const txHash = IS_STAGING ? 'staging-tx-' + Date.now() : 'tx-' + Math.random().toString(36).substr(2, 9);
    const response = {
      txHash,
      status: IS_STAGING ? 'confirmed' : 'pending',
      sender: userId,
      recipient: recipientId,
      amount,
      memo: memo || '',
    };

    // Handle blockchain recording if requested
    if (recordOnBlockchain) {
      const placeholderTxHash = IS_STAGING ? 'staging-tx-blockchain-' + Date.now() : 'tx-pending-' + Math.random().toString(36).substr(2, 9);
      const auditRes = await pool.query(`
        INSERT INTO blockchain_audit_logs (user_id, tx_hash, status, created_at)
        VALUES ($1, $2, 'pending', NOW())
        RETURNING id
      `, [userId, placeholderTxHash]);
      const blockchainRecordingId = auditRes.rows[0].id;

      response.blockchainRecordingId = blockchainRecordingId;

      // Async: submit to blockchain
      submitToBlockchain(userId, blockchainRecordingId, 'token', { recipientId, amount, memo }).catch(err => {
        console.error('Background blockchain submission error:', err);
      });
    }

    res.json(response);
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
      SELECT id, user_id, message_id, tx_hash, status, error_message, confirmed_at
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

// ===== CONVERSATION REQUEST ENDPOINTS =====

app.post('/api/conversation-requests', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { recipientId } = req.body;
    const senderId = req.user.id;

    if (!recipientId || recipientId === senderId) {
      return res.status(400).json({ error: 'Invalid recipient' });
    }

    // Verify recipient exists
    const recipientRes = await pool.query(`SELECT id FROM users WHERE id = $1`, [recipientId]);
    if (recipientRes.rows.length === 0) {
      return res.status(400).json({ error: 'Recipient not found' });
    }

    // Try to insert, return existing if conflict
    const result = await pool.query(`
      INSERT INTO conversation_requests (sender_id, recipient_id, status, created_at)
      VALUES ($1, $2, 'pending', NOW())
      ON CONFLICT (sender_id, recipient_id) DO UPDATE SET
        status = CASE
          WHEN conversation_requests.status = 'rejected' THEN 'pending'
          ELSE conversation_requests.status
        END,
        created_at = CASE
          WHEN conversation_requests.status = 'rejected' THEN NOW()
          ELSE conversation_requests.created_at
        END,
        accepted_at = NULL,
        rejected_at = NULL
      WHERE conversation_requests.status = 'rejected'
      RETURNING id, sender_id, recipient_id, status, created_at
    `, [senderId, recipientId]);

    if (result.rows.length > 0) {
      const req_row = result.rows[0];
      res.status(201).json({
        id: req_row.id,
        senderId: req_row.sender_id,
        recipientId: req_row.recipient_id,
        status: req_row.status,
        createdAt: req_row.created_at,
      });
    } else {
      // Already exists and not rejected, get existing
      const existing = await pool.query(`
        SELECT id, sender_id, recipient_id, status, created_at
        FROM conversation_requests
        WHERE sender_id = $1 AND recipient_id = $2
      `, [senderId, recipientId]);
      const row = existing.rows[0];
      res.status(201).json({
        id: row.id,
        senderId: row.sender_id,
        recipientId: row.recipient_id,
        status: row.status,
        createdAt: row.created_at,
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/conversation-requests/received', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = req.user.id;

    const { rows: requests } = await pool.query(`
      SELECT cr.id, cr.sender_id, cr.created_at,
             u.username, u.usernode_pubkey, uc.nickname
      FROM conversation_requests cr
      JOIN users u ON cr.sender_id = u.id
      LEFT JOIN user_contacts uc ON uc.contact_user_id = u.id AND uc.user_id = $1
      WHERE cr.recipient_id = $1 AND cr.status = 'pending'
      ORDER BY cr.created_at DESC
    `, [userId]);

    res.json({
      requests: requests.map(r => ({
        id: r.id,
        senderId: r.sender_id,
        senderUsername: r.username,
        senderNickname: r.nickname,
        senderWallet: r.usernode_pubkey,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/conversation-requests/sent', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = req.user.id;

    const { rows: requests } = await pool.query(`
      SELECT cr.id, cr.recipient_id, cr.status, cr.created_at,
             u.username, u.usernode_pubkey, uc.nickname
      FROM conversation_requests cr
      JOIN users u ON cr.recipient_id = u.id
      LEFT JOIN user_contacts uc ON uc.contact_user_id = u.id AND uc.user_id = $1
      WHERE cr.sender_id = $1 AND cr.status IN ('pending', 'accepted')
      ORDER BY cr.created_at DESC
    `, [userId]);

    res.json({
      requests: requests.map(r => ({
        id: r.id,
        recipientId: r.recipient_id,
        recipientUsername: r.username,
        recipientNickname: r.nickname,
        recipientWallet: r.usernode_pubkey,
        status: r.status,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/conversation-requests/:requestId/accept', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { requestId } = req.params;
    const userId = req.user.id;

    // Verify request exists and belongs to user
    const { rows: reqRows } = await pool.query(`
      SELECT sender_id, recipient_id, status
      FROM conversation_requests
      WHERE id = $1 AND recipient_id = $2
    `, [requestId, userId]);

    if (reqRows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const req_row = reqRows[0];
    if (req_row.status !== 'pending') {
      return res.status(400).json({ error: 'Request is not pending' });
    }

    const senderId = req_row.sender_id;
    const recipientId = req_row.recipient_id;

    // Create or get conversation
    const [a, b] = [senderId, recipientId].sort((x, y) => x - y);
    const { rows: convRows } = await pool.query(`
      SELECT id FROM conversations
      WHERE participant_a_id = $1 AND participant_b_id = $2
    `, [a, b]);

    let convId = convRows[0]?.id;
    if (!convId) {
      const result = await pool.query(`
        INSERT INTO conversations (participant_a_id, participant_b_id)
        VALUES ($1, $2)
        RETURNING id
      `, [a, b]);
      convId = result.rows[0].id;
    }

    // Update request status
    await pool.query(`
      UPDATE conversation_requests
      SET status = 'accepted', accepted_at = NOW()
      WHERE id = $1
    `, [requestId]);

    res.json({
      conversationId: convId,
      requestId: requestId,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/conversation-requests/:requestId/reject', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { requestId } = req.params;
    const userId = req.user.id;

    // Verify request exists and belongs to user
    const { rows: reqRows } = await pool.query(`
      SELECT id, status
      FROM conversation_requests
      WHERE id = $1 AND recipient_id = $2
    `, [requestId, userId]);

    if (reqRows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // Update request status (idempotent)
    await pool.query(`
      UPDATE conversation_requests
      SET status = 'rejected', rejected_at = NOW()
      WHERE id = $1
    `, [requestId]);

    res.json({
      requestId: requestId,
      status: 'rejected',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/conversation-requests/:requestId/cancel', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { requestId } = req.params;
    const userId = req.user.id;

    // Verify request exists and belongs to user
    const { rows: reqRows } = await pool.query(`
      SELECT id, status
      FROM conversation_requests
      WHERE id = $1 AND sender_id = $2
    `, [requestId, userId]);

    if (reqRows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (reqRows[0].status !== 'pending') {
      return res.status(400).json({ error: 'Only pending requests can be cancelled' });
    }

    // Delete the request
    await pool.query(`
      DELETE FROM conversation_requests
      WHERE id = $1
    `, [requestId]);

    res.json({
      requestId: requestId,
    });
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
    const { rows } = await pool.query(`
      SELECT id, username, verified_at, usernode_pubkey
      FROM users
      WHERE username ILIKE $1
      LIMIT 20
    `, ['%' + q + '%']);

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

    // Create conversations table (marked private)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id BIGSERIAL PRIMARY KEY,
        participant_a_id INTEGER NOT NULL,
        participant_b_id INTEGER NOT NULL,
        archived_by INTEGER[],
        muted_by INTEGER[],
        created_at TIMESTAMPTZ DEFAULT NOW(),
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
        tx_hash VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        transaction_data JSONB,
        error_message TEXT,
        confirmed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_blockchain_audit_logs_message_id
        ON blockchain_audit_logs(message_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_blockchain_audit_logs_user_created
        ON blockchain_audit_logs(user_id, created_at)
    `);

    // Create conversation_requests table (marked private)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_requests (
        id BIGSERIAL PRIMARY KEY,
        sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        accepted_at TIMESTAMPTZ,
        rejected_at TIMESTAMPTZ,
        UNIQUE(sender_id, recipient_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversation_requests_recipient_status
        ON conversation_requests(recipient_id, status)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversation_requests_sender_status
        ON conversation_requests(sender_id, status)
    `);

    // Mark tables as private
    await pool.query(`COMMENT ON TABLE conversations IS 'staging:private'`);
    await pool.query(`COMMENT ON TABLE messages IS 'staging:private'`);
    await pool.query(`COMMENT ON TABLE read_receipts IS 'staging:private'`);
    await pool.query(`COMMENT ON TABLE user_contacts IS 'staging:private'`);
    await pool.query(`COMMENT ON TABLE blockchain_audit_logs IS 'staging:private'`);
    await pool.query(`COMMENT ON TABLE conversation_requests IS 'staging:private'`);

    // Seed staging data
    if (IS_STAGING) {
      const alice = 1, bob = 2, charlie = 3;

      // Create test users with wallet addresses
      await pool.query(`
        INSERT INTO users (id, username, usernode_pubkey, verified_at, created_at) VALUES
          ($1, 'staging-demo-alice', 'ut1staging-alice-001', NOW(), NOW()),
          ($2, 'staging-demo-bob', 'ut1staging-bob-001', NOW(), NOW()),
          ($3, 'staging-demo-charlie', 'ut1staging-charlie-001', NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
          username = EXCLUDED.username,
          usernode_pubkey = EXCLUDED.usernode_pubkey,
          verified_at = EXCLUDED.verified_at
      `, [alice, bob, charlie]);

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
          const auditResult = await pool.query(`
            INSERT INTO blockchain_audit_logs (user_id, message_id, tx_hash, status, confirmed_at, created_at)
            VALUES ($1, $2, $3, 'confirmed', $4, $5)
            ON CONFLICT DO NOTHING
            RETURNING id
          `, [msg.sender, messageId, 'staging-tx-blockchain-' + messageId, msgTime, msgTime]);

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

      // Seed contacts
      await pool.query(`
        INSERT INTO user_contacts (user_id, contact_user_id, nickname, created_at)
        VALUES ($1, $2, 'Bob (demo contact)', NOW())
        ON CONFLICT DO NOTHING
      `, [alice, bob]);

      // Seed conversation requests
      await pool.query(`
        INSERT INTO conversation_requests (sender_id, recipient_id, status, created_at)
        VALUES ($1, $2, 'pending', NOW())
        ON CONFLICT (sender_id, recipient_id) DO NOTHING
      `, [alice, charlie]);

      await pool.query(`
        INSERT INTO conversation_requests (sender_id, recipient_id, status, created_at, accepted_at)
        VALUES ($1, $2, 'accepted', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '30 minutes')
        ON CONFLICT (sender_id, recipient_id) DO NOTHING
      `, [charlie, bob]);
    }

    app.listen(port, () => console.log(`Listening on :${port}`));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();
