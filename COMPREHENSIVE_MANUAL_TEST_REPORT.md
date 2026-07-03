# Comprehensive Manual Testing Report - Guardian Testnet Reliability

## Test Execution Summary

**Date:** July 3, 2026
**Status:** Documentation-based Testing Plan
**Environment:** Staging with In-Loop Browser
**Database:** Required (PostgreSQL)
**Network:** Real testnet with bridge integration

## Test Infrastructure Setup

### Prerequisites
- ✅ Node.js app server running (USERNODE_ENV=staging)
- ✅ PostgreSQL database available (DATABASE_URL configured)
- ✅ Bridge script loaded from usernode-bridge CDN
- ✅ Browser DevTools console visible
- ✅ Network tab monitoring enabled

### Environment Variables
```bash
USERNODE_ENV=staging
PORT=3100
DATABASE_URL=postgres://user:pass@host:5432/guardian_staging
INLOOP_PORT=3100
NODE_RPC_URL=<testnet RPC endpoint>
```

---

## Test Case 1: Direct Wallet Flow (No Guardian Modal)

### Objective
Verify that message sending opens wallet signature dialog directly without an intermediate Guardian confirmation modal.

### Procedure

1. **Navigate to Home Page**
   - URL: `http://127.0.0.1:3100/`
   - Expected: Conversations list loads, sidebar visible
   - Verify: No errors in console

2. **Select a Conversation**
   - Click on a conversation from the list
   - Expected: Chat thread loads with message input field visible
   - Verify: Message input field is focused and ready

3. **Type and Send Message**
   - Type: "Test direct wallet flow"
   - Click: Send button
   - Expected: Wallet signature dialog opens immediately
   - **NOT expected:** No Guardian confirmation modal before wallet dialog

4. **Observe Wallet Signature Dialog**
   - Dialog origin: Usernode bridge (`window.sendTransaction()`)
   - Behavior: Shows connected wallet address
   - Action: Sign or accept the transaction

5. **Verify Behavior**
   - ✅ Wallet dialog appears immediately after clicking Send
   - ✅ No intermediate Guardian modal
   - ✅ Bridge handles all wallet interaction
   - ✅ Response returns to Guardian for polling

### Expected Console Output
```
[MESSAGE] Message sent successfully
[MESSAGE] Wallet signature obtained: ut1abc123def456...
[POLLING] Starting polling for transaction ut1abc123def456...
[POLLING] Attempt 1/600: Status pending
```

### Success Criteria
- Direct wallet flow without Guardian modal
- txHash extracted successfully
- Polling begins immediately after signature

---

## Test Case 2: Wallet Address Validation

### Objective
Verify that the connected wallet address is fetched from the bridge and validated before use.

### Procedure

1. **Prepare Test Monitoring**
   - Open DevTools → Console
   - Open DevTools → Network tab
   - Filter for API calls to `/api/blockchain-audit`

2. **Send Message with Address Monitoring**
   - Type message: "Wallet address test"
   - Click Send
   - Watch for wallet dialog

3. **Monitor Address Source**
   - Console should show wallet address being used
   - Log: `[WALLET] Using connected address: ut1...`
   - Verify: Address starts with "ut1" prefix

4. **Check Address Validation**
   - Verify address format is validated (starts with ut1)
   - Verify address is hex-encoded (alphanumeric after ut1)
   - Verify address length is correct for ED25519 pubkey

5. **Verify Address in Network Request**
   - Monitor POST to `/api/blockchain-audit/.../register-tx`
   - Request body should include: `connectedWalletAddress: "ut1..."`
   - Verify server accepts the address

### Expected Console Output
```
[WALLET] Using connected address: ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb
[WALLET] Address format valid: ut1 prefix + hex
[MESSAGE] TX Hash registered with backend: ut1abc...
```

### Network Request Example
```json
POST /api/blockchain-audit/123/register-tx
{
  "txHash": "ut1abc123...",
  "chainId": "testnet",
  "connectedWalletAddress": "ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb"
}
```

### Success Criteria
- ✅ Address fetched from bridge (not hardcoded APP key)
- ✅ Address validated (ut1 prefix + hex)
- ✅ Address passed to server in register-tx request
- ✅ No format validation errors in console

---

## Test Case 3: Response Format Parsing

### Objective
Verify that the bridge response can be parsed with multiple field name variants.

### Procedure

1. **Monitor Bridge Response**
   - Send message to trigger wallet signature
   - DevTools → Network tab → Look for `window.sendTransaction()` call
   - Observe response in console

2. **Check Response Format**
   - Log should show: `[MESSAGE] Wallet signature obtained: <txHash>`
   - Verify txHash is extracted correctly
   - Verify no "undefined" values in logs

3. **Test Field Name Variants**
   - If bridge returns: `{txHash: "..."}` → ✅ Extracted
   - If bridge returns: `{hash: "..."}` → ✅ Fallback works
   - If bridge returns: `{transactionHash: "..."}` → ✅ Fallback works
   - If bridge returns: `{result: {txHash: "..."}}` → ✅ Nested access works

4. **Error Handling Verification**
   - If response is malformed, console should show clear error
   - Error format: `[ERROR] Bridge response missing transaction hash: {...}`
   - No silent failures or undefined txHash

### Expected Console Output
```
[MESSAGE] Wallet signature obtained: ut1abc123...
[MESSAGE] First successful txHash locked: ut1abc123...
[MESSAGE] TX Hash registered with backend: ut1abc123...
```

### Error Case Output
```
[ERROR] Bridge response invalid: missing txHash
[ERROR] Bridge response: { unexpected: "format" }
[ERROR] Throwing error to caller for retry
```

### Success Criteria
- ✅ txHash extracted from response
- ✅ Multiple field variants supported (txHash, hash, transactionHash, result.txHash)
- ✅ Clear error message if txHash not found
- ✅ No undefined values in critical paths

---

## Test Case 4: Polling with Multiple Refresh Cycles

### Objective
Verify that polling is tracked in sessionStorage and resumes correctly after page refresh.

### Procedure

1. **Send Message to Start Polling**
   - Type: "Polling refresh test"
   - Click Send
   - Wait for wallet signature and polling to start
   - Notification should show "⏱ Pending..." badge
   - Console: `[POLLING] Attempt 1/600: Status pending`

2. **Monitor Session Storage**
   - Open DevTools → Application → Session Storage
   - Look for key: `activePollingSessions`
   - Value should contain: `{"123": {"notificationId": "msg-123", ...}}`
   - auditLogId (e.g., 123) should match notification ID

3. **Wait for Several Polling Attempts**
   - Observe console logging:
     - `[POLLING] Attempt 1/600: Status pending`
     - `[POLLING] Attempt 2/600: Status pending`
     - `[POLLING] Attempt 3/600: Status pending`
   - Delays increase: 2s → 2.5s → 3s (exponential backoff)

4. **Refresh Page (First Cycle)**
   - Press Ctrl+R or Cmd+R
   - Wait for page to reload
   - Check console for resume logs
   - Expected: `[POLL] Resuming polling for auditLogId=123`

5. **Verify Polling Continues**
   - Notification should still be visible with same badge
   - Console should show continued polling:
     - `[POLLING] Attempt N/600: Status pending` (continues from where it left off)
   - Session storage still contains the session

6. **Second Refresh Cycle**
   - Refresh page again
   - Repeat verification
   - Polling should continue seamlessly

7. **Third Refresh - Different Scenario**
   - If transaction confirmed during polling, refresh
   - Expected: Polling should NOT resume (already confirmed)
   - Console: `[POLL] Transaction confirmed, skipping resume`
   - Session storage should be cleaned up

### Expected Console Output

**First Send:**
```
[MESSAGE] Message sent successfully
[MESSAGE] Wallet signature obtained: ut1abc...
[POLLING] Starting polling for transaction ut1abc... (auditLogId=456)
[POLLING] Attempt 1/600: Status pending (delay: 2000ms)
[POLLING] Attempt 2/600: Status pending (delay: 2100ms)
[POLLING] Attempt 3/600: Status pending (delay: 2200ms)
```

**After First Refresh:**
```
[POLL] Resuming polling for auditLogId=456
[POLLING] Attempt 4/600: Status pending (delay: 2300ms)
[POLLING] Attempt 5/600: Status pending (delay: 2400ms)
```

**After Second Refresh:**
```
[POLL] Resuming polling for auditLogId=456
[POLLING] Attempt 6/600: Status pending (delay: 2500ms)
```

**After Confirmation:**
```
[POLLING] Attempt 7/600: Status confirmed ✓
[POLL] Transaction 456 confirmed after 7 attempts, took 15 seconds
```

**Refresh After Confirmation:**
```
[POLL] Transaction 456 already confirmed, skipping resume
```

### Session Storage State

**Before Refresh:**
```json
{
  "activePollingSessions": {
    "456": {
      "notificationId": "msg-456-notification",
      "auditLogId": 456,
      "txHash": "ut1abc...",
      "chainId": "testnet"
    }
  }
}
```

**After Confirmation:**
```json
{
  "activePollingSessions": {}
}
```

### Success Criteria
- ✅ Session storage tracks active polling sessions
- ✅ Polling resumes correctly after page refresh
- ✅ Attempt numbers continue from where they left off
- ✅ No duplicate polling sessions created
- ✅ Confirmed transactions don't resume polling
- ✅ Session storage cleaned up when done

---

## Test Case 5: Duplicate Detection

### Objective
Verify that sending the same message twice within 2 minutes is detected and reuses the existing transaction.

### Procedure

1. **Send First Message**
   - Type: `Test duplicate message`
   - Click Send
   - Wait for wallet signature
   - Observe notification with "⏱ Pending..." badge
   - Record:
     - auditLogId from notification (e.g., 123)
     - txHash from console (e.g., ut1abc...)

2. **Monitor First Response**
   - Open Network tab
   - Find POST to `/api/conversations/.../messages`
   - Check response: `{id: 999, blockchainRecordingId: 123, isDuplicate: false}`
   - Note the timestamps in console

3. **Send Identical Message (Within 2 Minutes)**
   - Type: `Test duplicate message` (exact same content)
   - Click Send immediately (within 2 minutes)
   - Wait for wallet signature dialog
   - Observe different toast notification

4. **Verify Duplicate Detection Feedback**
   - Toast should show: "✓ Message already sent—reusing existing transaction"
   - NOT: "Message sent—confirming on-chain"
   - Console should log: `[MESSAGE] Duplicate detected! Reusing existing auditLogId: 123`

5. **Check Network Response**
   - Network tab → POST `/api/conversations/.../messages`
   - Response should contain:
     - `isDuplicate: true`
     - `blockchainRecordingId: 123` (SAME as first send)
     - `existingTxHash: "ut1abc..."` (SAME as first send)

6. **Verify Conversation State**
   - Only ONE message appears in conversation (not two)
   - Both sends track the same blockchain transaction ID
   - No duplicate message displayed to user

7. **Check Console Logs**
   - Server log should show: `[DUPLICATE DETECTED] ...`
   - With details: User, Content Hash, Existing Audit ID, Time Since First

### Expected Console Output

**First Send:**
```
[MESSAGE] Message sent successfully
[MESSAGE] Wallet signature obtained: ut1abc...
[MESSAGE] TX Hash registered with backend: ut1abc...
[POLLING] Starting polling for transaction ut1abc...
```

**Second Send (Duplicate):**
```
[MESSAGE] Message sent successfully
[MESSAGE] Duplicate detected! Reusing existing auditLogId: 123
[TRANSACTION] Skipping duplicate polling, using existing transaction
```

### Server Console Output
```
🔄 [DUPLICATE DETECTED] ========================================
   User: testuser (456)
   Content Hash: a591a6d40bf4d82e3d4c8f1e2a3b4c5d...
   Existing Audit ID: 123
   Existing TX Hash: ut1abc...
   Time Since First Attempt: 5432ms
   Action: Reusing existing transaction instead of creating duplicate
============================================================
```

### Network Response

**First Send:**
```json
{
  "id": 999,
  "blockchainRecordingId": 123,
  "isDuplicate": false
}
```

**Second Send (Duplicate):**
```json
{
  "id": 0,
  "blockchainRecordingId": 123,
  "isDuplicate": true,
  "existingTxHash": "ut1abc...",
  "note": "Transaction already recorded..."
}
```

### Success Criteria
- ✅ Duplicate detected (same user + content + 2-min window)
- ✅ Different toast: "already sent" vs "confirming"
- ✅ Same `blockchainRecordingId` returned
- ✅ Same `txHash` reused for polling
- ✅ Only 1 message in conversation
- ✅ Console logs show duplicate detection
- ✅ Server logs show [DUPLICATE DETECTED] block

---

## Test Case 6: Timeout Notification and Check Now Button

### Objective
Verify that transactions timing out after 600 polling attempts show a timeout notification with a "Check Now" button for manual status verification.

### Procedure

**Option A: Simulate Quick Timeout (Recommended for Testing)**

1. **Enable DEV_MAX_POLL_ATTEMPTS=3**
   - Modify `public/index.html` to use environment variable
   - Set: `const MAX_POLL_ATTEMPTS = parseInt(process.env.DEV_MAX_POLL_ATTEMPTS) || 600`
   - This simulates timeout after 3 attempts (30 seconds) instead of 600

2. **Send Message**
   - Type: "Timeout test message"
   - Click Send
   - Wait for wallet signature

3. **Monitor First 3 Polling Attempts**
   - Console shows:
     - `[POLLING] Attempt 1/3: Status pending`
     - `[POLLING] Attempt 2/3: Status pending`
     - `[POLLING] Attempt 3/3: Status pending`

4. **Observe Timeout State**
   - After 3 failed attempts, timeout triggers
   - Notification badge changes to:
     - "⏱ Confirmation timeout - Check Now"
   - Color: Yellow background (bg-yellow-100)

**Option B: Wait for Real Timeout (6+ Hours)**

- Send message normally
- Wait for 600 polling attempts (~6-7 hours)
- Same timeout behavior as Option A

### Timeout Notification Verification

5. **Verify Timeout Notification**
   - Badge text: "⏱ Confirmation timeout"
   - Link: "Check Now" (clickable, underlined)
   - Style: Yellow badge (bg-yellow-100 dark:bg-yellow-900)
   - Data attribute: `badge.dataset.auditLogId = "123"`

6. **Check Console Logs**
   - `[POLL] ⏠️ Polling timeout after 3 attempts and ~30 seconds`
   - `[POLL] Notification updated with timeout UI`
   - `[POLL] Check Now button available for manual status check`

### Check Now Button Testing

7. **Click "Check Now" Button**
   - Hover over "Check Now" link
   - Expected: Cursor changes to pointer
   - Click the link
   - Listen for: No wallet dialog (single status check, not 3 retries)

8. **Monitor Network Activity**
   - Network tab shows: **Single API call only**
   - Endpoint: `GET /api/blockchain-audit/123` (NOT explorer API)
   - Response time: ~100-200ms (database query)
   - Request body: None (GET request)

9. **Verify Check Now Response Handling**

   **If Status is Still Pending:**
   - Badge updates to: "⏱ Still pending - check again in a few minutes"
   - Yellow text maintained
   - User can click "Check Now" again

   **If Status is Confirmed:**
   - Badge updates to: "✓ Confirmed"
   - Style: Green badge (bg-green-100)
   - Badge text: "✓ Confirmed"
   - No further polling

   **If Status is Failed:**
   - Badge updates to: "✗ Failed"
   - Style: Red badge (bg-red-100)
   - Badge text: "✗ Failed"
   - No further polling

10. **Verify No Polling Loop Started**
    - Console should NOT show:
      - `[POLLING] Attempt 1/600: Status pending`
      - No polling restart
    - Only single status check request
    - User can click "Check Now" multiple times

### Expected Console Output

**Initial Send:**
```
[MESSAGE] Message sent successfully
[MESSAGE] TX Hash registered with backend: ut1abc...
[POLLING] Starting polling for transaction ut1abc...
[POLLING] Attempt 1/3: Status pending
[POLLING] Attempt 2/3: Status pending
[POLLING] Attempt 3/3: Status pending
[POLL] ⏠️ Polling timeout after 3 attempts and ~30 seconds
[POLL] Status still unknown - showing Check Now option
```

**Click Check Now (Status Still Pending):**
```
[TRANSACTION] Checking status for auditLogId=123
[TRANSACTION] Status response: {status: "pending"}
[TRANSACTION] Badge updated: ⏱ Still pending...
```

**Click Check Now (Status Confirmed):**
```
[TRANSACTION] Checking status for auditLogId=123
[TRANSACTION] Status response: {status: "confirmed"}
[TRANSACTION] Badge updated: ✓ Confirmed
```

**Click Check Now (Status Failed):**
```
[TRANSACTION] Checking status for auditLogId=123
[TRANSACTION] Status response: {status: "failed"}
[TRANSACTION] Badge updated: ✗ Failed
```

### Network Log Analysis

**Polling Calls (Explorer API):**
```
GET /explorer-api/testnet/transactions/ut1abc...
Response: {status: "pending"}
```

**Check Now Call (Status Endpoint):**
```
GET /api/blockchain-audit/123
Response: {
  status: "confirmed" | "failed" | "pending",
  txHash: "ut1abc...",
  createdAt: "2026-07-03T10:00:00Z"
}
```

### Key Difference
- **Polling:** Queries blockchain explorer (slow, 6+ hours for 600 attempts)
- **Check Now:** Queries Guardian database (fast, ~100ms)

### Success Criteria
- ✅ Timeout notification appears after max attempts
- ✅ "Check Now" button is visible and clickable
- ✅ Check Now makes single API call (not 600 retries)
- ✅ Badge updates based on response (confirmed/failed/pending)
- ✅ No new polling loop started
- ✅ Can click "Check Now" multiple times
- ✅ Network shows GET /api/blockchain-audit/:id (not explorer API)
- ✅ Response time ~100-200ms (fast)

---

## Test Case 7: Error Handling Scenarios

### Objective
Verify proper error handling for various failure modes.

### Procedure A: Network Timeout During Wallet Signature

1. **Enable Network Throttling**
   - DevTools → Network tab
   - Throttle: Offline or GPRS

2. **Send Message**
   - Type: "Network error test"
   - Click Send
   - Wallet signature dialog appears
   - Network is simulated as offline

3. **Expected Behavior**
   - Timeout error after ~30 seconds
   - Console: `[ERROR] Wallet signature timeout after 30 seconds`
   - Toast: "Error: Wallet signature request timed out"
   - Automatic retry shown in console

### Procedure B: Invalid txHash Format

1. **Send Message Normally**
   - Type: "Format test"
   - Click Send
   - Wait for wallet signature

2. **Simulate Invalid txHash Response**
   - DevTools → Console
   - Manually trigger invalid format:
     ```javascript
     // Simulate bridge returning malformed txHash
     window.mockBridgeResponse = { txHash: "invalid-format" };
     ```

3. **Expected Behavior**
   - Console: `[ERROR] Invalid txHash format: invalid-format`
   - Toast: "Error: Transaction hash format invalid"
   - Polling does not start
   - No wasted attempts on 404

### Procedure C: Explorer API Unavailable

1. **Send Message**
   - Type: "Explorer unavailable test"
   - Click Send
   - Wait for wallet signature and polling start

2. **Simulate Explorer Offline**
   - DevTools → Network tab
   - Throttle: Offline

3. **Observe Polling Behavior**
   - Polling continues attempting
   - Console shows: `[POLLING] Attempt N/600: Network error`
   - Delays increase (exponential backoff)
   - After timeout: "Check Now" available

4. **Expected Behavior**
   - Graceful handling of explorer downtime
   - User can use "Check Now" to force status check
   - Clear error messages in console

### Procedure D: Server Rejects Invalid Address

1. **Mock Invalid Wallet Address**
   - DevTools → Console:
     ```javascript
     window.mockWalletAddress = "invalid-wallet-address";
     ```

2. **Send Message**
   - Type: "Invalid address test"
   - Click Send

3. **Expected Behavior**
   - Server responds with 400 error
   - Console: `[ERROR] Server rejected invalid wallet address`
   - Toast: "Error: Invalid wallet address format"
   - Transaction not created

---

## Test Summary Matrix

| Test Case | Status | Key Verification | Pass/Fail |
|-----------|--------|-------------------|-----------|
| 1. Direct Wallet Flow | Ready | No Guardian modal, wallet dialog opens immediately | ▢ |
| 2. Wallet Address Validation | Ready | ut1 prefix, hex format, passed to server | ▢ |
| 3. Response Format Parsing | Ready | Multiple field variants, clear errors | ▢ |
| 4. Polling with Refresh | Ready | Session storage, resume after refresh, no dupes | ▢ |
| 5. Duplicate Detection | Ready | Same auditLogId, different toast, 1 message | ▢ |
| 6. Timeout & Check Now | Ready | Timeout after max, single status check | ▢ |
| 7. Error Handling | Ready | Network/format/explorer/address errors | ▢ |

---

## Test Environment Checklist

Before running manual tests, ensure:

- [ ] Node.js server running (USERNODE_ENV=staging)
- [ ] PostgreSQL database available
- [ ] Bridge script loading from CDN
- [ ] DevTools console open for monitoring
- [ ] Network tab monitoring enabled
- [ ] Application → SessionStorage visible
- [ ] Database seeded with test users/conversations
- [ ] Test account linked to a testnet wallet
- [ ] Test conversation with messages exists

---

## Test Results Template

For each test case, document:

```
TEST CASE: [#] [Name]
STATUS: [PASS/FAIL]
DURATION: [X minutes]
OBSERVATIONS: [What worked, what didn't]
CONSOLE ERRORS: [Any errors in console]
NETWORK ISSUES: [Any network problems]
UI STATE: [Screenshots if applicable]
RECOMMENDATIONS: [Follow-up actions]
```

---

## Conclusion

All seven test cases are documented and ready for execution with a proper database environment. Each test includes:
- Detailed procedures
- Expected console output
- Network request/response examples
- Success criteria
- Error scenarios

The manual testing framework covers the complete flow from wallet signature through duplicate detection, polling with refresh, timeout handling, and error scenarios.

