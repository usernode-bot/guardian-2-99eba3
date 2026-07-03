# Guardian Duplicate Message Detection Test Report

## Overview

This document describes the duplicate message detection flow in Guardian and how to test it. The system automatically detects when the same message is sent twice within 2 minutes and returns the existing transaction instead of creating a duplicate.

## What Gets Detected as Duplicate

A message is considered a **duplicate** when:
- Same user attempts to send a message
- Message content is identical (same content hash)
- Duplicate attempt occurs within **2 minutes** of the original
- Message type is the same (text, image, token)

## How Duplicate Detection Works

### 1. Content Hashing
When a message is sent, the system computes a SHA-256 hash of the message content:

```javascript
// Frontend: computeContentHash(content)
const contentHash = crypto.SHA256(JSON.stringify(content)).toString();
```

### 2. Server-Side Duplicate Check
Before creating a new message, the server queries the `blockchain_audit_logs` table:

```sql
SELECT id, tx_hash, created_at FROM blockchain_audit_logs
WHERE user_id = $1
  AND message_type = $2
  AND content_hash = $3
  AND created_at > NOW() - INTERVAL '2 minutes'
ORDER BY created_at DESC
LIMIT 1
```

### 3. Reusing Existing Transaction
If a duplicate is found:
- **No new message record is created** in the database
- **No new audit log is created**
- **No new blockchain transaction is submitted**
- The **existing audit log ID** is returned to the frontend
- The **same TX hash** is reused for polling confirmation

### 4. Frontend Handling
When the frontend receives a duplicate response:
```json
{
  "id": 0,
  "createdAt": "2026-07-03T...",
  "blockchainRecordingId": 12345,
  "isDuplicate": true,
  "existingTxHash": "ut1...",
  "note": "Transaction already recorded - previous attempt succeeded despite timeout error"
}
```

The frontend:
- Shows toast: `"✓ Message already sent—reusing existing transaction"`
- Logs to console: `[MESSAGE] Duplicate detected! Reusing existing auditLogId: 12345`
- Shows persistent notification with the existing blockchain recording ID
- Resumes polling for the existing transaction

## Test Scenario: Send Same Message Twice

### Setup
1. Navigate to `/` (home page)
2. Select a conversation or group
3. Ensure you have a message input field ready

### Step-by-Step Test

#### Phase 1: Send First Message
1. Type: `Hello World Test` in the message input
2. Click Send
3. Wallet signature dialog appears (in demo mode, auto-confirms)
4. Observe:
   - ✓ Toast: `"Message sent—confirming on-chain"`
   - ✓ Persistent notification appears with "⏱ Pending..." status
   - ✓ Browser console logs: `[MESSAGE] Message sent successfully, txHash=...`
   - ✓ Server logs show: `[MESSAGE] Created new message, messageId=...`
5. **Record the txHash** from server logs (format: `ut1...`)
6. **Record the auditLogId** from the persistent notification or server logs

#### Phase 2: Send Identical Message Within 2 Minutes
1. Type: `Hello World Test` again (exactly the same)
2. Click Send immediately
3. Wallet signature dialog appears
4. Sign the transaction
5. Observe the **duplicate detection trigger**:
   - ✓ Server console logs show:
     ```
     🔄 [DUPLICATE DETECTED] ========================================
        User: <your_username> (123)
        Content Hash: <same_hash_as_before>
        Existing Audit ID: <same_as_before>
        Existing TX Hash: ut1...
        Time Since First Attempt: ~3000ms (or similar)
        Action: Reusing existing transaction instead of creating duplicate
     ============================================================
     ```
   - ✓ Toast shows: `"✓ Message already sent—reusing existing transaction"`
   - ✓ Browser console logs: `[MESSAGE] Duplicate detected! Reusing existing auditLogId: 12345`
   - ✓ **No new message appears in the conversation** (because no new message was created)
   - ✓ **Same auditLogId** is returned as the first message
   - ✓ **Same txHash** is used for polling

#### Phase 3: Verify Network Logs
Open browser DevTools → Network tab and look for two requests to `/api/conversations/<id>/messages`:

**First request:**
```json
Request body:
{
  "type": "text",
  "content": {"text": "Hello World Test"},
  "txHash": "ut1...",
  "auditLogId": 123
}

Response:
{
  "id": 999,
  "createdAt": "2026-07-03T...",
  "blockchainRecordingId": 123,
  "isDuplicate": false
}
```

**Second request (same content):**
```json
Request body:
{
  "type": "text",
  "content": {"text": "Hello World Test"},
  "txHash": "ut1...",
  "auditLogId": 456  // Different attempt, same content
}

Response:
{
  "id": 0,
  "createdAt": "2026-07-03T...",
  "blockchainRecordingId": 123,  // ← SAME as first attempt
  "isDuplicate": true,           // ← Duplicate flag set
  "existingTxHash": "ut1...",    // ← Same hash
  "note": "Transaction already recorded..."
}
```

#### Phase 4: Verify SessionStorage State
Open browser DevTools → Application → Storage → Session Storage:

Look for key matching pattern `message_polling_<auditLogId>`:
- **First send:** New entry created for the audit log
- **Second send (duplicate):** Same entry is reused; no new entry created

### Expected Outcomes

✅ **Duplicate correctly detected** when:
- Same content is sent
- Within 2-minute window
- By the same user

✅ **Transaction is reused** (same txHash):
- Prevents multiple blockchain submissions
- Reduces network traffic
- Avoids wasting blockchain resources

✅ **User sees clear feedback**:
- Toast notification distinguishes duplicate from new send
- Persistent notification tracks the single transaction
- Console logs show duplicate detection with audit ID

✅ **No conversation duplication**:
- Only one message appears in the conversation view
- Both send attempts return the same blockchain recording ID

## Negative Test: Different Messages Not Detected as Duplicate

### Test
1. Send: `Hello World Test`
2. Send: `Hello World Test!!` (even slightly different)
3. Send: `Hello World` (shorter version)
4. Send: `Hello World Test` but after 2+ minutes

### Expected Result
✗ These should **NOT** be detected as duplicates:
- Each creates its own audit log
- Each has its own txHash
- Each shows "Message sent—confirming on-chain" (not "already sent")
- Each message appears in the conversation view

## SessionStorage and Polling Behavior

When duplicate is detected:
- Frontend does NOT store a new polling session in sessionStorage
- Frontend resumes polling the EXISTING session if not already complete
- If the transaction is already confirmed, polling is skipped
- If the transaction timed out, polling can be resumed with "Check Now" button

## Browser Console Observations

### First Message
```
[MESSAGE] Message sent successfully
[MESSAGE] Wallet signature obtained: ut1abcd...
[MESSAGE] TX Hash registered with backend: ut1abcd...
[MESSAGE] Starting polling for transaction ut1abcd...
[POLLING] Attempt 1/600: Status pending
[POLLING] Attempt 2/600: Status confirmed ✓
```

### Second Message (Duplicate)
```
[MESSAGE] Message sent successfully
[MESSAGE] Wallet signature obtained: ut1abcd... (same wallet)
[MESSAGE] TX Hash registered with backend: ut1abcd... (same hash attempted)
[MESSAGE] Duplicate detected! Reusing existing auditLogId: 123
[MESSAGE] Skipping duplicate polling, existing transaction will be tracked
```

## Database Verification

To verify duplicate detection at the database level:

```sql
-- Check audit logs for the test content
SELECT id, user_id, message_type, content_hash, tx_hash, status, created_at
FROM blockchain_audit_logs
WHERE user_id = <your_user_id>
ORDER BY created_at DESC
LIMIT 2;

-- Expected: Two rows with same content_hash, first created ~2-3 seconds before second
-- The second row should not exist in messages table (duplicate prevention)
```

## Timing Considerations

- **Duplicate window:** 2 minutes from first send
- **After 2 minutes:** Same content is treated as a new message (creates new audit log)
- **Content hash computation:** Milliseconds (uses SHA-256)
- **Duplicate check query:** ~10-50ms (database index on user_id + message_type + content_hash)

## Performance Impact

- **Before duplicate fix:** Duplicate sends created 2 transactions in blockchain
- **After duplicate fix:** Duplicate sends reuse 1 transaction
- **Network savings:** ~50% reduction in blockchain RPC calls for retry scenarios
- **User experience:** Faster second-send feedback (no wallet signature needed if session detected, returns immediately)

## Known Limitations

1. **Timing dependency:** Detection depends on content hash match — order of fields matters for objects
2. **Session timeout:** If the first transaction times out, duplicate detection may not help (polling still needed)
3. **Cross-device:** Duplicate detection is per-browser-session; resending on different device/browser will not detect as duplicate
4. **Type specificity:** Different message types (text vs image) with same content are NOT considered duplicates

## Testing Checklist

- [ ] Send message twice with identical content within 2 minutes
- [ ] Verify duplicate detected via server console logs
- [ ] Verify toast shows "already sent" message
- [ ] Verify same auditLogId returned
- [ ] Verify same txHash reused
- [ ] Check network logs show `isDuplicate: true` in response
- [ ] Verify no duplicate message appears in conversation view
- [ ] Check sessionStorage shows same polling session (not new one)
- [ ] Verify browser console logs show duplicate detection
- [ ] Test that different content is NOT detected as duplicate
- [ ] Test that duplicate after 2+ minutes is NOT detected
- [ ] Verify "Check Now" button works for the duplicate's transaction
- [ ] Verify persistent notification tracks the correct transaction

## Related Code

**Frontend files:**
- `/public/index.html` lines 5763-5791 (sendMessage with duplicate detection feedback)
- `/public/index.html` lines 5750-5761 (message send flow)
- `/public/index.html` lines 4216-4350 (pollTransactionConfirmation)

**Server files:**
- `/server.js` lines 2206-2231 (duplicate detection query and response)
- `/server.js` lines 2200-2210 (content hash computation)
- `/server.js` lines 2233-2260 (atomic message + audit log insertion)

## Debugging Tips

If duplicate detection isn't working:

1. **Check content hash computation:**
   ```javascript
   // Frontend: verify content is being hashed correctly
   const test = { text: "Hello World" };
   console.log(crypto.SHA256(JSON.stringify(test)).toString());
   ```

2. **Check database state:**
   ```sql
   -- Verify audit logs exist
   SELECT * FROM blockchain_audit_logs WHERE user_id = X ORDER BY created_at DESC;
   ```

3. **Check server logs:**
   - Look for `[DUPLICATE DETECTED]` block
   - If not present, content hash mismatch (check content ordering)

4. **Check timing:**
   - Ensure second send is within 2 minutes of first
   - Check timestamps in database: `created_at` values

5. **Check authentication:**
   - Ensure same user is sending both messages
   - Check `user_id` in browser console vs database

