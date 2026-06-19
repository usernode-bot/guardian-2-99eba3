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

      // Get other user's username, verified status, and wallet address
      const userRes = await pool.query(`SELECT username, verified_at, usernode_pubkey FROM users WHERE id = $1`, [otherId]);
      const username = userRes.rows[0]?.username || 'Unknown';
      const verified = !!userRes.rows[0]?.verified_at;
      const usernode_pubkey = userRes.rows[0]?.usernode_pubkey || null;

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
        verified,
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

    const { rows: messages } = await pool.query(`
      SELECT id, sender_id,
             (SELECT username FROM users WHERE id = sender_id) as sender_username,
             type, content, created_at
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

    const { rows } = await pool.query(`
      INSERT INTO messages (conversation_id, sender_id, type, content, created_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, created_at
    `, [convId, userId, type, JSON.stringify(content), now]);

    res.json({ id: rows[0].id, createdAt: rows[0].created_at });
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

    if (!recipientId || !amount) {
      return res.status(400).json({ error: 'Invalid token transfer' });
    }

    if (!checkRateLimit(`token:${userId}`, 20, 60000)) {
      return res.status(429).json({ error: 'Rate limited' });
    }

    // Mock token transfer response
    const txHash = IS_STAGING ? 'staging-tx-' + Date.now() : 'tx-' + Math.random().toString(36).substr(2, 9);
    res.json({
      txHash,
      status: IS_STAGING ? 'confirmed' : 'pending',
      sender: userId,
      recipient: recipientId,
      amount,
      memo: memo || '',
    });
  } catch (err) {
    console.error(err);
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
        created_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_by INTEGER[]
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
        ON messages(conversation_id, created_at);
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

    // Mark tables as private
    await pool.query(`COMMENT ON TABLE conversations IS 'staging:private'`);
    await pool.query(`COMMENT ON TABLE messages IS 'staging:private'`);
    await pool.query(`COMMENT ON TABLE read_receipts IS 'staging:private'`);

    // Seed staging data
    if (IS_STAGING) {
      const alice = 1, bob = 2, charlie = 3, diana = 4, eve = 5;

      // Create test users with wallet addresses
      await pool.query(`
        INSERT INTO users (id, username, usernode_pubkey, verified_at, created_at) VALUES
          ($1, 'staging-demo-alice', 'ut1staging-alice-001', NOW(), NOW()),
          ($2, 'staging-demo-bob', 'ut1staging-bob-001', NOW(), NOW()),
          ($3, 'staging-demo-charlie', 'ut1staging-charlie-001', NOW(), NOW()),
          ($4, 'staging-demo-diana', 'ut1staging-diana-001', NOW(), NOW()),
          ($5, 'staging-demo-eve', 'ut1staging-eve-001', NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
          username = EXCLUDED.username,
          usernode_pubkey = EXCLUDED.usernode_pubkey,
          verified_at = EXCLUDED.verified_at
      `, [alice, bob, charlie, diana, eve]);

      // Verify users were created
      const usersExist = await pool.query(`SELECT COUNT(*) as count FROM users WHERE id IN ($1, $2, $3, $4, $5)`, [alice, bob, charlie, diana, eve]);
      if (usersExist.rows[0].count < 5) {
        console.warn('Warning: Not all staging users were created. Count:', usersExist.rows[0].count);
      }

      // Helper to create conversations with messages and read receipts
      const createConversation = async (user1, user2, messageSpecs, readStatusSpecs) => {
        const [a, b] = [user1, user2].sort((x, y) => x - y);
        const { rows: convRows } = await pool.query(`
          SELECT id FROM conversations WHERE participant_a_id = $1 AND participant_b_id = $2
        `, [a, b]);

        let convId;
        if (convRows.length === 0) {
          const result = await pool.query(`
            INSERT INTO conversations (participant_a_id, participant_b_id, created_at)
            VALUES ($1, $2, NOW())
            RETURNING id
          `, [a, b]);
          convId = result.rows[0].id;
        } else {
          convId = convRows[0].id;
        }

        const baseTime = new Date(Date.now() - 3600000);
        for (const msg of messageSpecs) {
          await pool.query(`
            INSERT INTO messages (conversation_id, sender_id, type, content, created_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
          `, [convId, msg.sender, msg.type, JSON.stringify(msg.content), new Date(baseTime.getTime() + msg.offset)]);
        }

        // Set read receipts
        for (const rs of readStatusSpecs) {
          await pool.query(`
            INSERT INTO read_receipts (user_id, conversation_id, last_read_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at
          `, [rs.userId, convId, rs.lastReadAt]);
        }

        return convId;
      };

      const now = new Date();

      // Conversation 1: Alice ↔ Bob (recent text, 0 unread, 5 minutes ago)
      await createConversation(alice, bob, [
        { offset: 0, sender: alice, type: 'text', content: { text: '[Staging] Hey Bob!' } },
        { offset: 60000, sender: bob, type: 'text', content: { text: '[Staging] Hi Alice! How are you?' } },
        { offset: 120000, sender: alice, type: 'text', content: { text: '[Staging] Doing great, thanks!' } },
      ], [
        { userId: alice, lastReadAt: now },
        { userId: bob, lastReadAt: now },
      ]);

      // Conversation 2: Alice ↔ Charlie (image message, 2 unread, 2 hours ago)
      const twoHoursAgo = new Date(now - 2 * 3600000);
      const charlie2HoursRead = new Date(twoHoursAgo - 1800000);
      await createConversation(alice, charlie, [
        { offset: 0, sender: alice, type: 'text', content: { text: '[Staging] Check this out!' } },
        { offset: 60000, sender: charlie, type: 'image', content: { imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8DwHwMxxGAIwAAADkkBkMTjF4UAAAAASUVORK5CYII=' } },
        { offset: 120000, sender: charlie, type: 'text', content: { text: '[Staging] What do you think?' } },
      ], [
        { userId: alice, lastReadAt: charlie2HoursRead },
        { userId: charlie, lastReadAt: now },
      ]);

      // Conversation 3: Alice ↔ Diana (token transfer, 1 unread, 1 day ago)
      const oneDayAgo = new Date(now - 86400000);
      const dianaOneDayRead = new Date(oneDayAgo - 3600000);
      await createConversation(alice, diana, [
        { offset: 0, sender: alice, type: 'text', content: { text: '[Staging] Here is a gift' } },
        { offset: 60000, sender: alice, type: 'token', content: { recipientId: diana, amount: 100, memo: '[Staging] for you', txHash: 'staging-tx-001', status: 'confirmed' } },
        { offset: 120000, sender: diana, type: 'text', content: { text: '[Staging] Thanks so much!' } },
      ], [
        { userId: alice, lastReadAt: dianaOneDayRead },
        { userId: diana, lastReadAt: now },
      ]);

      // Conversation 4: Alice ↔ Eve (varied messages with some unread)
      const threeHoursAgo = new Date(now - 3 * 3600000);
      const eveThreeHoursRead = new Date(threeHoursAgo - 1800000);
      await createConversation(alice, eve, [
        { offset: 0, sender: eve, type: 'text', content: { text: '[Staging] Hey Alice!' } },
        { offset: 60000, sender: alice, type: 'text', content: { text: '[Staging] Hi Eve! Long time!' } },
        { offset: 120000, sender: eve, type: 'text', content: { text: '[Staging] How have you been?' } },
      ], [
        { userId: alice, lastReadAt: eveThreeHoursRead },
        { userId: eve, lastReadAt: now },
      ]);

      // Verify conversations were seeded
      const convCheck = await pool.query(`SELECT COUNT(*) as count FROM conversations WHERE participant_a_id = $1`, [alice]);
      console.log(`Staging seed complete: ${convCheck.rows[0].count} conversations for alice`);
    }

    app.listen(port, () => console.log(`Listening on :${port}`));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();
