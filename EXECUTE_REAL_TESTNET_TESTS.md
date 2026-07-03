# Execute Real Testnet Tests — Complete Environment & Procedure

**Status:** July 3, 2026  
**Environment:** Usernode Social Vibecoding Staging  
**Target:** Guardian Real Testnet Mode - Full 6 Test Case Execution  

---

## Environment Requirements

### ✅ Already Provided

- Node.js server running
- PostgreSQL database connection (staging container)
- Usernode bridge loaded (`window.sendTransaction` available)
- JWT authentication (user session token in iframe)
- Real testnet block explorer accessible

### Prerequisites for Testing

1. **Browser:** Chrome, Firefox, Safari, or Edge (any modern browser)
2. **DevTools:** Built-in (F12)
3. **Staging URL:** `https://<staging-subdomain>.usernodelabs.org` (or local `http://127.0.0.1:3100`)
4. **Wallet:** Usernode wallet connected in bridge
5. **Time:** 1-2 hours for full test suite (or 20 minutes with simulated timeout)

---

## Pre-Test Checklist

### Step 1: Access Staging App
```
Browser → Navigate to staging URL
Expected: Conversations list loads, sidebar visible, Settings icon visible
```

### Step 2: Open DevTools
```
Key: F12 (Windows/Linux) or Cmd+Opt+J (Mac)
Tabs needed:
  - Console (to watch logs)
  - Network (to inspect API calls)
  - Application (to check localStorage/sessionStorage)
```

### Step 3: Verify Bridge Loaded
```
DevTools Console, type:
  typeof window.sendTransaction

Expected output: "function"
(If shows "undefined", bridge not loaded, reload page)
```

### Step 4: Check Current Network Mode
```
Click Settings icon (bottom left)
Click "Network Status" accordion
Current mode should be: "Demo", "Devnet", or "Real Testnet"
If already "Real Testnet" → Skip to Test Cases
If not → Continue to Step 5
```

### Step 5: Switch to Real Testnet Mode
```
In Settings panel:
1. Find "Network Status" section
2. Click "Network Mode" dropdown
3. Select "Real Testnet"
4. Wait for panel to update (~1 second)
5. Verify shows:
   - Mode: "Real Testnet"
   - Explorer: "https://testnet-explorer.usernodelabs.org"
   - RPC: "http://usernode-node:3000"
6. Close Settings panel (click X or click outside)
```

### Step 6: Select a Conversation
```
Left sidebar shows conversations
Click any conversation (or create a new one if empty)
Expected: Message input box appears at bottom, past messages visible
```

---

## Test Execution Procedure

### TEST 1: Direct Wallet Flow (5 minutes)

**Purpose:** Verify wallet signature dialog opens directly without Guardian modal

**Steps:**
```
1. Type message: "Test 1 - Direct Wallet Flow"
2. Click Send button
3. CRITICAL: Observe wallet dialog
   ✅ SHOULD see: Usernode wallet signature dialog
   ❌ Should NOT see: Guardian confirmation modal or loading spinner
4. Sign the transaction in wallet dialog
5. Wait 3-5 seconds
6. Observe notification badge appears with "⏱ Pending..."
7. Check DevTools Console for:
   [MESSAGE] Message sent successfully
   [MESSAGE] Wallet signature obtained: ut1...
   [POLLING] Starting polling for transaction...
```

**Pass Criteria:**
- [ ] Wallet dialog opened directly (not Guardian modal)
- [ ] Notification appeared with "⏱ Pending..." badge
- [ ] Console shows correct log messages
- [ ] Message visible in conversation

**Expected Time:** 3-5 minutes

---

### TEST 2: Response Format Parsing (3 minutes)

**Purpose:** Verify txHash extracted correctly from wallet response

**Steps:**
```
1. With DevTools Console open, send new message: "Test 2 - Response Format"
2. Sign wallet dialog
3. Immediately check Console for line:
   [MESSAGE] Wallet signature obtained: ut1abc123def456...
4. Verify:
   ✅ "ut1" prefix present
   ✅ Contains hex characters
   ✅ NOT "undefined"
   ✅ Looks like valid transaction hash
5. Check Network tab:
   Filter: "blockchain-audit"
   Look for POST request: /api/blockchain-audit/xxx/register-tx
   Click → Response tab
   See: { "txHash": "ut1...", "chainId": "testnet" }
6. Verify NO console errors with "undefined"
```

**Pass Criteria:**
- [ ] txHash extracted and visible in console
- [ ] Format is valid (ut1... with hex)
- [ ] Network response includes txHash
- [ ] No undefined errors

**Expected Time:** 2-3 minutes

---

### TEST 3: Duplicate Detection (5 minutes)

**Purpose:** Verify sending same message twice detects duplicate and reuses transaction

**Steps:**
```
1. Send message: "Test 3 - Duplicate Detection"
2. Watch console for: [POLLING] Attempt 1/600
3. Record two values:
   From console: blockchainRecordingId (e.g., "123")
   From notification: audit log ID on badge
4. IMMEDIATELY send same message again: "Test 3 - Duplicate Detection"
5. Sign wallet dialog again
6. Watch for different toast message:
   FIRST send: "✓ Message sent—confirming on-chain"
   SECOND send: "✓ Message already sent—reusing existing transaction" ← Different!
7. Verify in conversation view:
   Only ONE message appears (not two)
8. Check console for:
   [MESSAGE] Duplicate detected! Reusing existing auditLogId: 123
9. Check Network response:
   Look for POST /api/conversations/.../messages (second send)
   Response should include: "isDuplicate": true
10. Verify badge shows same blockchainRecordingId for both messages
```

**Pass Criteria:**
- [ ] Different toast on second send ("already sent")
- [ ] Same blockchainRecordingId returned in response
- [ ] Only 1 message in conversation (not 2)
- [ ] isDuplicate: true in network response
- [ ] Console shows "Duplicate detected!"

**Expected Time:** 3-5 minutes

---

### TEST 4: Polling Resume After Page Refresh (8 minutes)

**Purpose:** Verify polling auto-resumes from sessionStorage after page refresh

**Steps:**
```
1. Send message: "Test 4 - Polling Resume"
2. Sign wallet dialog
3. Watch console for: [POLLING] Attempt 1/600, Attempt 2/600, etc.
4. Let it poll for ~10 seconds (should see 5-6 attempts)
5. Record attempt number from console (e.g., "Attempt 6/600")
6. Open DevTools → Application tab → Session Storage
7. Click "http://127.0.0.1:3100" (or staging domain)
8. Look for localStorage key: "activePollingSessions"
9. Verify it contains:
   - Current message with auditLogId
   - Current attempt number
   - Transaction hash
10. Refresh page: Ctrl+R (or Cmd+R)
11. Wait for page to reload (~3 seconds)
12. Immediately check Console for:
    [POLL] Resuming polling for auditLogId=xxx
13. Verify attempt number continuing:
    ✅ Should see: [POLLING] Attempt 7/600 (continues from where left off)
    ❌ Should NOT see: [POLLING] Attempt 1/600 (restarted)
14. Verify notification badge persists with same ID
15. Verify no duplicate notifications created
```

**Pass Criteria:**
- [ ] sessionStorage contains activePollingSessions
- [ ] After refresh, polling resumes (not restarted)
- [ ] Attempt numbers continue (not reset to 1)
- [ ] Same notification persists
- [ ] No duplicate notifications

**Expected Time:** 5-8 minutes

---

### TEST 5: Timeout & Check Now Button (10 minutes)

**Purpose:** Verify timeout notification and manual status check with single API call

**Two Options:**

#### Option A: Simulate Timeout (RECOMMENDED - 5 minutes)

```
1. Send message: "Test 5 - Timeout Simulation"
2. Sign wallet dialog
3. Let it poll for ~5 seconds
4. Open DevTools Console
5. Get the current notification's auditLogId:
   In Console, type:
   document.querySelector('[data-notification-type="message"]')?.dataset.auditLogId
   Note: Output should be like "456" or similar
6. Run this command in Console to simulate timeout:

   const notification = document.querySelector('[data-notification-type="message"]');
   const badge = notification.querySelector('[data-status-badge]');
   badge.innerHTML = '⏱ Confirmation timeout - <a href="#" onclick="checkTransactionStatus(this, event)" style="text-decoration: underline; cursor: pointer;">Check Now</a>';
   badge.className = 'text-xs px-2 py-1 rounded bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200';
   badge.dataset.auditLogId = '456';  // Replace 456 with actual auditLogId from step 5

7. In the notification, click the "Check Now" link
8. Observe in Network tab:
   Single request appears: GET /api/blockchain-audit/456
   Response time: ~100-200ms (fast, NOT slow like 600 retries)
9. Watch Console for:
   [TRANSACTION] Checking status for auditLogId=456
   [TRANSACTION] Status response: {status: "...", txHash: "ut1...", ...}
10. Verify badge updates:
    If status="pending": "⏱ Still pending - check again in a few minutes"
    If status="confirmed": "✓ Confirmed" (green)
    If status="failed": "✗ Failed" (red)
11. Click "Check Now" again
12. Verify another API call made (each click = fresh request, no batching)
```

#### Option B: Wait for Real Timeout (6+ hours)

```
1. Send message: "Test 5 - Real Timeout"
2. Let polling run continuously
3. Monitor console for attempt progression
4. After ~6-7 hours (600 attempts), see:
   [POLL] ⏠️ Polling timeout after 600 attempts
5. Badge changes to: "⏱ Confirmation timeout - Check Now"
6. Perform same Check Now verification as Option A steps 7-12
```

**Pass Criteria:**
- [ ] Timeout notification shows (or simulated)
- [ ] Check Now button visible and clickable
- [ ] Single API call made (not 600 retries)
- [ ] Response time ~100-200ms (fast)
- [ ] Badge updates based on status
- [ ] Can click Check Now multiple times

**Expected Time:** 5-10 minutes (simulated) or 6+ hours (real)

---

### TEST 6: Error Handling (8 minutes)

**Purpose:** Verify graceful handling of wallet disconnection and reconnection

**Scenario A: Wallet Disconnected (3 minutes)**

```
1. Open wallet extension
2. Click Disconnect (or Logout, or switch wallet to "none")
3. In Guardian app, try to send message: "Test 6A - Wallet Disconnected"
4. Click Send
5. Observe:
   ✅ Error appears (either in dialog or as toast)
   ✅ Message shown: "Wallet not connected" or similar
   ✅ NO app crash
   ✅ NO uncaught exception in console
6. Check Console for:
   [ERROR] Wallet signature error: ...
   OR similar error log
7. Do NOT see:
   Uncaught Error or exception
   "Cannot read property..."
   Server 500 error
```

**Pass Criteria (Scenario A):**
- [ ] Clear error message shown
- [ ] App did NOT crash
- [ ] Console shows error log
- [ ] No uncaught exceptions

**Scenario B: Wallet Reconnect and Retry (3 minutes)**

```
1. In wallet extension, reconnect wallet
2. Wait for connection to establish
3. In Guardian app, try sending another message: "Test 6B - Wallet Reconnected"
4. Click Send
5. Observe:
   ✅ Wallet dialog appears successfully
   ✅ User can sign normally
   ✅ Notification appears with polling badge
6. Check Console for:
   [MESSAGE] Message sent successfully
   [MESSAGE] Wallet signature obtained: ut1...
   [POLLING] Starting polling...
```

**Pass Criteria (Scenario B):**
- [ ] Wallet dialog appeared successfully
- [ ] Message sent normally
- [ ] Polling started
- [ ] No errors after reconnection

**Scenario C: Network Error During Polling (2 minutes)**

```
1. Open DevTools → Network tab
2. Find throttle dropdown (usually shows "No throttling")
3. Select "Offline" (simulate network disconnection)
4. In Guardian, try sending message: "Test 6C - Network Error"
5. Sign wallet (should work because signature is local)
6. After 1-2 polling attempts, observe:
   ✅ Console shows error: "[ERROR] Polling failed: Network error"
   ✅ NO app crash
   ✅ Polling continues retrying (doesn't give up)
7. Change throttling back to "No throttling" (reconnect network)
8. Observe polling continues and eventually:
   Either confirms (fast)
   Or times out (after 600 attempts)
```

**Pass Criteria (Scenario C):**
- [ ] Network error caught and logged
- [ ] App did NOT crash
- [ ] Polling continued retrying
- [ ] Recovered when network restored

**Expected Time:** 6-8 minutes (all 3 scenarios)

---

## Test Results Summary

After completing all 6 tests:

### Success Criteria
```
✅ ALL 6 TESTS PASS = Deployment Ready
  - Wallet flow direct
  - Response parsing correct
  - Duplicate detection working
  - Polling resume functional
  - Timeout/Check Now working
  - Error handling graceful

⚠️  4-5 TESTS PASS = Review Failures
  - Identify which tests failed
  - Check environment (network mode, bridge, database)
  - Fix and retry

❌ <4 TESTS PASS = Environment Issue
  - Check Real Testnet mode is selected
  - Check database connection
  - Check bridge loaded (window.sendTransaction available)
  - Check network accessibility
```

### Test Results Table

Fill in during testing:

| Test | Result | Time | Notes |
|------|--------|------|-------|
| 1. Direct Wallet | ⏳ | ___ | |
| 2. Response Parse | ⏳ | ___ | |
| 3. Duplicate Detect | ⏳ | ___ | |
| 4. Polling Resume | ⏳ | ___ | |
| 5. Check Now | ⏳ | ___ | |
| 6. Error Handle | ⏳ | ___ | |
| **TOTAL** | **⏳** | **___** | |

Legend: ✅ PASS | ❌ FAIL | ⏳ IN PROGRESS

---

## Troubleshooting During Tests

### Test 1: Wallet Dialog Not Opening
```
Issue: No dialog appears when clicking Send
Check:
  1. Is "Real Testnet" mode selected in Settings? (Y/N)
  2. Is bridge loaded? Console: typeof window.sendTransaction
     Expected: "function" (not "undefined")
  3. Is wallet connected in browser extension? (Y/N)
  4. Reload page and try again

If still failing:
  - Reload entire page
  - Check if extension/bridge working in another app
  - Verify staging URL matches bridge configuration
```

### Test 2: txHash Shows "undefined"
```
Issue: Console shows "[MESSAGE] Wallet signature obtained: undefined"
Cause: Bridge response format not being parsed correctly
Check:
  1. What does wallet dialog return?
     Try in Console: window.sendTransaction logs response? (Y/N)
  2. Is response in expected format?
     Possible formats: {txHash}, {hash}, {transactionHash}, {result: {txHash}}
  3. Check Network tab → Wallet call response
  4. Update response parsing code if needed
```

### Test 3: Duplicate Not Detected
```
Issue: Sending same message twice doesn't show "already sent" toast
Check:
  1. Was second send within 2 minutes of first? (Y/N)
     If NO: This is expected, not a bug
  2. Is message content EXACTLY identical? (Y/N)
     Including spaces, punctuation, case
  3. Is database up and running? (Check Network tab for database errors)
  4. Is server processing duplicate check?
     Check server logs for "[DUPLICATE DETECTED]" block
```

### Test 4: Polling Doesn't Resume After Refresh
```
Issue: After refresh, see "[POLLING] Attempt 1/600" instead of continuing
Check:
  1. Is sessionStorage being saved?
     Console: JSON.stringify(JSON.parse(localStorage.getItem('activePollingSessions')))
     Should show active sessions (if populated)
  2. Was polling running when page was refreshed? (Y/N)
  3. Is message still "Pending" status?
     Already confirmed/failed messages shouldn't resume
  4. Check localStorage is enabled in browser (Y/N)
```

### Test 5: Check Now Makes Multiple Calls
```
Issue: Check Now is slow or makes many API calls instead of one
Check:
  1. Does Network tab show multiple GET /api/blockchain-audit calls? (Y/N)
  2. Is it restarting polling instead of one-off check? (Y/N)
  3. Check code at line 4317-4338 in public/index.html
  4. Should be single `apiCall(/api/blockchain-audit/:auditLogId)` not polling loop
```

### Test 6: App Crashes on Wallet Disconnect
```
Issue: Console shows uncaught error when wallet disconnected
Check:
  1. What error message? Search for "[ERROR]" in console
  2. Is error being caught? Should see try/catch block
  3. Error type:
     - "Wallet not connected" = Expected, should be graceful
     - "Cannot read property..." = Code issue, needs fix
  4. Check line 4500-4520 in public/index.html for error handling
```

---

## Performance Expectations

| Operation | Expected Time | Acceptable Range | Notes |
|-----------|---------------|------------------|-------|
| Wallet signature dialog | 2-5 sec | 1-10 sec | User interaction time |
| First polling attempt | 2 sec | 1-5 sec | Quick check |
| Polling progression | 2→60 sec | varies | Exponential backoff |
| Full 600 attempts | 6-7 hours | 4-8 hours | Depending on delays |
| Check Now button | 100-200ms | 50-500ms | Database query only |
| Page refresh | 2-3 sec | 1-5 sec | Browser load time |
| Duplicate detection | 0-1 sec | 0-2 sec | Server-side check |
| Resume polling | 1-2 sec | 0-5 sec | localStorage + resume |

---

## Success Indicators

✅ **All 6 tests pass when:**
1. Wallet flow is direct (no Guardian modal) ✓
2. txHash is extracted correctly ✓
3. Duplicate messages are detected and consolidated ✓
4. Polling resumes after page refresh ✓
5. Check Now makes single API call ✓
6. Wallet errors are handled gracefully ✓

---

## Next Steps After Testing

### If ALL 6 TESTS PASS ✅
```
1. Document test results (timestamp, tester name)
2. Take screenshots of key states:
   - Wallet dialog open
   - Message with "⏱ Pending..." badge
   - Console showing polling attempts
3. Confirm deployment readiness
4. Proceed with production merge
```

### If 4-5 TESTS PASS ⚠️
```
1. Identify which tests failed
2. Review expected vs actual behavior
3. Check environment:
   - Is Real Testnet mode selected?
   - Is database connected?
   - Is bridge loading?
4. Fix identified issues
5. Re-run failed tests
```

### If <4 TESTS PASS ❌
```
1. Environment is NOT ready for testing
2. Check:
   - PostgreSQL database connection
   - Usernode bridge availability
   - Network connectivity
   - Real Testnet configuration
3. Resolve environment issues
4. Start testing again from beginning
```

---

## Quick Reference URLs

- **Staging App:** `https://<staging-subdomain>.usernodelabs.org`
- **Testnet Explorer:** `https://testnet-explorer.usernodelabs.org`
- **RPC Endpoint:** `http://usernode-node:3000`
- **Settings Page:** Click gear icon → Network section

---

## Estimated Total Time

- **Minimal Testing (3 tests):** 15-20 minutes
- **Moderate Testing (4-5 tests):** 30-45 minutes
- **Complete Testing (all 6 tests):** 60-90 minutes
- **With Real Timeout:** Add 6+ hours

Recommended: Complete testing (60-90 minutes) for deployment confidence.

---

**Status: READY FOR EXECUTION**

All test cases documented with step-by-step procedures.
Open this guide in one window, staging app in another.
Follow each test in order.
Document results in the table above.

🚀 Begin Testing!

