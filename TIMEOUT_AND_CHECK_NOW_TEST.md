# Timeout Notification and "Check Now" Button - Testing Guide

## Overview

When a transaction is submitted to the blockchain, Guardian polls the explorer up to 600 times with exponential backoff (2s → 60s max). If after all 600 attempts the transaction status is still not confirmed or failed, a timeout notification appears with a "Check Now" button that allows manual one-off status checks without retrying all 600 attempts.

## Timeout Flow Implementation

### Key Code Sections

**1. Polling Loop with Timeout (public/index.html:4216-4250)**
```javascript
async function pollTransactionConfirmation(notificationId, auditLogId, maxPollAttempts = 600) {
  let pollAttempt = 0;
  
  while (pollAttempt < maxPollAttempts) {
    pollAttempt++;
    
    // Make explorer API call
    const status = await checkTransactionOnBlockchain(auditLogId);
    
    if (status === 'confirmed' || status === 'failed') {
      // Update notification with result
      return;
    }
    
    // Wait before next attempt
    await delay(getBackoffDelay(pollAttempt));
  }
  
  // If we get here, max attempts reached = TIMEOUT
  const badge = notification.querySelector('[data-status-badge]');
  badge.innerHTML = '⏱ Confirmation timeout - <a href="#" onclick="checkTransactionStatus(this)">Check Now</a>';
}
```

**2. Check Now Button Handler (public/index.html:4317-4338)**
```javascript
function checkTransactionStatus(element) {
  event.preventDefault();
  const auditLogId = element.parentElement.dataset.auditLogId;
  
  // Single status check, NOT a full retry of 600 attempts
  apiCall(`/api/blockchain-audit/${auditLogId}`).then(response => {
    if (response.status === 'confirmed') {
      badge.innerHTML = '✓ Confirmed';  // Updated badge
    } else if (response.status === 'failed') {
      badge.innerHTML = '✗ Failed';     // Updated badge
    } else {
      badge.innerHTML = '⏱ Still pending - check again in a few minutes';
    }
  });
}
```

**3. Server Endpoint for Status Check (server.js:2976-3010)**
```javascript
app.get('/api/blockchain-audit/:auditLogId', (req, res) => {
  // Returns current transaction status WITHOUT starting new polling
  const query = 'SELECT status, tx_hash, created_at FROM blockchain_audit_logs WHERE id = $1';
  const result = await pool.query(query, [auditLogId]);
  
  return res.json({
    status: result.rows[0].status,
    txHash: result.rows[0].tx_hash,
    createdAt: result.rows[0].created_at
  });
});
```

## Polling Attempt Calculation

The timeout occurs after approximately **2 hours** of attempts with exponential backoff:

```
Attempt    Delay (seconds)    Cumulative Time
─────────────────────────────────────────────
1-10       2s                 20 seconds
11-20      3.5s               ~55 seconds
21-50      5-10s              ~5 minutes
51-100     15-20s             ~20 minutes
101-200    30s                ~1-1.5 hours
201-600    60s                ~6.5 hours total
```

**Total time for 600 attempts: ~6.5 hours** with exponential backoff reaching 60s max.

## Test Scenario 1: Simulate Timeout (Interactive)

This test uses the real polling flow but watches for the timeout state.

### Prerequisites
- Access to staging environment
- Browser with developer console open
- Ability to monitor console logs

### Steps

1. **Navigate to Home Page**
   - Go to `/` in staging
   - Select a conversation from the list

2. **Send a Message**
   - Type test message: "Timeout test message"
   - Click Send
   - Wait for wallet signature dialog
   - Sign the transaction (or observe auto-confirm in demo mode)

3. **Monitor Polling in Console**
   - Open DevTools → Console
   - Watch for polling logs:
     ```
     [POLLING] Attempt 1/600: Status pending
     [POLLING] Attempt 2/600: Status pending
     [POLLING] Attempt 3/600: Status pending
     ...
     ```
   - Each attempt shows the attempt number and current status

4. **Observe Notification Badge States**

   **Phase 1: Polling (Attempts 1-10)**
   - Badge shows: `⏱ Pending...`
   - Tooltip updates with attempt count
   - Notification updates every 2-3 seconds

   **Phase 2: Extended Polling (Attempts 11-100)**
   - Badge still shows: `⏱ Pending...`
   - Updates become less frequent (backoff increases)
   - Delays grow from 3s → 20s

   **Phase 3: Long Polling (Attempts 100+)**
   - Badge shows: `⏱ Pending...`
   - Updates every 30-60 seconds (max backoff reached)
   - Notification quieter (less frequent updates)

5. **Wait for Timeout (Optional)**
   - To see full timeout flow, you must wait ~6+ hours OR mock it
   - Not practical for manual testing
   - See "Test Scenario 2" for faster timeout simulation

## Test Scenario 2: Verify Check Now Button Exists

This test verifies the "Check Now" button implementation without waiting for full timeout.

### Steps

1. **Trigger a Transaction**
   - Send a message to start polling
   - Watch the notification appear

2. **Manually Trigger Timeout State** (Developer Console)
   - Open browser DevTools → Console
   - Force the timeout state:
     ```javascript
     // Get the notification element
     const notification = document.querySelector('[data-notification-type="message"]');
     const badge = notification.querySelector('[data-status-badge]');
     
     // Manually set timeout state (simulates after 600 attempts)
     badge.innerHTML = '⏱ Confirmation timeout - <a href="#" onclick="checkTransactionStatus(this)" style="text-decoration: underline; cursor: pointer;">Check Now</a>';
     badge.className = 'text-xs px-2 py-1 rounded bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200';
     badge.dataset.auditLogId = '123';  // Use actual audit log ID
     ```

3. **Click "Check Now" Button**
   - In the notification, click the "Check Now" link
   - Observe in Console:
     - No polling restart
     - Single API call: `GET /api/blockchain-audit/123`
     - Response shows current status

4. **Verify Button Behavior**
   - ✅ One API call made (not 600 retries)
   - ✅ Button is clickable multiple times
   - ✅ Badge updates based on response
   - ✅ No error in console

## Test Scenario 3: Check Now Response Handling

### Initial Setup
1. Send a message to trigger polling and notification
2. Wait for notification to appear

### Test Cases

#### Case 3A: Status is Confirmed
1. Use DevTools to manually set audit log status to 'confirmed' (or let polling find it)
2. Click "Check Now"
3. Expected behavior:
   - Badge changes to: `✓ Confirmed` (green)
   - No further polling
   - Message appears confirmed in conversation

#### Case 3B: Status is Failed
1. Manually set audit log status to 'failed' in database (or simulate)
2. Click "Check Now"
3. Expected behavior:
   - Badge changes to: `✗ Failed` (red)
   - No further polling
   - Clear error indication

#### Case 3C: Status is Still Pending
1. Transaction status still pending (hasn't been submitted to blockchain yet)
2. Click "Check Now"
3. Expected behavior:
   - Badge shows: `⏱ Still pending - check again in a few minutes`
   - User can click "Check Now" again after a few minutes
   - No automatic retry loop started

## Browser Console Observations

### Initial Send
```
[MESSAGE] Message sent successfully
[MESSAGE] Wallet signature obtained: ut1abc...
[MESSAGE] TX Hash registered with backend: ut1abc...
[POLLING] Starting polling for transaction ut1abc... (auditLogId=456)
[POLLING] Attempt 1/600: Status pending
[POLLING] Attempt 2/600: Status pending
[POLLING] Attempt 3/600: Status confirmed ✓
[POLL] Transaction 456 confirmed after 3 attempts
```

### During Polling (No Timeout)
```
[POLLING] Attempt 1/600: Status pending
[POLLING] Attempt 2/600: Status pending
...
[POLLING] Attempt 20/600: Status pending
[POLLING] Attempt 21/600: Status confirmed ✓
[POLL] Transaction 456 confirmed after 21 attempts, took 45 seconds
```

### After Timeout (600 Attempts)
```
[POLLING] Attempt 1/600: Status pending
[POLLING] Attempt 2/600: Status pending
...
[POLLING] Attempt 598/600: Status pending
[POLLING] Attempt 599/600: Status pending
[POLLING] Attempt 600/600: Status pending
[POLL] ⚠️ Polling timeout after 600 attempts and ~6+ hours. Status still unknown.
[POLL] Notification updated with timeout UI and Check Now button
```

### Check Now Button Click
```
[TRANSACTION] Checking status for auditLogId=456
[TRANSACTION] Status response: {status: "confirmed", txHash: "ut1abc...", createdAt: "2026-07-03T..."}
[TRANSACTION] Badge updated: ✓ Confirmed
```

## Network Log Analysis

### Monitor Network Tab
- **Initial Send:** POST `/api/conversations/.../messages`
- **Wallet Register:** POST `/api/blockchain-audit/456/register-tx`
- **Polling Calls:** GET `/explorer-api/testnet/transactions/ut1abc...` (600 times max)
- **Check Now:** GET `/api/blockchain-audit/456` (single call)

### Key Difference
- **Polling:** Returns explorer status from blockchain
- **Check Now:** Returns Guardian's stored status (fast, no blockchain call)

## Database Queries for Verification

### Check Audit Log Status
```sql
SELECT 
  id,
  user_id,
  tx_hash,
  status,
  created_at,
  confirmed_at
FROM blockchain_audit_logs
WHERE id = 456
ORDER BY created_at DESC;
```

Expected columns:
- `status`: 'pending' | 'confirmed' | 'failed'
- `tx_hash`: 'ut1...' format
- `confirmed_at`: NULL (pending) or timestamp (confirmed/failed)

## Edge Cases to Test

### Edge Case 1: Check Now Multiple Times
1. Click "Check Now" once
2. Wait 10 seconds
3. Click "Check Now" again
4. Expected: Each click makes a fresh API call, no batching or debouncing

### Edge Case 2: Check Now → Confirmed → Refresh
1. Send message
2. Wait for polling to timeout (or simulate)
3. Click "Check Now" and get "confirmed" response
4. Refresh the page
5. Expected:
   - Message should show as confirmed
   - No polling resumes (already confirmed)
   - No orphaned notifications

### Edge Case 3: Multiple Transactions
1. Send message A (starts polling)
2. Wait for timeout on A
3. Send message B (starts new polling)
4. Click "Check Now" on A (should not affect B's polling)
5. Expected: Each transaction tracked independently

### Edge Case 4: Network Error on Check Now
1. Simulate network error (DevTools → Throttle/Offline)
2. Click "Check Now"
3. Expected:
   - Console shows: `Error checking transaction status: ...`
   - Badge remains unchanged
   - User can try again

## Performance Considerations

### Polling Backoff Strategy
- **Fast initial:** 2s delays for first 10 attempts (quick confirmation)
- **Gradual slowdown:** 3s → 60s over 100 attempts
- **Plateau:** 60s max for remaining 500 attempts
- **Total time:** ~6-7 hours for full 600 attempts

### Check Now Optimization
- **Single status call:** No polling restart
- **Fast response:** ~100-200ms (database query only)
- **No RPC involved:** Uses Guardian's stored status, not blockchain
- **Can be clicked repeatedly:** No rate limiting

## Timeout Reasons (In Production)

Transactions might timeout for legitimate reasons:
1. **Explorer slow:** API responses slow
2. **Network congestion:** Blockchain backlogged
3. **RPC endpoint down:** Node unreachable
4. **Invalid transaction:** Never hits blockchain
5. **User error:** Wrong signer, invalid memo format

"Check Now" button helps users determine which case applies without waiting 6+ more hours.

## Testing Checklist

- [ ] Polling starts automatically after wallet signature
- [ ] Polling attempts logged to console (Attempt N/600)
- [ ] Notification badge shows "⏱ Pending..." during polling
- [ ] Exponential backoff working (console shows increasing delays)
- [ ] Timeout state shows "⏱ Confirmation timeout - Check Now" link
- [ ] Check Now button is clickable
- [ ] Check Now makes single API call (not 600 retries)
- [ ] Check Now response updates badge correctly
- [ ] Confirmed status shows green "✓ Confirmed"
- [ ] Failed status shows red "✗ Failed"
- [ ] Pending status shows yellow "⏱ Still pending..."
- [ ] Check Now can be clicked multiple times
- [ ] Network tab shows single GET call to `/api/blockchain-audit/...`
- [ ] No console errors when clicking Check Now
- [ ] Page refresh preserves polling state (resumes or skips if done)
- [ ] Multiple transactions tracked independently

## Related Code References

- **Polling loop:** `public/index.html:4216-4350`
- **Check Now button:** `public/index.html:4241`
- **Check Now handler:** `public/index.html:4317-4338`
- **Timeout condition:** `public/index.html:4236-4246`
- **Status endpoint:** `server.js:2976-3010`
- **Session storage resume:** `public/index.html:4341-4365`

