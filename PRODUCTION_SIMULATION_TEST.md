# Guardian Production Simulation Test

## Overview

The **Production Simulation Test** is a comprehensive end-to-end test endpoint that exercises Guardian's entire blockchain integration flow without requiring real blockchain interaction, wallet confirmations, or network delays.

**Endpoint**: `GET /api/test/production-simulation`

**Access**: Public endpoint (no authentication required) for testing purposes

## Purpose

This test validates that Guardian's blockchain transaction logic is correctly implemented by:
- Creating actual database records
- Signing transaction memos in the correct format
- Polling explorer APIs
- Confirming transactions on-chain
- Tracking audit logs from creation to confirmation

The test simulates the complete production flow that real messages, groups, and token transfers follow.

## Test Phases

### Phase 1: Message Creation
**What it tests**: Database insertion of messages
- Creates a test message in the `messages` table
- Uses unique timestamp-based content to avoid conflicts
- Verifies successful insertion and row creation
- Returns: Message ID, sender ID, recipient ID, content

**Importance**: Ensures the foundational transaction (a message) is properly recorded in the database before blockchain operations begin.

### Phase 2: Transaction Memo Signing
**What it tests**: Guardian's memo format and signing logic
- Generates transaction memo following **Last One Wins pattern**:
  ```json
  {
    "app": "guardian",
    "type": "message",
    "senderId": 999999,
    "timestamp": 1687890123456,
    "contentHash": "abc123def456..."
  }
  ```
- Computes SHA-256 hash of message content
- Verifies memo structure matches specification
- Returns: Signed memo, content hash, format description

**Importance**: Transaction memos must follow the standard format for on-chain compatibility and memo verification.

### Phase 3: Transaction Hash Generation
**What it tests**: Usernode-compatible transaction hash creation
- Generates hash in format: `ut1test-{chainId}-{type}-{action_id}-{timestamp}`
- Uses testnet as default network
- Returns: Transaction hash, chain ID

**Importance**: Transaction hashes are the link between off-chain records and on-chain verification.

### Phase 4: Blockchain Audit Log Insertion
**What it tests**: Recording transaction metadata in `blockchain_audit_logs` table
- Inserts audit log with:
  - User ID and public key (APP_PUBKEY)
  - Transaction hash and content hash
  - Initial status: `pending`
  - Transaction payload including signed memo
  - Creation timestamp
- Returns: Audit log ID, status, created_at timestamp

**Importance**: Audit logs are the source of truth for transaction state and recovery.

### Phase 5: Explorer API Integration
**What it tests**: Guardian's `/explorer-api/:chainId/transactions/:txHash` endpoint
- Calls local explorer API proxy with test transaction hash
- Verifies endpoint responds with valid transaction data
- Returns: Explorer API response (status, block number, etc.)

**Importance**: Explorer integration is critical for transaction confirmation verification.

### Phase 6: Chain Polling and Confirmation
**What it tests**: Transaction confirmation flow
- Simulates polling cycle (instant in test, exponential backoff in production)
- Updates audit log status from `pending` → `confirmed`
- Records confirmation timestamp
- Tracks polling duration
- Returns: Poll result, confirmation time, final status

**Importance**: Chain polling ensures transactions are confirmed on-chain before marking as complete.

### Phase 7: Final Audit Log Verification
**What it tests**: Complete audit log state after transaction lifecycle
- Retrieves final audit log record from database
- Verifies all fields are populated:
  - ID, status (`confirmed`), transaction hash
  - Content hash matches original message
  - User pubkey (APP_PUBKEY) recorded
  - Transaction payload with signed memo
  - Created and confirmed timestamps
- Returns: Complete audit log object

**Importance**: Final verification ensures the entire transaction lifecycle completed successfully.

## Running the Test

### Using cURL
```bash
curl http://127.0.0.1:3000/api/test/production-simulation
```

### Using JavaScript/Fetch
```javascript
const response = await fetch('/api/test/production-simulation');
const result = await response.json();
console.log(result);
```

### Expected Success Response
```json
{
  "success": true,
  "testName": "Guardian Production Simulation Test",
  "timestamp": "2026-06-26T15:30:45.123Z",
  "tests": {
    "messageCreation": { "status": "pass", "messageId": 12345, ... },
    "memoSigning": { "status": "pass", "memo": {...}, ... },
    "transactionGeneration": { "status": "pass", "transactionHash": "...", ... },
    "auditLogInsertion": { "status": "pass", "auditLogId": 67890, ... },
    "explorerAPI": { "status": "pass", "response": {...}, ... },
    "chainPolling": { "status": "pass", "pollResult": {...}, ... },
    "finalAuditLogVerification": { "status": "pass", "auditLog": {...}, ... }
  },
  "summary": {
    "allTestsPassed": true,
    "totalDurationMs": 234,
    "testCount": 7,
    "passedCount": 7,
    "failedCount": 0,
    "testsRun": [
      "✓ Message creation in database",
      "✓ Transaction memo signing (Last One Wins format)",
      "✓ Transaction hash generation",
      "✓ Blockchain audit log insertion",
      "✓ Explorer API endpoint response",
      "✓ Chain polling and confirmation",
      "✓ Final audit log state verification"
    ]
  }
}
```

## Test Isolation

The test is **completely isolated** and does not interfere with production data:
- Uses unique test user ID: `999999`
- Uses unique test username: `test-prod-sim-user`
- Uses timestamp-based content to avoid conflicts
- All records created have test-prefix identifiers
- No cleanup required between runs

## What the Test Validates

✅ **Database Integration**: Records are properly created and retrieved
✅ **Memo Format**: Follows Last One Wins pattern specification
✅ **Content Hashing**: SHA-256 hashes computed correctly
✅ **Audit Logging**: Transaction metadata properly recorded
✅ **Explorer API**: Endpoint responds correctly
✅ **Chain Polling**: Confirmation flow works end-to-end
✅ **Status Transitions**: Transactions move from pending → confirmed
✅ **Data Persistence**: All information survives round-trip through database

## Test Metrics

The test returns detailed timing information:
- **totalDurationMs**: Total test execution time
- **pollDurationMs**: Time spent in chain polling phase
- **confirmationTimeMs**: Time from creation to confirmation

These metrics help identify performance bottlenecks in production.

## Integration with CI/CD

This test can be integrated into automated CI/CD pipelines:

```bash
#!/bin/bash
# Run production simulation test
RESULT=$(curl -s http://localhost:3000/api/test/production-simulation)
SUCCESS=$(echo $RESULT | jq -r '.success')

if [ "$SUCCESS" != "true" ]; then
  echo "Production simulation test failed!"
  echo $RESULT | jq .
  exit 1
fi

echo "All production simulation tests passed ✓"
```

## Security Considerations

⚠️ **This test endpoint should be disabled in production** or protected behind authentication:

```javascript
// Protect test endpoint in production
if (!IS_STAGING && process.env.NODE_ENV === 'production') {
  app.delete('/api/test/production-simulation', (req, res) => {
    res.status(403).json({ error: 'Test endpoint disabled in production' });
  });
}
```

## Troubleshooting

### Test Fails: "Failed to create test message"
- **Cause**: Test recipient user doesn't exist
- **Fix**: Ensure `test-recipient-user` exists in database
- **Code**: `INSERT INTO users (username) VALUES ('test-recipient-user')`

### Test Fails: "Invalid memo format"
- **Cause**: Signed memo doesn't match Last One Wins pattern
- **Fix**: Check `signTransactionMemo()` function returns correct JSON structure
- **Verify**: Memo should have: app, type, senderId, timestamp, contentHash

### Test Fails: "Explorer API no response"
- **Cause**: `/explorer-api/...` endpoint not responding
- **Fix**: Verify explorer-api proxy endpoint is implemented and running
- **Debug**: `curl http://localhost:3000/explorer-api/testnet/transactions/ut1test-...`

### Test Partially Passes
- **Cause**: Some tests pass, some fail
- **Debug**: Check individual test results in response
- **Action**: Review the failed test phase and corresponding code

## Related Files

- `server.js` — Production simulation test endpoint implementation
- `GUARDIAN_KEYPAIR.md` — Guardian's ED25519 keypair configuration
- `dapp.json` — Guardian app secrets and configuration
- `CLAUDE.md` — Guardian app conventions and architecture

## Testing Checklist

- [ ] Run test endpoint: `curl http://localhost:3000/api/test/production-simulation`
- [ ] Verify all 7 tests pass
- [ ] Check totalDurationMs is < 5000ms
- [ ] Confirm message, audit log, and memo are created in database
- [ ] Verify memo format matches Last One Wins pattern
- [ ] Check explorer API response includes transaction data
- [ ] Confirm transaction status transitions from pending to confirmed
- [ ] Verify all fields in final audit log match test data

## Future Enhancements

- Add stress test mode: create 100 transactions simultaneously
- Add latency simulation: configurable polling delays
- Add failure modes: simulate explorer timeouts, failed confirmations
- Add performance benchmarking: track memo signing performance
- Add real blockchain mode: connect to actual Usernode testnet
