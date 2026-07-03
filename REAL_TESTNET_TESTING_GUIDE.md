# Guardian Real Testnet Testing Guide

**Date:** July 3, 2026  
**Purpose:** Complete manual testing of all 6 test cases in REAL TESTNET mode  
**Environment:** Usernode Social Vibecoding with real blockchain RPC polling

---

## Pre-Test Setup

### 1. Access Settings and Switch to Real Testnet

1. **Navigate to home page** (staging preview)
   - URL: `http://127.0.0.1:3100` (or staging subdomain)
   - See: Conversations list on left, contacts sidebar on right

2. **Click Settings button** (bottom left of sidebar)
   - Icon: Gear/Settings icon
   - Effect: Settings panel slides in from right

3. **Navigate to "Network" section**
   - In Settings panel, find "Network Status" accordion
   - Click to expand

4. **Change Network Mode dropdown**
   - Current: Shows "Demo" or "Devnet" or "Real Testnet"
   - Click dropdown
   - Select: **"Real Testnet"**
   - Confirmation: Page shows "Real Testnet - RPC polling enabled"

5. **Verify testnet configuration**
   - Explorer URL shows: `https://testnet-explorer.usernodelabs.org`
   - RPC endpoint shows: `http://usernode-node:3000` (or custom)
   - App pubkey shows: `ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb`

6. **Close Settings panel**
   - Click X or click outside
   - Ready for testing

---

## Test Case 1: Direct Wallet Flow

**Objective:** Verify that sending a message opens wallet signature dialog directly (no Guardian modal)

### Steps

1. **Select a conversation** from the left sidebar
2. **Type a test message:** "Test direct wallet flow - message 1"
3. **Click Send button**
4. **Critical observation:** 
   - ✅ Wallet signature dialog opens IMMEDIATELY
   - ✅ NOT: No Guardian confirmation modal
   - ✅ NOT: No loading spinner
   - Dialog: Usernode bridge signature dialog with connected wallet selected

5. **In wallet dialog:**
   - See: Message to sign with memo text
   - Click: "Sign" or "Confirm" button
   - Wait: Bridge processes signature (~2-3 seconds)

6. **After signature:**
   - Dialog closes
   - Notification appears with badge: "⏱ Pending..."
   - Console shows: `[MESSAGE] Message sent successfully`
   - Console shows: `[MESSAGE] Wallet signature obtained: ut1...`
   - Console shows: `[POLLING] Starting polling for transaction ut1...`

### Expected Console Output

```
[MESSAGE] Message sent successfully
[MESSAGE] Wallet signature obtained: ut1abc123def456...
[MESSAGE] TX Hash registered with backend: ut1abc123def456...
[POLLING] Starting polling for transaction ut1abc123def456... (auditLogId=123)
[POLLING] Attempt 1/600: Status pending
```

### Verification Checklist

- [ ] Wallet dialog opened directly (no Guardian modal)
- [ ] Message appears in conversation (no duplicate)
- [ ] Notification badge shows "⏱ Pending..."
- [ ] Console shows correct logs
- [ ] Polling attempts visible (Attempt 1/600, 2/600, etc.)

**Pass Criteria:** Wallet dialog opens directly without intermediate modals  
**Status:** Ready for testing ✅

---

## Test Case 2: Response Format Parsing

**Objective:** Verify txHash is correctly extracted from wallet bridge response

### Steps

1. **Send another test message:** "Test response parsing - message 2"
2. **Open DevTools:** F12 or Cmd+Opt+J
3. **Go to Console tab**
4. **Sign wallet dialog**
5. **Monitor console output for:**
   - Message: `[MESSAGE] Wallet signature obtained: ut1...`
   - Verify: `ut1...` is NOT `undefined`
   - Verify: Looks like valid txHash (starts with `ut1`, contains hex)

6. **Check Network tab:**
   - Look for POST request to `/api/blockchain-audit/xxx/register-tx`
   - Response body shows: `{ "txHash": "ut1...", "chainId": "testnet" }`

7. **Verify no undefined values:**
   - Console should NOT show: `undefined` in txHash logs
   - Console should NOT show: `[ERROR] Bridge response missing...`

### Expected Console Output

```
[MESSAGE] Message sent successfully
[MESSAGE] Wallet signature obtained: ut1abc123...
[MESSAGE] TX Hash registered with backend: ut1abc123...
[POLLING] Starting polling for transaction ut1abc123...
```

### Verification Checklist

- [ ] txHash extracted correctly (not undefined)
- [ ] txHash format is valid (starts with ut1)
- [ ] Network tab shows correct response with txHash
- [ ] No "undefined" errors in console
- [ ] Response format parsed correctly

**Pass Criteria:** txHash correctly extracted with no undefined errors  
**Status:** Ready for testing ✅

---

## Test Case 3: Duplicate Detection

**Objective:** Send same message twice in 2 minutes, verify duplicate detected and transaction reused

### Steps

1. **Send first message:** "Test duplicate detection"
2. **Wait for wallet dialog,** sign the transaction
3. **Record these values:**
   - From console: `blockchainRecordingId` (e.g., `123`)
   - From console: `txHash` (e.g., `ut1abc123`)
   - From notification: Audit log ID

4. **Send the SAME message again:** "Test duplicate detection"
5. **Immediately click Send** (within 2 minutes of first send)
6. **Sign wallet dialog again**

7. **Observe differences:**
   - **First send toast:** "✓ Message sent—confirming on-chain"
   - **Second send toast:** "✓ Message already sent—reusing existing transaction" ← Different!
   - **First message:** Still visible in conversation
   - **Second message:** NOT added to conversation (duplicate prevented)

### Expected Console Output

```
// First send
[MESSAGE] Message sent successfully
[MESSAGE] Wallet signature obtained: ut1abc123...
[MESSAGE] TX Hash registered with backend: ut1abc123...
[POLLING] Starting polling for transaction ut1abc123... (auditLogId=123)

// Second send (same message, within 2 minutes)
[MESSAGE] Message sent successfully
[MESSAGE] Wallet signature obtained: ut1xyz...
[MESSAGE] TX Hash registered with backend: ut1xyz...
[MESSAGE] Duplicate detected! Reusing existing auditLogId: 123 ← KEY LINE
[POLLING] Skipping duplicate polling, existing transaction tracked
```

### Expected Network Response (Second Send)

```json
POST /api/conversations/.../messages
Response: {
  "id": 0,
  "blockchainRecordingId": 123,
  "isDuplicate": true,
  "existingTxHash": "ut1abc123..."
}
```

### Server Console Output

**Look in server logs for:**

```
🔄 [DUPLICATE DETECTED]
   User: 456
   Existing Audit ID: 123
   Existing TX Hash: ut1abc123...
   Time since first attempt: 5 seconds
   Same content hash: SHA256 match
```

### Verification Checklist

- [ ] Different toast message ("already sent" vs "confirming")
- [ ] Same `blockchainRecordingId` returned (123)
- [ ] Same `txHash` reused
- [ ] Only 1 message appears in conversation (not 2)
- [ ] `isDuplicate: true` in network response
- [ ] Console shows: `[MESSAGE] Duplicate detected!`
- [ ] Server console shows: `[DUPLICATE DETECTED]` block

**Pass Criteria:** Duplicate detected, single message created, same transaction reused  
**Status:** Ready for testing ✅

---

## Test Case 4: Polling Resume After Page Refresh

**Objective:** Verify polling auto-resumes from sessionStorage after page refresh

### Steps

1. **Send a test message:** "Polling resume test - message 1"
2. **Sign wallet dialog**
3. **Note the auditLogId** from console (e.g., `456`)
4. **Observe polling starts:** Console shows `[POLLING] Attempt 1/600: Status pending`
5. **Let polling run for ~5-10 seconds** (watch console for 3-4 attempt logs)
6. **Open DevTools** and check sessionStorage:
   - Right-click page → Inspect → Application tab
   - Left sidebar: Session Storage → http://127.0.0.1:3100
   - Look for: `activePollingSessions` key
   - Value should show: Pending transaction with auditLogId=456

7. **Refresh the page:** Ctrl+R (or Cmd+R)
8. **Wait for page to reload** (2-3 seconds)
9. **Check console immediately:**
   - Look for: `[POLL] Resuming polling for auditLogId=456`
   - Look for: `[POLLING] Attempt 4/600:` or similar (NOT resetting to 1)
   - Polling continues from where it left off

10. **Verify notification persists:**
    - Same "⏱ Pending..." badge visible
    - Same auditLogId on badge
    - No duplicate notifications

### Expected SessionStorage (Before Refresh)

```json
{
  "activePollingSessions": {
    "456": {
      "notificationId": "msg-456",
      "auditLogId": 456,
      "txHash": "ut1abc123...",
      "chainId": "testnet",
      "pollAttempt": 3
    }
  }
}
```

### Expected Console Output (After Refresh)

```
[POLL] Resuming polling for auditLogId=456
[POLLING] Attempt 4/600: Status pending
[POLLING] Attempt 5/600: Status pending
[POLLING] Attempt 6/600: Status pending
```

### Verification Checklist

- [ ] sessionStorage contains `activePollingSessions`
- [ ] Stored session has correct auditLogId and txHash
- [ ] After refresh, polling continues (not restarted at 1)
- [ ] Notification persists with same ID
- [ ] No duplicate notifications created
- [ ] Console shows attempt count continuing (not reset)

**Pass Criteria:** Polling auto-resumes from correct state after refresh  
**Status:** Ready for testing ✅

---

## Test Case 5: Timeout & Check Now Button

**Objective:** Verify timeout after max attempts, Check Now queries status

### Practical Approach (5-10 minutes instead of 6+ hours)

Since real 600 attempts take ~6-7 hours, use this approach:

#### Option A: Simulate Timeout State (Fastest)

1. **Send a test message:** "Timeout test - message"
2. **Let it poll for 3-5 attempts** (watch console for 5-10 seconds)
3. **Open browser DevTools Console** and run:

```javascript
// Manually trigger timeout state (simulates after 600 attempts)
const notification = document.querySelector('[data-notification-type="message"]');
const badge = notification.querySelector('[data-status-badge]');

badge.innerHTML = '⏱ Confirmation timeout - <a href="#" onclick="checkTransactionStatus(this, event)" style="text-decoration: underline; cursor: pointer;">Check Now</a>';
badge.className = 'text-xs px-2 py-1 rounded bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200';
badge.dataset.auditLogId = '456';  // Use actual auditLogId from earlier test
```

4. **In the notification, click the "Check Now" link**
5. **Observe in Console:**
   - Single API call made: `GET /api/blockchain-audit/456`
   - No polling restart
   - Response shows current status

6. **Check Network tab:**
   - Only 1 request to `/api/blockchain-audit/456`
   - Response time: ~100-200ms (fast, database only)
   - Response body: `{ "status": "pending", "txHash": "ut1...", "createdAt": "..." }`

7. **Verify badge updates:**
   - If status is "pending": `⏱ Still pending - check again in a few minutes`
   - If status is "confirmed": `✓ Confirmed` (green)
   - If status is "failed": `✗ Failed` (red)

#### Option B: Wait for Real Timeout (Long-running)

1. **Send a test message:** "Long poll timeout test"
2. **Let it poll continuously** for 30+ minutes
3. **Monitor console** for attempt progression
4. **After 600 attempts** (takes ~6-7 hours):
   - Console shows: `[POLL] ⚠️ Polling timeout after 600 attempts`
   - Badge changes to: "⏱ Confirmation timeout - Check Now"
   - Click "Check Now" same as Option A above

### Expected Console Output

```
[POLLING] Attempt 1/600: Status pending
[POLLING] Attempt 2/600: Status pending
...
[POLLING] Attempt 5/600: Status pending

// After manual timeout trigger or 600 real attempts:
[POLL] ⏠️ Polling timeout after 600 attempts
[POLL] Showing Check Now button

// After clicking Check Now:
[TRANSACTION] Checking status for auditLogId=456
[TRANSACTION] Status response: {status: "pending", txHash: "ut1abc...", createdAt: "..."}
[TRANSACTION] Badge updated: ⏱ Still pending - check again in a few minutes
```

### Verification Checklist

- [ ] Timeout notification shows "⏱ Confirmation timeout"
- [ ] "Check Now" link is visible and clickable
- [ ] Clicking Check Now makes single API call
- [ ] Network tab shows: GET `/api/blockchain-audit/456` (one request)
- [ ] Response time is fast (~100-200ms, not 600 retries)
- [ ] Badge updates based on response status
- [ ] No polling retry loop started after Check Now
- [ ] Can click Check Now multiple times
- [ ] Each click makes fresh API call

**Pass Criteria:** Timeout appears, Check Now makes single query, fast response  
**Status:** Ready for testing ✅

---

## Test Case 6: Error Handling

**Objective:** Verify graceful error handling for wallet disconnection and reconnection

### Scenario A: Wallet Disconnected

1. **In your wallet extension**, click Disconnect or Logout
2. **In Guardian app**, click Send on a new message
3. **Expected behavior:**
   - Wallet dialog appears (or attempts to)
   - Shows error: "Wallet not connected" or similar
   - Toast error shows: "Error: Wallet not available"
   - **NOT:** App crash
   - **NOT:** Undefined errors in console
   - **NOT:** Exception in console

4. **Verify console:**
   - Shows: `[ERROR] Wallet signature error: wallet not connected`
   - Or similar error message
   - No uncaught exceptions

### Scenario B: Wallet Reconnect and Retry

1. **Reconnect wallet** in wallet extension
2. **In Guardian**, click Send again on new message
3. **Expected behavior:**
   - Wallet dialog appears successfully
   - User can sign normally
   - Polling begins as usual

4. **Verify console:**
   ```
   [MESSAGE] Message sent successfully
   [MESSAGE] Wallet signature obtained: ut1xyz...
   [POLLING] Starting polling...
   ```

### Scenario C: Network Error During Polling

1. **Open DevTools** → Network tab
2. **Throttle or disable network** (simulate offline)
3. **Send a message** and start polling
4. **Observe after 1-2 attempts:**
   - Console shows: `[ERROR] Polling failed: Network error`
   - Polling continues attempting (exponential backoff)
   - No app crash

5. **Re-enable network**
6. **Polling continues** and eventually confirms (or times out)

### Expected Console Output

**Wallet not connected:**
```
[ERROR] Wallet signature error: wallet not connected
[WALLET] Showing error toast: "Error: Wallet not available"
```

**After reconnection:**
```
[MESSAGE] Message sent successfully
[MESSAGE] Wallet signature obtained: ut1xyz...
[POLLING] Starting polling...
```

**Network error during polling:**
```
[POLLING] Attempt 5/600: Status pending
[ERROR] Polling failed: Network error or explorer offline
[POLLING] Attempt 6/600: Status pending (retrying with backoff)
```

### Verification Checklist

- [ ] Clear error message when wallet unavailable
- [ ] No app crash on wallet disconnect
- [ ] Wallet dialog can reconnect successfully
- [ ] Retry works after wallet reconnection
- [ ] No undefined errors in console
- [ ] Network errors are caught and logged
- [ ] Polling continues despite network errors

**Pass Criteria:** Graceful error handling for wallet errors  
**Status:** Ready for testing ✅

---

## Summary Test Checklist (All 6 Cases)

### ✅ Test Case 1: Direct Wallet Flow
- [ ] Wallet dialog opens immediately (no Guardian modal)
- [ ] Message appears in conversation
- [ ] Notification shows "⏱ Pending..."
- [ ] Polling starts automatically

### ✅ Test Case 2: Response Format Parsing
- [ ] txHash extracted correctly
- [ ] No undefined values in logs
- [ ] Network response has txHash field
- [ ] Valid format (starts with ut1)

### ✅ Test Case 3: Duplicate Detection
- [ ] Different toast for duplicate ("already sent")
- [ ] Same blockchainRecordingId returned
- [ ] Only 1 message in conversation
- [ ] isDuplicate: true in response

### ✅ Test Case 4: Polling Resume After Refresh
- [ ] sessionStorage has activePollingSessions
- [ ] After refresh, polling continues (not reset)
- [ ] Attempt count continues (not reset to 1)
- [ ] No duplicate notifications

### ✅ Test Case 5: Timeout & Check Now
- [ ] Timeout shows after max attempts
- [ ] Check Now button clickable
- [ ] Single API call made (not 600 retries)
- [ ] Fast response (~100-200ms)
- [ ] Badge updates based on status

### ✅ Test Case 6: Error Handling
- [ ] Clear error when wallet unavailable
- [ ] No crashes or exceptions
- [ ] Retry works after reconnection
- [ ] Network errors are caught

---

## Network Mode Settings Reference

### How to Verify Network Mode in Real Testnet

1. **Open Settings** → Network section
2. **Check these values:**
   - Mode: "Real Testnet" ✓
   - Explorer URL: `https://testnet-explorer.usernodelabs.org`
   - RPC URL: `http://usernode-node:3000` (or custom)
   - App pubkey: `ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb`

3. **What changes by mode:**
   - **Demo:** Instant confirmation, no blockchain
   - **Devnet:** Database only, no blockchain
   - **Real Testnet:** Full blockchain RPC polling + explorer (current tests)

### Storage Location

Network mode preference is stored in browser localStorage:
- Key: `guardianNetworkMode`
- Value: `"real_testnet"` (persists across restarts)

---

## Expected Timings

| Action | Time | Notes |
|--------|------|-------|
| Wallet signature | 2-5 sec | Bridge + user sign |
| First polling attempt | 2 sec | Initial quick check |
| Polling progression | 2s→60s backoff | Exponential increase |
| Full 600 attempts | ~6-7 hours | With 60s max delay |
| Check Now button | 100-200ms | Fast DB query only |
| Page refresh | 2-3 sec | Browser reload + resume |

---

## Troubleshooting

### "Wallet dialog not appearing"
- [ ] Check wallet is connected in extension
- [ ] Check bridge script loaded: DevTools Console → `typeof window.sendTransaction` (should be `function`)
- [ ] Check network mode is "Real Testnet" in Settings

### "Transaction always shows pending"
- [ ] Check explorer URL is accessible (network tab)
- [ ] Check txHash format is valid (starts with ut1)
- [ ] Wait longer (explorer may be slow)

### "Only seeing 1-2 polling attempts"
- [ ] Check console for errors
- [ ] Check network tab for failed explorer requests
- [ ] Possible: Transaction confirmed quickly

### "Notification badge not updating"
- [ ] Check transaction status in explorer
- [ ] Check localStorage: `activePollingSessions`
- [ ] Possible: Explorer API is slow

---

## Final Notes

- **Staging database:** Not available in this session (PostgreSQL connection failed)
- **Real testnet:** Will use actual Usernode blockchain when environment available
- **Test repeatability:** Each test can be run multiple times with different messages
- **Timing:** Full 6-hour timeout test is optional; simulate for faster feedback
- **Network:** Requires real internet access to testnet explorer and RPC

**All 6 test cases documented and ready to execute when environment is available.**

Status: ✅ **READY FOR MANUAL TESTING**

