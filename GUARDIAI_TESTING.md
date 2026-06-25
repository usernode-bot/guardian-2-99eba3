# GuardiAI Bot Account Creation & Testing Guide

## Overview

This document explains how to verify that the GuardiAI bot account (user ID 100) is properly created in the database and that the race condition fix allows the bot to reply to comments mentioning @GuardiAI.

## What Changed

### 1. Race Condition Fix (Applied in Previous Commit)
The bot reply logic is now **awaited** before sending the response to the user, ensuring all database operations complete before the endpoint returns.

**File:** `server.js` line 3702
```javascript
await (async () => {
  // Bot reply logic executes here completely before continuing
})();
```

### 2. Comprehensive Logging & Verification (This Commit)
Added explicit logging and a debug endpoint to trace and verify GuardiAI account creation:

#### A. Migration Logging
- Line 4359-4369: Detailed logs for `is_bot` column addition
- Logs: `[Migration] Adding is_bot column to users table...`
- Verification: `[Migration] ✅ is_bot column migration completed`

#### B. GuardiAI User Creation Logging
- Line 5663-5699: Comprehensive logging around GuardiAI user creation
- Logs the insert/upsert operation
- **Post-insert verification query** confirms the user exists with correct values
- Logs: `[GuardiAI Seed] ✅ GuardiAI user verified in database:`
  - id: 100
  - username: 'GuardiAI'
  - is_bot: true
  - usernode_pubkey: 'ut1-guardiAI-bot'
  - created_at: NOW()

#### C. Staging Demo Data Logging
- Line 5703-5778: Detailed logs for staging demo seed data
- Logs crypto demo post creation
- Logs bot reply insertion for BTC and ETH
- Logs friendly tone demo post and reply
- Final confirmation: `[GuardiAI Seed] ✅ Staging demo data seed completed`

#### D. Debug Endpoint
- **Endpoint:** `GET /api/debug/guardiAI` (public, no auth required)
- **Purpose:** Query the GuardiAI user directly to verify existence
- **Response on success (200):**
  ```json
  {
    "status": "ok",
    "user": {
      "id": 100,
      "username": "GuardiAI",
      "is_bot": true,
      "usernode_pubkey": "ut1-guardiAI-bot",
      "created_at": "2026-06-25T12:34:56.789Z",
      "avatar_url": null
    }
  }
  ```
- **Response on failure (404):**
  ```json
  {
    "error": "GuardiAI user not found",
    "message": "User with ID 100 or username GuardiAI does not exist in the database"
  }
  ```

## How to Verify

### Method 1: Check Server Logs (Easiest)

1. **Restart the server** in staging or production
2. **Look for these log lines** in the startup output:
   ```
   [Migration] Adding is_bot column to users table...
   [Migration] ✅ is_bot column migration completed
   [GuardiAI Seed] Starting GuardiAI user account creation...
   [GuardiAI Seed] GuardiAI user insert/upsert completed { rowCount: 1 }
   [GuardiAI Seed] ✅ GuardiAI user verified in database: {
     id: 100,
     username: 'GuardiAI',
     is_bot: true,
     usernode_pubkey: 'ut1-guardiAI-bot',
     created_at: '2026-06-25T...'
   }
   ```
3. **If staging**, also look for:
   ```
   [GuardiAI Seed] Starting staging demo data seed...
   [GuardiAI Seed] Created staging crypto demo post: { postId: ... }
   [GuardiAI Seed] Created staging crypto demo replies: { btcReplyId: ..., ethReplyId: ... }
   [GuardiAI Seed] Created staging friendly demo post: { postId: ... }
   [GuardiAI Seed] Created staging friendly demo reply: { friendlyReplyId: ... }
   [GuardiAI Seed] ✅ Staging demo data seed completed
   ```
4. **If you see all ✅ lines**, the GuardiAI account was successfully created and seeded.

### Method 2: Use Debug Endpoint (Direct Verification)

1. **Open a browser or curl to:**
   ```
   GET /api/debug/guardiAI
   ```
   Example:
   ```bash
   curl https://<app-url>/api/debug/guardiAI
   ```

2. **Expected response (HTTP 200):**
   ```json
   {
     "status": "ok",
     "user": {
       "id": 100,
       "username": "GuardiAI",
       "is_bot": true,
       "usernode_pubkey": "ut1-guardiAI-bot",
       "created_at": "2026-06-25T12:34:56.789Z",
       "avatar_url": null
     }
   }
   ```

3. **If you get HTTP 404**, the GuardiAI user does NOT exist — this indicates a bug.

### Method 3: Test Bot Replies in Action (Integration Test)

#### In Staging (with demo data):

1. Navigate to the **Staging demo: Market analysis** post
   - This post was auto-seeded with demo comments and bot replies
   - You should see the GuardiAI account has already replied with:
     - "BTC: $45230.00 📈 +3.2% (24h) | Strong momentum here!"
     - "ETH: $2340.00 📉 -1.8% (24h) | Could be interesting!"

2. Navigate to the **Staging demo: Just shipped a major update** post
   - You should see GuardiAI's friendly reply:
     - "Yooo that's fire! 🔥 Love the energy! Can't wait to see what you build next."

3. **Create a new post** and write a comment mentioning **@GuardiAI**:
   - Example: "@GuardiAI what's BTC at?"
   - **Expected:** Within seconds, GuardiAI will reply with the current BTC price
   - **Verify:** The reply comes from user "GuardiAI" (you can click to view their profile)

#### In Production:

1. **Create a post** and write a comment mentioning **@GuardiAI**:
   - Example: "@GuardiAI what's the price of ethereum?"
   - **Expected:** Within seconds, GuardiAI will reply with the current ETH price from CoinGecko
   - **Verify:** The reply is from the "GuardiAI" user account

2. **Verify the bot account profile**:
   - Click on the GuardiAI username in one of its replies
   - You should see a profile for "GuardiAI" with `is_bot=true` (if visible in UI)

## Key Implementation Details

### GuardiAI User Record
```
id: 100
username: 'GuardiAI'
is_bot: true
usernode_pubkey: 'ut1-guardiAI-bot'
verified_at: NOW()
created_at: NOW()
avatar_url: NULL (uses default)
```

### What the ON CONFLICT Logic Does
The database insert uses:
```sql
INSERT INTO users (id, username, usernode_pubkey, verified_at, created_at, is_bot)
VALUES (100, 'GuardiAI', 'ut1-guardiAI-bot', NOW(), NOW(), true)
ON CONFLICT (id) DO UPDATE SET
  username = EXCLUDED.username,
  is_bot = EXCLUDED.is_bot
```

This means:
- **First time:** Creates the user with all fields
- **Subsequent times:** Updates `username` and `is_bot` (idempotent, safe to run repeatedly)
- **No errors:** Will never fail due to duplicate user ID

### Verification Query
After insert, a verification query confirms:
```sql
SELECT id, username, is_bot, usernode_pubkey, created_at
FROM users
WHERE id = 100
```

If this returns a row, the GuardiAI account exists and is properly configured.

## Troubleshooting

### Symptom: "GuardiAI user not found" (404 on debug endpoint)

**Possible causes:**
1. Database migration didn't run properly
   - Check logs for: `[Migration] ✅ is_bot column migration completed`
   - If missing, the `is_bot` column may not exist

2. GuardiAI user creation failed
   - Check logs for error messages like: `[GuardiAI Seed] ❌ ERROR creating/upserting GuardiAI user:`
   - The error message will explain what went wrong

3. Database connection issues
   - Verify `DATABASE_URL` is set correctly
   - Check that the app has write permissions to the `users` table

**How to fix:**
1. Check server logs for the specific error
2. Verify database is running and accessible
3. Restart the server
4. Check the debug endpoint again

### Symptom: Bot replies don't appear when mentioned

Even with GuardiAI account created, replies might not appear if:

1. **@GuardiAI mention not detected**
   - Verify the comment contains `@GuardiAI` (case-insensitive)
   - The regex at line 3701 should match: `/@guardiAI/i.test(content)`

2. **Race condition not fixed**
   - The endpoint should have `await` before the bot reply logic (line 3702)
   - Without await, bot reply might not complete before response is sent

3. **CoinGecko API rate limit**
   - If queried many times, CoinGecko might rate-limit (HTTP 429)
   - Bot falls back to friendly tone when rate-limited (this is by design)

4. **Comment mentions crypto but parsing fails**
   - Check the crypto mapping at lines 142-183
   - Verify the ticker/name is in `CRYPTO_MAPPING` or `CRYPTO_NAME_MAPPING`

## Related Code

- **Bot reply endpoint:** `server.js` line 3700-3810 (POST /api/feed/posts/:postId/comments)
- **Migration for is_bot:** `server.js` line 4359-4369
- **GuardiAI creation:** `server.js` line 5663-5699
- **Staging demo seed:** `server.js` line 5701-5778
- **Debug endpoint:** `server.js` line 350-386
- **Crypto detection:** `server.js` line 201-223 (parseCryptoCurrencies function)
- **CoinGecko API:** `server.js` line 226-279 (fetchCryptoPrice function)

## Success Criteria

✅ All of the following must be true:

1. Server logs show `[Migration] ✅ is_bot column migration completed`
2. Server logs show `[GuardiAI Seed] ✅ GuardiAI user verified in database:`
3. Debug endpoint `GET /api/debug/guardiAI` returns HTTP 200 with correct user data
4. In staging, demo posts are visible with GuardiAI replies already seeded
5. Creating a new comment with @GuardiAI mention results in a bot reply within seconds
6. Bot reply comes from the "GuardiAI" user account (ID 100, is_bot=true)

If all conditions are met, the GuardiAI bot account is properly created and functioning.
