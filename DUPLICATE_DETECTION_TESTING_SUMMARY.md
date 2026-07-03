# Duplicate Message Detection - Testing Summary

## Quick Start Testing

### Test 1: Send Same Message Twice (Within 2 Minutes)

**Goal:** Verify that sending identical message twice detects duplicate and reuses transaction.

**Steps:**
1. Navigate to home page (`/`)
2. Select a conversation
3. Type: `Test duplicate message`
4. Click Send
5. Wait for wallet signature dialog and sign (or watch auto-confirm in demo mode)
6. **Record the txHash from browser console** (look for `ut1...` format)
7. **Record the auditLogId** from the persistent notification
8. Type the exact same text: `Test duplicate message`
9. Click Send again immediately
10. Sign wallet signature dialog

**What You Should See:**
- ✅ First send: "✓ Message sent—confirming on-chain"
- ✅ Second send: "✓ Message already sent—reusing existing transaction" (different toast)
- ✅ Server console shows: `🔄 [DUPLICATE DETECTED]` block with:
  - Existing Audit ID (same as first send)
  - Existing TX Hash (same as first send)
  - Time since first attempt (~2-5 seconds)
- ✅ Browser console: `[MESSAGE] Duplicate detected! Reusing existing auditLogId: 123`
- ✅ Only ONE message appears in conversation view
- ✅ Both sends track same blockchain transaction

**Network Log Check:**
```json
// First POST /api/conversations/.../messages
Response: { isDuplicate: false, blockchainRecordingId: 123 }

// Second POST /api/conversations/.../messages
Response: { isDuplicate: true, blockchainRecordingId: 123 } ← SAME ID
```

---

### Test 2: Different Messages NOT Detected as Duplicates

**Goal:** Verify that different content creates separate transactions.

**Steps:**
1. Send: `Test message A`
2. Send: `Test message B`
3. Send: `Test message A` (same as first, but after time passes)

**Expected Result:**
- Each creates its own audit log
- Each shows "confirming on-chain" (NOT "already sent")
- Each message appears in conversation
- No "DUPLICATE DETECTED" in server logs

---

### Test 3: Duplicate Detected Only Within 2-Minute Window

**Goal:** Verify time limit on duplicate detection.

**Steps:**
1. Send: `Time window test`
2. Wait 2 minutes 1 second
3. Send: `Time window test` (identical content)

**Expected Result:**
- Should NOT be detected as duplicate
- Shows "confirming on-chain" 
- Creates new audit log
- New message appears in conversation

---

## Implementation Verification

### Server-Side Duplicate Check (Lines 2206-2231 in server.js)

```sql
SELECT id, tx_hash, created_at FROM blockchain_audit_logs
WHERE user_id = $1
  AND message_type = $2
  AND content_hash = $3
  AND created_at > NOW() - INTERVAL '2 minutes'
ORDER BY created_at DESC
LIMIT 1
```

**Criteria:**
- ✅ Same user (user_id)
- ✅ Same message type (message_type)
- ✅ Same content hash (content_hash) via SHA-256
- ✅ Within 2-minute window (created_at check)

### Frontend Duplicate Handling (Lines 5763-5791 in index.html)

```javascript
if (data.isDuplicate) {
  console.log('[MESSAGE] Duplicate detected! Reusing existing auditLogId:', data.blockchainRecordingId);
  showToast(`✓ Message already sent—reusing existing transaction`, 'info');
}
```

**Feedback:**
- ✅ Toast distinguishes duplicate from normal send
- ✅ Console logs show detection with audit ID
- ✅ Persistent notification shows same blockchain recording ID

### Message-Level Duplicate Lock (Lines 5725-5740 in index.html)

```javascript
let sendingMessageForConversation = new Set();

// Prevents: User clicks Send → wallet dialog → user clicks again
const convKey = currentGroupId ? `group-${currentGroupId}` : `conv-${currentConvId}`;
if (sendingMessageForConversation.has(convKey)) return;
sendingMessageForConversation.add(convKey);
```

**Purpose:** Prevents UI-level duplicate clicks while server handles race conditions.

---

## Browser Console Observations

### First Message Send
```
[MESSAGE] Message sent successfully
[MESSAGE] Wallet signature obtained: ut1abc123...
[MESSAGE] TX Hash registered with backend: ut1abc123...
[POLLING] Starting polling for transaction ut1abc123...
[POLLING] Attempt 1/600: Status pending
[POLLING] Attempt 2/600: Status confirmed ✓
```

### Second Message Send (Duplicate)
```
[MESSAGE] Message sent successfully
[MESSAGE] Wallet signature obtained: ut1abc123... ← might differ
[MESSAGE] TX Hash registered with backend: ut1abc123...
[MESSAGE] Duplicate detected! Reusing existing auditLogId: 123 ← KEY LINE
[POLLING] Skipping duplicate polling, existing transaction will be tracked
```

---

## Database Verification

### Query to Check Duplicate Detection

```sql
SELECT 
  id,
  user_id,
  message_type,
  content_hash,
  tx_hash,
  status,
  created_at
FROM blockchain_audit_logs
WHERE user_id = 123  -- Your user ID
ORDER BY created_at DESC
LIMIT 5;
```

**Expected for duplicate test:**
- Two rows with same `content_hash`
- Same `user_id`
- Same `message_type` ('message')
- DIFFERENT `tx_hash` values (both valid)
- Second row has slightly later `created_at`

```sql
-- Check messages table (should have only 1 message)
SELECT id, sender_id, content, created_at
FROM messages
WHERE sender_id = 123
  AND content LIKE '%Test duplicate%'
ORDER BY created_at DESC;
-- Result: 1 row (not 2, even though sent twice)
```

---

## Key Testing Points

| Check | Expected | Why It Matters |
|-------|----------|-----------------|
| Same `blockchainRecordingId` on second send | ✅ True | Proves duplicate detected |
| `isDuplicate: true` in response | ✅ True | Frontend shows correct toast |
| Only 1 message in conversation | ✅ True | No duplicate displayed |
| No new TX on blockchain | ✅ True | Network efficiency |
| Console: "Duplicate detected!" | ✅ Logged | Debugging support |
| Server: "[DUPLICATE DETECTED]" block | ✅ Visible | Transaction tracing |
| Different content creates new message | ✅ True | Deduping works correctly |
| After 2 minutes = no duplicate | ✅ True | Time window enforced |

---

## Performance Impact

### RPC Calls Reduction

**Scenario:** User sends message → wallet times out → user retries within 2 minutes

**Before fix:**
- 1st attempt: blockchain RPC call + polling (600 attempts max)
- 2nd attempt: blockchain RPC call + polling (600 attempts max)
- **Total: 2 blockchain submissions** ❌

**After fix:**
- 1st attempt: blockchain RPC call + polling (600 attempts max)
- 2nd attempt: detected as duplicate, same transaction reused
- **Total: 1 blockchain submission** ✅

**Network savings:** ~50% RPC traffic reduction for retry scenarios.

---

## Troubleshooting

### "Not showing duplicate detection"

**Check these:**
1. Content is exactly identical (including whitespace)
2. Second send is within 2 minutes of first
3. Same user sending both messages
4. Server logs show the database query executed
5. Content hash matches (check server logs for hash value)

### "Shows duplicate but message appears twice"

**Cause:** Race condition between duplicate check and message insertion.
**Fix:** Check atomic transaction is working (BEGIN...COMMIT).

### "Different messages treated as duplicate"

**Cause:** Content hash mismatch or JSON stringification order.
**Debug:** Compare hashes in server logs for both messages.

---

## Files to Review

1. **server.js:**
   - Lines 2206-2231: Duplicate detection query and response
   - Lines 2218-2231: Duplicate response JSON structure
   - Grep: `DUPLICATE DETECTED` for console output

2. **public/index.html:**
   - Lines 5725-5740: Frontend send lock (per-conversation)
   - Lines 5763-5791: Duplicate handling with isDuplicate check
   - Grep: `isDuplicate` for all detection points

3. **Documentation:**
   - `DUPLICATE_DETECTION_FLOW.md`: Complete flow diagrams
   - `DUPLICATE_DETECTION_TEST.md`: Detailed test procedures
   - `DUPLICATE_DETECTION_TESTING_SUMMARY.md`: This file

---

## Test Checklist for Reviewers

- [ ] Send message twice with identical content
- [ ] Verify "already sent" toast appears on second send
- [ ] Check server console shows `[DUPLICATE DETECTED]` block
- [ ] Confirm `isDuplicate: true` in network response
- [ ] Verify same `blockchainRecordingId` returned
- [ ] Check only 1 message appears in conversation
- [ ] Verify different content creates separate messages
- [ ] Test that duplicate after 2+ minutes creates new message
- [ ] Monitor network panel for `isDuplicate` response field
- [ ] Check browser console for duplicate detection log
- [ ] Query database to verify no duplicate audit logs
- [ ] Verify persistent notification tracks correct transaction

---

## Related Commits

This duplicate detection enhancement is part of:
- Previous 8 critical fixes (polling resume, wallet validation, etc.)
- Enhanced logging for debugging
- `isDuplicate` flag for clear frontend distinction
- `existingTxHash` for transaction tracing

