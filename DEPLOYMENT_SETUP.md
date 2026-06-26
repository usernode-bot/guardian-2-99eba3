# Guardian 2 — Deployment Setup for Real Testnet Transactions

This guide walks administrators through enabling Guardian's real testnet blockchain integration on Usernode Social Vibecoding.

## Overview

Guardian 2 supports real on-chain transactions for three core features:
- **Messages** — Each message is recorded on-chain
- **Groups** — Group creation transactions are anchored to the blockchain
- **Token Transfers** — Tokens transferred between users via sidecar RPC

All transactions follow the **Last One Wins pattern** with:
- Wallet bridge confirmation (user approval)
- Real transaction broadcast to Usernode testnet/mainnet
- Explorer polling for on-chain confirmation
- Audit log tracking with immutable records

## Pre-Deployment Checklist

### 1. App Secret Configuration (Required)

Guardian requires two cryptographic keys stored in platform Secrets:

| Key | Value | Visibility | Purpose |
|-----|-------|------------|---------|
| `APP_PUBKEY` | `ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb` | Public | App's blockchain identity (ut1 address) |
| `APP_SECRET_KEY` | `19f0d93396a451665783ea26cc1bc65e6bb0fd33a5d1d8662ca0ca15478429e3` | Private, encrypted | ED25519 seed for transaction signing |

**To configure in platform Settings:**

1. Go to Guardian app → Settings → Secrets
2. For `APP_PUBKEY`:
   - Status: Must be set
   - Value: `ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb`
   - This is the same value as staging (public, non-sensitive)

3. For `APP_SECRET_KEY`:
   - Status: Must be set for production (CRITICAL)
   - Value: `19f0d93396a451665783ea26cc1bc65e6bb0fd33a5d1d8662ca0ca15478429e3`
   - **IMPORTANT:** This is encrypted at rest and never exposed in logs or errors
   - Staging automatically uses: `guardian_sk_mqudwes5_ae613cf56214808e` (dummy key)

**Configuration is already in `dapp.json` as:**
```json
{
  "key": "APP_SECRET_KEY",
  "description": "Guardian app's ED25519 private key seed (64 hex characters)...",
  "required": true,
  "private": true,
  "staging_default": "guardian_sk_mqudwes5_ae613cf56214808e"
}
```

### 2. Blockchain Address Seeding (Required for Token Transfers)

Guardian's address (`ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb`) needs testnet balance to send transactions:

**On Usernode testnet:**

```bash
# Use Usernode CLI or testnet faucet to seed Guardian's address
usernode-cli faucet \
  --address ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb \
  --amount 1000 \
  --network testnet

# Verify balance
usernode-cli balance \
  --address ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb \
  --network testnet
```

**For mainnet production:**
- Coordinate with platform ops to transfer real funds to Guardian's mainnet address
- Minimum balance depends on expected transaction volume
- Balance is required only for token transfer feature

### 3. RPC Configuration (Automatic, Platform-Managed)

Guardian uses `NODE_RPC_URL` for sidecar RPC calls (token transfers only).

**This is automatically configured by the platform:**
- Production: Points to Usernode's production RPC endpoint
- Staging: Points to local sidecar at `host.docker.internal:3001`
- No action needed from admin — the platform manages this

Verify RPC connectivity:
```bash
# In production container
curl http://$NODE_RPC_URL/health

# Should return successful response confirming RPC availability
```

### 4. Optional: Custom Keypair (If Rotating Keys)

To generate a new keypair and rotate Guardian's identity:

```bash
# In the repo
node scripts/generate-guardian-keypair.js

# Output will show:
# - New PUBLIC KEY (ut1...)
# - New PRIVATE KEY SEED (64 hex)
# - Updated dapp.json entries
# - Usernode CLI registration command

# Register new keypair on blockchain
usernode-cli register-app \
  --name guardian \
  --pubkey ut1<new-address> \
  --network testnet
```

Then update Secrets with new values.

## Deployment Flow

### Staging Deployment

Staging automatically:
1. Uses `APP_PUBKEY` from dapp.json (public, non-sensitive)
2. Uses `staging_default` for `APP_SECRET_KEY` (dummy key: `guardian_sk_mqudwes5_ae613cf56214808e`)
3. Creates mock transactions with instant "confirmation"
4. Logs simulated blockchain activity

**Staging is always safe** — no real funds or transactions involved.

### Production Deployment

Production requires:

1. **Set APP_SECRET_KEY in platform Secrets**
   - Go to Guardian → Settings → Secrets
   - Set `APP_SECRET_KEY` = `19f0d93396a451665783ea26cc1bc65e6bb0fd33a5d1d8662ca0ca15478429e3`
   - Confirm encrypted storage (platform shows "✓ Set" only, never the value)

2. **Verify APP_PUBKEY is set**
   - Should be: `ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb`
   - Public, same as staging

3. **Redeploy production container**
   - Platform merges dapp.json + Secrets → environment variables
   - Guardian starts with real transaction capability

4. **Monitor first transactions**
   - Users send message/create group/transfer token
   - Wallet bridge appears → User confirms
   - Real tx hash → Audit log with pending status
   - Explorer polling starts (5s → 60s exponential backoff)
   - Transaction confirmed on-chain

### Blocking Issues

**Deployment will fail if:**
- `APP_SECRET_KEY` not set in Secrets (required + private)
- `APP_PUBKEY` not set in Secrets (required)
- `NODE_RPC_URL` not reachable (for token transfers)

**All other configuration is automatic** — the platform injects secrets and env vars correctly.

## Transaction Lifecycle

### Messages

1. User types message → Clicks Send
2. Frontend shows wallet confirmation modal
3. User approves → Bridge submits to chain
4. Backend receives real tx hash
5. Creates audit log with status `pending`
6. Polls explorer every 5 seconds (max 20 attempts)
7. On-chain confirmation → status = `confirmed`
8. Message marked as blockchain-recorded

### Groups

Same flow as messages, with group creation instead of message content.

### Token Transfers

1. User enters amount → Clicks Send
2. Wallet confirmation appears
3. User approves → Bridge broadcasts
4. Backend calls sidecar RPC `/wallet/send` to actually transfer tokens
5. Receives real tx hash from sidecar
6. Creates audit log + starts polling
7. On-chain confirmation completes flow

## Monitoring & Troubleshooting

### Check Transaction Status

Query audit logs directly:

```sql
-- In Guardian's database
SELECT 
  id, user_id, message_type, tx_hash, status, 
  created_at, confirmed_at
FROM blockchain_audit_logs
ORDER BY created_at DESC
LIMIT 10;
```

Expected statuses:
- `pending` — Awaiting chain confirmation (polling active)
- `confirmed` — Successfully recorded on-chain
- `failed` — Max polling attempts reached without confirmation

### Common Issues

**Transactions stuck in "pending"**
- Explorer API unreachable: Check `/explorer-api/testnet/transactions/{txHash}` endpoint
- Chain not finalizing: Contact testnet operators
- Polling timeout: Check logs for exponential backoff (5s → 60s → fail at 20 attempts)

**Token transfers failing**
- Insufficient balance: Seed `ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb` with testnet tokens
- Sidecar unreachable: Verify `NODE_RPC_URL` is set and responding
- Invalid recipient: Ensure token recipient is valid ut1 address

**Wallet bridge not appearing**
- Check browser console for errors
- Verify bridge.js loads from `social-vibecoding.usernodelabs.org`
- User not logged into wallet: They need to connect wallet before sending

### Logs to Monitor

```bash
# Container logs (platform dashboard)
# Watch for:
- "[Sidecar] Submitting payment tx" → RPC call made
- "[Bridge] Using submitted tx hash" → Frontend provided hash
- "[Chain Poller]" → Polling progress
- "Transaction confirmed" → Success
- "Max polling attempts exceeded" → Failure

# Database audit logs:
SELECT error_message FROM blockchain_audit_logs 
WHERE status = 'failed' AND error_message IS NOT NULL;
```

## Security Notes

### APP_SECRET_KEY Handling

- **Never commit to git** (already marked `private: true` in dapp.json)
- **Never log to stdout** (code filters it from logs)
- **Only used for signing** (not for decryption or key derivation)
- **Staging gets dummy key** (not the production value)
- **Encrypted at rest** in platform Secrets (AES-256-GCM)

### Bridge Security

- Guardian trusts Usernode's wallet bridge for wallet confirmation
- Bridge is centrally hosted and updated by platform
- Users see native wallet UI (no Guardian-controlled approval)
- Transactions are cryptographically signed by user's wallet

### Audit Trail

All blockchain-related activity recorded in `blockchain_audit_logs`:
- User ID, app pubkey, transaction hash
- Complete transaction payload (memo, content hash)
- Creation and confirmation timestamps
- Status history (pending → confirmed/failed)

Never delete or modify audit logs — they're the compliance record.

## Verification Checklist

Before declaring production deployment complete:

- [ ] APP_SECRET_KEY set in platform Secrets
- [ ] APP_PUBKEY set and matches `ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb`
- [ ] Guardian's testnet address seeded with balance (if using tokens)
- [ ] Container redeployed after Secrets configured
- [ ] User sends test message → Wallet appears → Bridge confirms
- [ ] Explorer shows real transaction (not demo hash)
- [ ] Audit log shows pending → confirmed status
- [ ] Logs show chain polling and confirmation
- [ ] Token transfer test succeeds (if enabled)

## Support

- **Platform issues:** Contact Usernode platform ops
- **Bridge not loading:** Check browser security console for errors
- **RPC failures:** Verify NODE_RPC_URL environment variable
- **Transaction stuck:** Review /explorer-api endpoint responses
- **Audit log errors:** Check blockchain_audit_logs.error_message column

## References

- [Usernode Platform Conventions](https://social-vibecoding.usernodelabs.org/claude.md)
- [GUARDIAN_KEYPAIR.md](./GUARDIAN_KEYPAIR.md) — Keypair generation and format
- [PRODUCTION_SIMULATION_TEST.md](./PRODUCTION_SIMULATION_TEST.md) — Test endpoint documentation
- [dapp.json](./dapp.json) — Secrets configuration manifest
