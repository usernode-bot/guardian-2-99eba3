const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Demo usernames for staging
const DEMO_USERNAMES = {
  'alice-pubkey': 'alice',
  'bob-pubkey': 'bob',
  'charlie-pubkey': 'charlie'
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

const PUBLIC_API_PATHS = new Set(['/health', '/favicon.ico', '/__usernames/state']);

app.use(express.json());
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch (e) {
      console.error('JWT verification failed:', e.message);
    }
  }

  // In staging, provide a default test user if no valid token
  if (IS_STAGING && !req.user) {
    req.user = { id: 1, username: 'staging-demo-alice', verified_at: new Date(), usernode_pubkey: 'alice-pubkey' };
  }

  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (req.path.startsWith('/api/usernames/')) return next();
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
    verified: !!req.user.verified_at,
    usernode_pubkey: req.user.usernode_pubkey || null,
  });
});

// ===== USERNAME ENDPOINTS =====

app.get('/__usernames/state', (req, res) => {
  res.json(DEMO_USERNAMES);
});

app.get('/api/usernames/:pubkey', (req, res) => {
  const { pubkey } = req.params;
  const username = DEMO_USERNAMES[pubkey] || null;
  res.json({ pubkey, username });
});

// ===== CAMPAIGN ENDPOINTS =====

app.get('/api/campaigns', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || 20), 100);
    const offset = parseInt(req.query.offset || 0);

    const { rows: campaigns } = await pool.query(`
      SELECT id, creator_address, creator_username, title, description, goal_amount, current_amount, created_at
      FROM campaigns
      WHERE is_active = true
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const { rows: totalRows } = await pool.query(`
      SELECT COUNT(*) as count FROM campaigns WHERE is_active = true
    `);

    res.json({
      campaigns,
      hasMore: campaigns.length === limit,
      total: parseInt(totalRows[0].count)
    });
  } catch (err) {
    console.error('Error fetching campaigns:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: campaignRows } = await pool.query(`
      SELECT id, creator_address, creator_username, title, description, goal_amount, current_amount, created_at, is_active
      FROM campaigns
      WHERE id = $1
    `, [id]);

    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignRows[0];

    const { rows: backers } = await pool.query(`
      SELECT contributor_address, contributor_username, amount, memo, created_at
      FROM contributions
      WHERE campaign_id = $1 AND status = 'confirmed'
      ORDER BY created_at DESC
    `, [id]);

    res.json({
      ...campaign,
      backers
    });
  } catch (err) {
    console.error('Error fetching campaign:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { title, description, goal_amount } = req.body;
    if (!title || !goal_amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const creator_address = req.user.usernode_pubkey;
    const creator_username = req.user.username;

    const { rows } = await pool.query(`
      INSERT INTO campaigns (creator_address, creator_username, title, description, goal_amount, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING id, created_at
    `, [creator_address, creator_username, title, description, goal_amount]);

    res.json({ id: rows[0].id, created_at: rows[0].created_at });
  } catch (err) {
    console.error('Error creating campaign:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== CONTRIBUTION ENDPOINTS =====

app.post('/api/campaigns/:id/contribute', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { id } = req.params;
    const { amount, memo } = req.body;

    if (!amount) {
      return res.status(400).json({ error: 'Amount is required' });
    }

    const contributor_address = req.user.usernode_pubkey;
    const contributor_username = req.user.username;

    const { rows } = await pool.query(`
      INSERT INTO contributions (campaign_id, contributor_address, contributor_username, amount, memo, status, created_at)
      VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
      RETURNING id
    `, [id, contributor_address, contributor_username, amount, memo || null]);

    res.json({
      id: rows[0].id,
      status: 'pending',
      tx_hash: ''
    });
  } catch (err) {
    console.error('Error recording contribution:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/campaigns/:campaignId/contributions/:contributionId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { campaignId, contributionId } = req.params;
    const { tx_hash, status } = req.body;

    if (!tx_hash) {
      return res.status(400).json({ error: 'tx_hash is required' });
    }

    // Update contribution
    await pool.query(`
      UPDATE contributions
      SET tx_hash = $1, status = $2
      WHERE id = $3 AND campaign_id = $4
    `, [tx_hash, status || 'confirmed', contributionId, campaignId]);

    // Get the contribution amount to update campaign total
    const { rows: contribRows } = await pool.query(`
      SELECT amount FROM contributions WHERE id = $1
    `, [contributionId]);

    if (contribRows.length && status === 'confirmed') {
      const amount = contribRows[0].amount;
      await pool.query(`
        UPDATE campaigns
        SET current_amount = current_amount + $1
        WHERE id = $2
      `, [amount, campaignId]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error updating contribution:', err);
    res.status(500).json({ error: err.message });
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

      // Get other user's username
      const userRes = await pool.query(`SELECT username FROM users WHERE id = $1`, [otherId]);
      const username = userRes.rows[0]?.username || 'Unknown';

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

    const userRes = await pool.query(`SELECT username FROM users WHERE id = $1`, [participantId]);
    const username = userRes.rows[0]?.username || 'Unknown';

    res.json({ id: convId, participantId, username });
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
      SELECT id, username, verified_at
      FROM users
      WHERE username ILIKE $1
      LIMIT 20
    `, ['%' + q + '%']);

    const users = rows.map(r => ({
      id: r.id,
      username: r.username,
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
      SELECT id, username, verified_at FROM users WHERE id = $1
    `, [userId]);

    if (!rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = rows[0];
    res.json({
      id: user.id,
      username: user.username,
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
        verified_at TIMESTAMPTZ,
        avatar_url VARCHAR(500),
        blocked_users INTEGER[],
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create campaigns table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id BIGSERIAL PRIMARY KEY,
        creator_address VARCHAR(255) NOT NULL,
        creator_username VARCHAR(255),
        title VARCHAR(500) NOT NULL,
        description TEXT,
        goal_amount BIGINT NOT NULL,
        current_amount BIGINT DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create contributions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contributions (
        id BIGSERIAL PRIMARY KEY,
        campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        contributor_address VARCHAR(255) NOT NULL,
        contributor_username VARCHAR(255),
        amount BIGINT NOT NULL,
        memo TEXT,
        tx_hash VARCHAR(500),
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
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
      const alice = 1, bob = 2;

      // Create test users
      await pool.query(`
        INSERT INTO users (id, username, verified_at, created_at) VALUES
          ($1, 'staging-demo-alice', NOW(), NOW()),
          ($2, 'staging-demo-bob', NOW(), NOW())
        ON CONFLICT DO NOTHING
      `, [alice, bob]);

      // Seed campaigns
      await pool.query(`
        INSERT INTO campaigns (creator_address, creator_username, title, description, goal_amount, current_amount, created_at) VALUES
          ('alice-pubkey', 'alice', '[Staging] Clean Water Initiative', '[Staging] Provide clean water to communities', 100000, 50000, NOW()),
          ('bob-pubkey', 'bob', '[Staging] Tech Education Fund', '[Staging] Support coding education programs', 50000, 30000, NOW())
        ON CONFLICT DO NOTHING
      `);

      // Seed contributions
      await pool.query(`
        INSERT INTO contributions (campaign_id, contributor_address, contributor_username, amount, status, tx_hash, created_at) VALUES
          (1, 'bob-pubkey', 'bob', 30000, 'confirmed', 'staging-contrib-001', NOW()),
          (1, 'charlie-pubkey', 'charlie', 20000, 'confirmed', 'staging-contrib-002', NOW()),
          (2, 'alice-pubkey', 'alice', 30000, 'confirmed', 'staging-contrib-003', NOW())
        ON CONFLICT DO NOTHING
      `);

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
        { offset: 0, sender: alice, type: 'text', content: { text: '[Staging] Hey Bob!' } },
        { offset: 60000, sender: bob, type: 'text', content: { text: '[Staging] Hi Alice! How are you?' } },
        { offset: 120000, sender: alice, type: 'text', content: { text: '[Staging] Doing great, thanks!' } },
        { offset: 180000, sender: alice, type: 'image', content: { imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8DwHwMxxGAIwAAADkkBkMTjF4UAAAAASUVORK5CYII=' } },
        { offset: 240000, sender: bob, type: 'text', content: { text: '[Staging] Nice photo!' } },
        { offset: 300000, sender: alice, type: 'token', content: { recipientId: bob, amount: 100, memo: '[Staging] Here is a gift', txHash: 'staging-tx-001', status: 'confirmed' } },
        { offset: 360000, sender: bob, type: 'text', content: { text: '[Staging] Thanks for the tokens!' } },
        { offset: 420000, sender: bob, type: 'image', content: { imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNkYPhfwcDAwMjIyMjIyAgAEq4DBaIjqKQAAAAASUVORK5CYII=' } },
        { offset: 480000, sender: alice, type: 'token', content: { recipientId: bob, amount: 50, memo: '[Staging] bonus', txHash: 'staging-tx-002', status: 'confirmed' } },
        { offset: 540000, sender: bob, type: 'text', content: { text: '[Staging] This is awesome!' } },
      ];

      for (const msg of messages) {
        await pool.query(`
          INSERT INTO messages (conversation_id, sender_id, type, content, created_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT DO NOTHING
        `, [convId, msg.sender, msg.type, JSON.stringify(msg.content), new Date(baseTime.getTime() + msg.offset)]);
      }

      // Initialize read receipts
      await pool.query(`
        INSERT INTO read_receipts (user_id, conversation_id, last_read_at)
        VALUES ($1, $2, NOW()), ($3, $2, NOW())
        ON CONFLICT DO NOTHING
      `, [alice, convId, bob]);
    }

    app.listen(port, () => console.log(`Listening on :${port}`));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();
