# Testnet Transaction Debug Guide

## Quick Diagnosis: "Testnet transactions not showing"

Use this 4-step process to identify the root cause.

### Step 1: Check Server Logs for Transaction Creation

**When**: User sends a message in testnet mode  
**Look For**: `[MESSAGE-DEBUG]` and `[MESSAGE]` log entries

**Expected Logs**:
```
[MESSAGE-DEBUG] NETWORK_MODE=testnet, NODE_RPC_URL=set, txHash=null, auditLogId=123
[MESSAGE] Recording blockchain audit log: messageId=456, status=pending, networkOrigin=testnet, contentHash=abc123
```

**If MISSING**:
- Testnet transaction creation code didn't execute
- Check if message sending endpoint is being called (`POST /api/conversations/:convId/messages`)
- Verify user is authenticated

**If SHOWS NODE_RPC_URL=not set**:
- NODE_RPC_URL environment variable is not configured
- Transactions will be created with `network_origin='bridge'` instead of 'testnet'
- Set NODE_RPC_URL environment variable to RPC endpoint
- Example: `NODE_RPC_URL=http://usernode-node:3001`

**If SHOWS NETWORK_MODE=devnet or NETWORK_MODE=mainnet**:
- User is not in testnet mode
- Transactions created with different origin (database, mainnet)
- Check user's network mode setting in database:
  ```sql
  SELECT network_mode FROM users WHERE id = <user_id>;
  ```

### Step 2: Verify Database Persistence

**Run This Query**:
```sql
SELECT 
  id, 
  user_id, 
  message_type, 
  network_origin, 
  status, 
  tx_hash, 
  created_at 
FROM blockchain_audit_logs 
WHERE user_id = <USER_ID> 
ORDER BY created_at DESC 
LIMIT 10;
```

**Expected Result**: Rows with `network_origin='testnet'`

**If network_origin='bridge'**:
- RPC_URL not set (see Step 1)
- Transactions created as fallback
- Set NODE_RPC_URL and send new message

**If network_origin=NULL**:
- Audit log created before migration was run
- Or created by older code that didn't set network_origin
- New transactions should have the field set

**If NO ROWS**:
- Messages are not being recorded in blockchain_audit_logs
- Check if messages are actually being created:
  ```sql
  SELECT id, sender_id, type, created_at FROM messages 
  WHERE sender_id = <USER_ID> 
  ORDER BY created_at DESC LIMIT 5;
  ```
  - If no messages exist: message sending failed (check response from POST)
  - If messages exist but no audit logs: blockchain recording code not running

### Step 3: Test API Endpoint Response

**Call the Endpoint**:
```bash
curl -H "x-usernode-token: <TOKEN>" \
  'http://localhost:3100/api/transactions-by-user?limit=20&offset=0' | jq '.'
```

**Check Server Logs for**:
```
[API-TRANSACTIONS] Fetching transactions for user=<USER_ID>, limit=20, offset=0
[API-TRANSACTIONS] Query returned 15 rows
[API-TRANSACTIONS] Network origins in response: testnet, testnet, bridge, database
[API-TRANSACTIONS] Testnet transactions: 2
[API-TRANSACTIONS] First transaction structure: {
  id: 123,
  networkOrigin: 'testnet',
  blockchainStatus: { status: 'pending', txHash: null, networkOrigin: 'testnet', explorerUrl: null },
  txHash: null
}
[API-TRANSACTIONS] Returning 2 transactions to frontend
```

**If "Query returned 0 rows"**:
- No transactions in database for this user
- Go back to Step 2

**If "Testnet transactions: 0"**:
- Transactions exist but none with network_origin='testnet'
- Go back to Step 2

**If status code 401**:
- User not authenticated
- Verify x-usernode-token header is valid and present
- Check JWT_SECRET matches between frontend and backend

**If JSON response is malformed**:
- Check for error messages in full response
- Look for SQL errors in server logs

### Step 4: Check Frontend Display

**Open Browser Console** (F12 → Console tab)  
**Filter Logs**: Type `ACTIVITY-DEBUG` in console

**Expected Logs**:
```
[ACTIVITY-DEBUG] API response: { transactions: [ { id: 123, networkOrigin: 'testnet', ... } ], total: 5, ... }
[ACTIVITY-DEBUG] Received 5 transactions
[ACTIVITY-DEBUG] Testnet transactions: 2
[ACTIVITY-DEBUG] Testnet tx 0: { id: 123, messageType: 'message', networkOrigin: 'testnet', status: 'pending', txHash: null }
[ACTIVITY-DEBUG] Testnet tx 1: { id: 124, messageType: 'message', networkOrigin: 'testnet', status: 'confirmed', txHash: 'hash-value' }
```

**If API response shows empty transactions**:
- API returned no results
- Verify database has records (Step 2)

**If "Testnet transactions: 0"**:
- API returned transactions but none with networkOrigin='testnet'
- Check API response structure, look for `networkOrigin` property (vs `network_origin`)

**If logs not appearing**:
- Activity tab might not be loading
- Try navigating to Activity tab again
- Check for JavaScript errors in console
- Reload page (Ctrl+R)

**Also Check**:
When rendering transactions, you should see:
```
[RENDER-DEBUG] Rendering tx id=123, networkOrigin=testnet, messageType=message
[RENDER-DEBUG] Rendering tx id=124, networkOrigin=testnet, messageType=message
```

## Specific Scenarios

### Scenario A: "I see other transactions but no testnet transactions"

1. **Step 1**: Check server logs - are testnet transactions being created?
   - If YES → Go to Step 2
   - If NO → NETWORK_MODE or RPC issue (see Step 1 diagnostics)

2. **Step 2**: Verify testnet transactions in database
   - If YES → Go to Step 3
   - If NO → Message creation failed, check message table

3. **Step 3**: Call API and check response
   - If testnet transactions in response → Go to Step 4
   - If not in response → SQL query issue, check logs for WHERE clause

4. **Step 4**: Check frontend console
   - If API response has transactions → Check rendering
   - If API response empty → Issue in steps 1-3

### Scenario B: "Transactions show in API but not in Activity tab"

1. Check browser console for JavaScript errors
2. Verify `blockchainStatus` object exists in API response
3. Confirm `blockchainStatus.networkOrigin` property is present (not `network_origin`)
4. Check that response structure matches expected format:
   ```javascript
   {
     id: number,
     networkOrigin: string,
     messageType: string,
     blockchainStatus: {
       status: 'pending'|'confirmed',
       txHash: string|null,
       networkOrigin: string,
       explorerUrl: string|null
     },
     ...
   }
   ```

### Scenario C: "Transactions show as pending forever"

1. **Status doesn't update** → Polling issue
   - Check browser console for polling errors
   - Verify `/api/blockchain-audit/<id>` endpoint is reachable
   - Check server logs for `[DETAIL-API]` entries

2. **RPC never confirms transaction** → RPC or blockchain issue
   - Verify NODE_RPC_URL is correct and reachable
   - Check if testnet is running
   - Look for RPC errors in server logs: `[BLOCKCHAIN-RPC]`

3. **Polling stops early** → Max attempts reached
   - Default: 600 attempts × 4 seconds = ~40 minutes
   - Transaction will show "Pending verification" indefinitely after timeout

### Scenario D: "API returns 401 Unauthorized"

1. Verify authentication token is present
   ```javascript
   // In browser console, check:
   document.cookie // Look for auth token
   // or check Request headers in Network tab
   ```

2. Verify token is being sent
   ```bash
   curl -v -H "x-usernode-token: <TOKEN>" http://localhost:3100/api/transactions-by-user
   # Should NOT show 401
   ```

3. Check if JWT_SECRET matches
   - Backend: `process.env.JWT_SECRET`
   - Should match platform's secret
   - Check server logs for JWT verification errors

## Log File Locations

### Server Logs
- **Docker**: `docker logs <container-id>`
- **Local**: Stdout of `node server.js` process
- **Search Pattern**: `[MESSAGE-DEBUG]`, `[API-TRANSACTIONS]`, `[DETAIL-API]`

### Browser Logs
- **Chrome/Edge**: F12 → Console tab
- **Filter**: Type filter text in console search
- **Persistence**: Enable "Preserve log" in Settings to keep logs on navigation

### Database Logs
- **PostgreSQL**: Check `pg_log` directory or system logs
- **Connection Issues**: Check `psql` connection string in DATABASE_URL

## Common Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| `NETWORK_MODE=devnet` in logs | User in wrong mode | Switch network mode in settings |
| `NODE_RPC_URL=not set` in logs | RPC not configured | Set NODE_RPC_URL env variable |
| `Query returned 0 rows` | No transactions in DB | Create test transaction first |
| `401 Unauthorized` | Auth token missing/invalid | Check x-usernode-token header |
| `Testnet transactions: 0` | Wrong network_origin | Verify DB values, check Step 2 |
| `explorerUrl: null` | Explorer not healthy | Set EXPLORER_HEALTHY=true, check EXPLORER_URL |

## Testing with Staging Data

Staging environment includes pre-seeded testnet transactions:
- **alice**: 2 testnet transactions (message type)
- **bob**: 2 testnet transactions (1 message, 1 token_transfer)

**To test**:
1. Log in as alice (user_id=1) or bob (user_id=2)
2. Navigate to Profile → Activity
3. Should see Testnet labeled transactions
4. If not, follow 4-step diagnosis above

**To create new test transactions**:
1. Open a direct message conversation
2. Send a message (will create testnet transaction)
3. Check Activity tab immediately (should appear with "Pending verification")
4. Wait 1-2 minutes (or until RPC confirms)
5. Status should update to "Verified on Testnet"

## Advanced Troubleshooting

### Trace Complete Request/Response Cycle

1. **In Browser**: Open Network tab (F12)
2. **Send Message**: Trigger the action that creates transaction
3. **Find Request**: Look for `POST .../messages` request
4. **Check Response**: Should include `blockchainRecordingId`
5. **Next Request**: Look for `GET /api/transactions-by-user`
6. **Check Response**: Should include new transaction with `networkOrigin: 'testnet'`
7. **Verify Modal**: Click transaction, should call `GET /api/blockchain-audit/<id>`

### Check PostgreSQL Directly

```bash
# Connect to database
psql $DATABASE_URL

# Check table exists
\d blockchain_audit_logs

# Count testnet transactions
SELECT COUNT(*) FROM blockchain_audit_logs 
WHERE network_origin = 'testnet';

# View recent transactions
SELECT id, user_id, message_type, network_origin, status, tx_hash 
FROM blockchain_audit_logs 
ORDER BY created_at DESC 
LIMIT 10;
```

### Verify RPC Connectivity

```bash
# Test RPC endpoint
curl -X POST http://usernode-node:3001/transaction/submit \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <APP_SECRET_KEY>" \
  -d '{"method": "transaction_submit", "params": {...}}'

# Should respond with JSON (error OK, timeout bad)
```

## When to Escalate

If after following this guide you've verified:
- ✅ NETWORK_MODE=testnet
- ✅ NODE_RPC_URL is set and reachable
- ✅ Transactions appear in database with network_origin='testnet'
- ✅ /api/transactions-by-user returns them correctly
- ✅ Frontend console shows them being received

But they still don't display, then:

1. Check for JavaScript errors in browser console
2. Look for CSS issues (transactions hidden by CSS)
3. Check if renderActivityTransactionComplete() is being called
4. Add temporary `console.log` statements to trace rendering
5. File a bug report with:
   - Server logs showing [MESSAGE], [API-TRANSACTIONS], [DETAIL-API]
   - Browser console logs showing [ACTIVITY-DEBUG], [RENDER-DEBUG]
   - Database query results
   - Network tab requests/responses
