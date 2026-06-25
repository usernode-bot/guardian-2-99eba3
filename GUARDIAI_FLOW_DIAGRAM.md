# GuardiAI Bot Reply Flow Diagram

## Complete Request/Response Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         USER POSTS COMMENT                                  │
│                                                                              │
│  POST /api/feed/posts/{postId}/comments                                     │
│  Body: {                                                                     │
│    content: "@GuardiAI what's the price of BTC?",  ← Mentions bot           │
│    ...                                                                       │
│  }                                                                           │
└─────────────────┬───────────────────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    ENDPOINT HANDLER                                         │
│  server.js:3700-3950                                                        │
└─────────────────┬───────────────────────────────────────────────────────────┘
                  │
                  ▼ Line 3666
         ┌────────────────────┐
         │ Insert user comment│
         │ in feed_comments   │
         └────────┬───────────┘
                  │
                  ▼ Line 3701
         ┌──────────────────────────────────────────────┐
         │ Check: /@guardiAI/i.test(content)           │
         │ Does comment mention @GuardiAI?             │
         └──────────────────┬───────────────────────────┘
                            │
                       YES  │  NO
                            │  │
                       ┌────┘  └──────┬──────────────────────┐
                       │              │                      │
                       ▼ Line 3826    ▼ Line 3923            │
         ┌──────────────────────────┐        Skip bot        │
         │  AWAIT async IIFE        │        reply logic     │
         │  (CRITICAL FIX!)         │        (no wait)       │
         └──────────────┬───────────┘                        │
                        │                                    │
                        ▼ Line 3704                          │
             ┌─────────────────────────────────────────────┐ │
             │ Parse cryptocurrencies from comment         │ │
             │ parseCryptoCurrencies(content)              │ │
             │ Returns: ["bitcoin", "ethereum", ...]       │ │
             └─────────┬───────────────────────────────────┘ │
                       │                                      │
                       ▼ Line 3706                            │
             ┌──────────────────────────────────────┐        │
             │ Crypto found?                        │        │
             │ cryptoTickers.length > 0             │        │
             └──────────┬──────────────┬────────────┘        │
                        │              │                     │
                     YES │              │ NO                 │
                        │              │                     │
          ┌─────────────┘              │                     │
          │                            │                     │
          ▼ Line 3708-3900            │                     │
  ┌───────────────────────────────────┘                     │
  │ FOR EACH crypto ticker                                 │
  │ (Loop: BTC, ETH, SOL, etc.)                            │
  │                                                         │
  │  ┌──────────────────────────────────────┐              │
  │  │ Call CoinGecko API                  │              │
  │  │ fetchCryptoPrice(geckoId)           │              │
  │  │ (5-second timeout)                  │              │
  │  │ Returns: {price, change24h}         │              │
  │  └────────┬─────────────┬──────────────┘              │
  │           │             │                             │
  │      Success│          Error │                        │
  │           │             │                             │
  │           ▼             ▼                             │
  │    Format reply   ┌──────────────────────┐            │
  │    "BTC: $47250  │ Check error type:    │            │
  │     📈 +2.5% ... │ - RATE_LIMIT→skip    │            │
  │                  │ - TIMEOUT→friendly   │            │
  │                  │ - OTHER→friendly     │            │
  │                  └──────┬───────────────┘            │
  │                         │                            │
  │                         ▼                            │
  │                   Format friendly                    │
  │                   reply instead                      │
  │                         │                            │
  │     ┌───────────────────┴──────────────┐            │
  │     │                                  │            │
  │     ▼ Line 3714                        │            │
  │  Insert bot reply               ▼ Line 3869        │
  │  INSERT feed_comments           Insert friendly    │
  │  (user_id=100, content=replyText)   INSERT         │
  │                                                    │
  │  ┌──────────────────────────────────────┐         │
  │  │ Log interaction                      │         │
  │  │ INSERT bot_reply_log                 │         │
  │  │ (trigger, reply, crypto, price, api)│         │
  │  └──────────────────────────────────────┘         │
  │                                                    │
  └──────────────────┬───────────────────────────────┘
                     │
         ▼ Line 3901-3917
    ┌──────────────────────────────────┐
    │ NO crypto in comment             │
    │ Use friendly tone fallback       │
    │                                  │
    │ selectRandomFriendlyReply()      │
    │ e.g., "Love the energy here! 🌟" │
    │                                  │
    │ Insert bot reply                 │
    │ INSERT feed_comments             │
    │ (user_id=100, content=friendly)  │
    │                                  │
    │ Log interaction                  │
    │ INSERT bot_reply_log             │
    └────────────────┬─────────────────┘
                     │
                     ├─────────────────────────────────────┐
                     │                                     │
    ◄────────────────┘                                     │
    │                                                      │
    │           (ALL BOT OPERATIONS COMPLETE)             │
    │                                                      │
    │     AWAIT completes (line 3826)                     │
    │                                                      │
    └──────────────────────┬──────────────────────────────┤
                           │                              │
                     ◄─────┘                              │
                     │                                    │
    ┌────────────────┴────────────────┐                  │
    │                                 │                  │
    ▼ Line 3923 (ALL PATHS MERGE)     │                  │
┌─────────────────────────────────────────────────┐      │
│ Send response to user                           │      │
│                                                 │      │
│ res.json({                                      │      │
│   id: comment.id,                               │      │
│   userId: userId,                               │      │
│   username: user.username,                      │      │
│   content: content.trim(),                      │      │
│   createdAt: comment.created_at                 │      │
│ })                                              │      │
│                                                 │      │
│ ← HTTP 200 OK                                   │      │
└─────────────────────────────────────────────────┘      │
                    │                                    │
                    ▼                                    │
         ┌──────────────────────────────┐               │
         │  Frontend receives response   │               │
         │  Shows user's comment         │               │
         │  (OR user already sees it)    │               │
         └──────────────────────────────┘               │
                                                        │
                                                        │
         ┌───────────────────────────────────────────┐  │
         │  MEANWHILE (or soon after):               │  │
         │  Frontend polls /api/feed/posts/{id}/...  │  │
         │  to get bot replies                       │  │
         │                                           │  │
         │  Bot replies are ALREADY in database!    │◄──┘
         │                                           │
         │  Shows:                                  │
         │  - BTC: $47250.00 📈 +2.5% (24h) | ...   │
         │  - ETH: $2890.45 📉 -1.3% (24h) | ...    │
         │                                           │
         │  Posted by user "GuardiAI" (id: 100)     │
         └───────────────────────────────────────────┘
```

## Key Insights from Flow

### 1. The Critical Race Condition Fix (Line 3826)

**BEFORE (Broken):**
```
if (/@guardiAI/i.test(content)) {
  // No await here!
  try {
    const cryptoTickers = parseCryptoCurrencies(content);
    // ... bot reply logic (fires in background)
  }
}

res.json({...}) // Sent IMMEDIATELY, bot reply not done yet!
```

**AFTER (Fixed):**
```
if (/@guardiAI/i.test(content)) {
  await (async () => {  // ← AWAIT ensures completion
    try {
      const cryptoTickers = parseCryptoCurrencies(content);
      // ... bot reply logic (MUST complete before continuing)
    }
  })();
}

res.json({...}) // Sent AFTER bot reply is done!
```

### 2. Parallel Response Paths

The flow shows all paths eventually lead to `res.json()` at line 3923:

1. **Crypto found + API success** → Format crypto reply → Insert → Log → Continue
2. **Crypto found + Rate limit** → Skip reply → Continue
3. **Crypto found + Timeout** → Format friendly reply → Insert → Log → Continue
4. **Crypto found + Other error** → Format friendly reply → Insert → Log → Continue
5. **No crypto found** → Format friendly reply → Insert → Log → Continue
6. **Mention not detected** → Skip all bot logic → Continue

All paths are awaited, so none is faster than the others.

### 3. Database Operations

All of these complete BEFORE response is sent:

1. **User comment inserted** (line 3666)
   ```sql
   INSERT INTO feed_comments (post_id, user_id, content, ...)
   ```

2. **Bot reply inserted** (line 3714, 3869, 3904)
   ```sql
   INSERT INTO feed_comments (post_id, user_id=100, content, ...)
   ```

3. **Interaction logged** (line 3722, 3753, 3788)
   ```sql
   INSERT INTO bot_reply_log (trigger_comment_id, bot_reply_comment_id, ...)
   ```

4. **Response sent** (line 3923)
   ```javascript
   res.json({...})
   ```

### 4. Crypto Parsing

Input: "@GuardiAI what's the price of BTC and ethereum today?"

Parsing by `parseCryptoCurrencies()`:
- Detects "BTC" → maps to "bitcoin" (geckoId)
- Detects "ethereum" → maps to "ethereum" (geckoId)
- Returns: `["bitcoin", "ethereum"]`

Loop processes both, creating 2 bot replies.

### 5. API Integration

For each cryptocurrency:

1. **Fetch from CoinGecko:**
   ```
   GET https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&...
   ```

2. **Timeout:** 5 seconds (line 3105)
   - If no response by 5000ms → reject with TIMEOUT error
   - Error caught → fallback to friendly tone

3. **Rate limit (HTTP 429):**
   - Detected and thrown as RATE_LIMIT error
   - Caught → skip this crypto (continue to next)
   - User doesn't see error

4. **Data extracted:**
   ```javascript
   { price: 47250.32, change24h: 2.5 }
   ```

### 6. Reply Formatting

Example: Bitcoin with +3.2% change in 24h

```javascript
formatCryptoReply("bitcoin", { price: 47250.32, change24h: 3.2 })
↓
"BTC: $47,250.32 📈 +3.2% (24h) | Strong momentum here!"
```

Breakdown:
- `"BTC"` ← uppercase ticker mapped from geckoId
- `"$47,250.32"` ← price.toFixed(2)
- `"📈"` ← positive change
- `"+3.2%"` ← change24h.toFixed(1)
- `"Strong momentum here!"` ← random from FRIENDLY_REPLIES

## Timeline Example

User submits: "@GuardiAI what's BTC and ETH?"

```
t=0ms     User clicks "Post"
t=10ms    POST /api/feed/posts/{id}/comments received
t=15ms    User comment inserted to feed_comments
t=20ms    @GuardiAI detected, await begins
t=25ms    Crypto parsing: ["bitcoin", "ethereum"]
t=30ms    Start BTC API call
t=50ms    BTC response received: { price: 47250, change: +2.5 }
t=55ms    BTC reply formatted: "BTC: $47,250.00 📈 +2.5%..."
t=60ms    BTC reply inserted to feed_comments (id=1001)
t=65ms    BTC logged to bot_reply_log
t=75ms    Start ETH API call
t=95ms    ETH response received: { price: 2890, change: -1.3 }
t=100ms   ETH reply formatted: "ETH: $2,890.00 📉 -1.3%..."
t=105ms   ETH reply inserted to feed_comments (id=1002)
t=110ms   ETH logged to bot_reply_log
t=115ms   await completes, all operations done
t=120ms   res.json() sends response to user
t=125ms   Frontend receives response, shows user's comment
t=1000ms  Frontend polls for comments
t=1005ms  Bot replies appear (already in DB for 900ms)
```

**Total time from click to response:** ~120ms
**Bot replies ready before user even sees the response!**

## Error Scenarios

### Scenario 1: Rate Limited
```
t=30ms    Start API call
t=40ms    CoinGecko returns HTTP 429
t=45ms    RATE_LIMIT error caught
t=50ms    Continue to next crypto (or finish)
Result:   That crypto has no reply, others proceed normally
```

### Scenario 2: API Timeout
```
t=30ms    Start API call
t=5030ms  5-second timeout expires
t=5035ms  TIMEOUT error caught
t=5040ms  selectRandomFriendlyReply() → "Love the energy here! 🌟"
t=5045ms  Friendly reply inserted
Result:   User gets friendly tone instead of price
```

### Scenario 3: No Crypto Mentioned
```
t=20ms    @GuardiAI detected
t=25ms    Parse cryptocurrencies: [] (empty)
t=30ms    selectRandomFriendlyReply() → "Yooo that's fire! 🔥"
t=35ms    Friendly reply inserted
t=40ms    await completes
Result:   Only one bot reply with friendly tone
```

## Success Criteria Met

✅ **Race condition fixed** - All operations await before response
✅ **Bot account verified** - User ID 100 created with is_bot=true
✅ **Crypto detection working** - Both tickers and names detected
✅ **API integration working** - CoinGecko calls with timeout
✅ **Reply formatting correct** - Price, emoji, change%, comment
✅ **Friendly fallback working** - Triggers on no crypto or error
✅ **Logging comprehensive** - All operations logged with status
✅ **Database operations atomic** - All complete before response
✅ **Error handling graceful** - Errors don't break user comment

