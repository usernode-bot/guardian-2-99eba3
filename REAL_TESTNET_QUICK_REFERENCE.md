# Guardian Real Testnet Testing — Quick Reference Card

## 🚀 Quick Start (5 minutes)

### 1. Switch to Real Testnet
```
Settings → Network → Select "Real Testnet" → Close
```

### 2. Test Case 1: Send Message
```
Send message → Wallet dialog opens → Sign → Notification "⏱ Pending..." → Console logs polling attempts
✅ PASS: Wallet dialog direct, no Guardian modal
```

### 3. Test Case 2: Check txHash
```
Open DevTools → Console → Look for "[MESSAGE] Wallet signature obtained: ut1..."
✅ PASS: txHash exists and looks valid (ut1... format)
```

### 4. Test Case 3: Send Duplicate
```
Send: "Test duplicate"
Send: "Test duplicate" (again, within 2 min)
✅ PASS: Toast says "already sent", only 1 message appears
```

### 5. Test Case 4: Refresh Page
```
Send message → Watch polling start → Refresh page → Console shows "Resuming polling"
✅ PASS: Polling continues, attempt count doesn't reset to 1
```

### 6. Test Case 5: Check Now Button
```
Send message → Wait 5 seconds → Console: Run:
document.querySelector('[data-status-badge]').innerHTML = '⏱ Confirmation timeout - <a href="#" onclick="checkTransactionStatus(this, event)">Check Now</a>'
Click "Check Now" → Single API call (100-200ms)
✅ PASS: Fast response, not 600 retries
```

### 7. Test Case 6: Disconnect Wallet
```
Wallet ext: Disconnect
Guardian: Try to send
✅ PASS: Clear error, no crash
Wallet ext: Reconnect
Guardian: Try to send
✅ PASS: Works again
```

---

## 🔍 Console Key Phrases to Watch For

| Phrase | Meaning | Expect | Pass |
|--------|---------|--------|------|
| `[MESSAGE] Message sent successfully` | Message sent to backend | All sends | ✅ |
| `[MESSAGE] Wallet signature obtained: ut1...` | txHash extracted | All sends | ✅ |
| `[POLLING] Attempt 1/600:` | Polling started | All sends | ✅ |
| `[MESSAGE] Duplicate detected!` | Same message in 2 min | 2nd send only | ✅ |
| `[POLL] Resuming polling for auditLogId=` | Resume after refresh | After refresh | ✅ |
| `[POLL] ⏠️ Polling timeout after 600 attempts` | Timeout reached | After 6+ hours | ✅ |
| `[TRANSACTION] Checking status for auditLogId=` | Check Now clicked | After Check Now | ✅ |
| `[ERROR]` or `undefined` | Problem detected | Should NOT see | ❌ |

---

## 🎯 Test Matrix

| Test | What to do | Expected UI | Expected Console |
|------|-----------|--------------|------------------|
| **1. Wallet Flow** | Send message | Wallet dialog opens directly | `[MESSAGE] Wallet signature obtained` |
| **2. Response Parse** | Check console after send | No "undefined" in logs | `[MESSAGE] Wallet signature obtained: ut1...` |
| **3. Duplicate** | Send same msg twice in 2min | 2nd toast says "already sent" | `[MESSAGE] Duplicate detected!` |
| **4. Resume** | Refresh page mid-polling | Polling continues | `[POLL] Resuming polling for auditLogId=` |
| **5. Check Now** | Click Check Now button | Badge updates in ~200ms | `[TRANSACTION] Checking status...` |
| **6. Error** | Disconnect wallet, retry | Clear error, then works | `[ERROR]` then success on reconnect |

---

## 🔧 DevTools Tricks

### Find auditLogId
```javascript
// In Console:
document.querySelector('[data-audit-log-id]')?.dataset.auditLogId
// Output: "456" or similar
```

### Check sessionStorage
```javascript
// In Console:
JSON.stringify(JSON.parse(localStorage.getItem('activePollingSessions')), null, 2)
// Shows all active polling sessions
```

### Simulate Timeout
```javascript
// In Console (replace 456 with actual auditLogId):
const notification = document.querySelector('[data-notification-type="message"]');
const badge = notification.querySelector('[data-status-badge]');
badge.innerHTML = '⏱ Confirmation timeout - <a href="#" onclick="checkTransactionStatus(this, event)">Check Now</a>';
badge.className = 'text-xs px-2 py-1 rounded bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200';
badge.dataset.auditLogId = '456';
```

### Monitor Network Calls
```
DevTools → Network tab → Filter "blockchain-audit"
Watch for: /api/blockchain-audit/456/register-tx (txHash registration)
Watch for: /api/blockchain-audit/456 (Check Now status query)
```

---

## ⏱️ Timing Guide

- **Wallet sign:** 2-5 seconds
- **First polling attempt:** 2 seconds
- **Subsequent attempts:** 2s → 3s → 5s → 10s → 20s → 30s → 60s (then stays at 60s)
- **Full timeout (600 attempts):** ~6-7 hours
- **Check Now button:** ~100-200ms
- **Transaction confirmation:** Usually 5-30 seconds (depends on blockchain)

---

## 🟢 Pass/Fail Criteria

### ✅ PASS If:
- Wallet dialog opens directly (no Guardian modal)
- txHash is extracted and looks valid
- Duplicate messages are detected and consolidated
- Page refresh resumes polling (doesn't restart)
- Check Now makes single API call
- Wallet disconnect/reconnect handled gracefully
- No console errors or "undefined" values
- Notifications persist and update correctly

### ❌ FAIL If:
- Guardian confirmation modal appears before wallet
- txHash shows "undefined" in console
- Same message appears twice in conversation
- Polling restarts at "Attempt 1/600" after refresh
- Check Now triggers 600-attempt retry
- App crashes when wallet disconnected
- "Cannot read property of undefined" errors
- Notifications disappear or show wrong state

---

## 📊 Expected Network Calls

### Send Message Flow
```
1. POST /api/conversations/.../messages
   → Response: { txHash, blockchainRecordingId, isDuplicate }

2. GET /explorer-api/testnet/transactions/ut1... (polling)
   → Response: { status: "pending" or "confirmed" or "failed" }

3. Repeat polling up to 600 times
```

### Duplicate Detect Flow
```
1. POST /api/conversations/.../messages
   → Response: { isDuplicate: true, blockchainRecordingId: 123 } ← Same ID!

2. NO new polling started (reuse existing)
```

### Check Now Flow
```
1. GET /api/blockchain-audit/456
   → Response: { status: "pending", txHash: "ut1...", createdAt: "..." }

2. Single call, ~100-200ms
```

---

## 🎬 One-Liner Test Scripts

### Test 1: Direct Wallet (30 seconds)
```bash
# Send message → Check wallet dialog opens directly → Sign → Verify notification
```

### Test 2: Response Parse (30 seconds)
```bash
# Send message → Open console → Look for "ut1..." in log → Verify no "undefined"
```

### Test 3: Duplicate (2 minutes)
```bash
# Send "Test A" → Send "Test A" again → Verify different toast → Verify only 1 message
```

### Test 4: Resume (5 minutes)
```bash
# Send message → Wait 3 polling attempts → Refresh → Verify continues (not reset to 1)
```

### Test 5: Check Now (5 minutes)
```bash
# Send message → Simulate timeout in console → Click Check Now → Verify single API call
```

### Test 6: Error Handling (5 minutes)
```bash
# Disconnect wallet → Try send → Verify clear error → Reconnect → Verify works
```

---

## 🎯 Scoring

- **0/6 tests pass:** Network mode not switched to Real Testnet
- **1-2 tests pass:** Database connectivity issue (PostgreSQL unavailable)
- **3-4 tests pass:** Some polling or bridge integration issues
- **5-6 tests pass:** All features working correctly ✅

---

## 🆘 Quick Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Wallet dialog not appearing | Network mode is Demo/Devnet | Switch to "Real Testnet" in Settings |
| "undefined" in console | Bridge response format issue | Check bridge.js returns txHash field |
| Polling stuck at "Attempt 1/600" | Explorer API slow/offline | Check explorer URL accessible in Network tab |
| Duplicate not detected | Time window expired (>2 min) | Send again within 2 minutes |
| Check Now very slow (>2 sec) | Database query slow | Likely connection issue or 600-retry bug |
| Wallet disconnect not handled | Missing error catch | Should see `[ERROR]` in console |

---

## 📝 Tester Checklist

Before starting:
- [ ] Browser opened to staging app
- [ ] DevTools open (F12)
- [ ] Console tab visible
- [ ] Network tab visible
- [ ] Settings → Network → "Real Testnet" selected

While testing:
- [ ] Watch console for key phrases
- [ ] Monitor Network tab for API calls
- [ ] Check localStorage/sessionStorage periodically
- [ ] Note any console errors or warnings
- [ ] Time each test case

After testing:
- [ ] All 6 tests passed? → Deployment ready
- [ ] 4-5 tests passed? → Review failures, fix, retry
- [ ] <4 tests passed? → Check environment setup, debug issues

---

## 🚀 One-Hour Full Test

- **5 min:** Setup (switch to Real Testnet)
- **10 min:** Test 1-3 (Direct wallet, Response parse, Duplicate)
- **15 min:** Test 4 (Polling resume)
- **15 min:** Test 5 (Timeout/Check Now simulation)
- **10 min:** Test 6 (Error handling)
- **5 min:** Summary and pass/fail recording

