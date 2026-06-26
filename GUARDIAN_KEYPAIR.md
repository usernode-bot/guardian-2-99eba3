# Guardian Usernode Keypair Configuration

## Overview

Guardian 2 has been configured with a valid ED25519 keypair following the Usernode blockchain format. This document explains the keypair structure, how to use it, and how to regenerate keypairs if needed.

## Generated Keypair

Guardian's initial keypair (generated via `scripts/generate-guardian-keypair.js`):

### Public Key (APP_PUBKEY)
- **Address**: `ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb`
- **Hex**: `de162bdd98bd8586bea321be9ebaeb13a467971e5b237ba57ed0b817f7250214`
- **Type**: ED25519 public key in Usernode `ut1...` format
- **Status**: Public (non-private in dapp.json)

### Secret Key (APP_SECRET_KEY)
- **Seed (Hex)**: `19f0d93396a451665783ea26cc1bc65e6bb0fd33a5d1d8662ca0ca15478429e3`
- **Staging Default**: `guardian_sk_mqudwes5_ae613cf56214808e`
- **Type**: ED25519 private key seed (32 bytes)
- **Status**: Private (encrypted at rest in platform Secrets)

## Configuration

### dapp.json Secrets

```json
{
  "key": "APP_PUBKEY",
  "description": "Guardian app's Usernode public key (ut1...) for on-chain transaction signing and identification. Generated ED25519 keypair for Guardian.",
  "required": true,
  "private": false,
  "default": "ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb"
},
{
  "key": "APP_SECRET_KEY",
  "description": "Guardian app's ED25519 secret key seed for signing transactions on Usernode blockchain (64 hex chars, production only)",
  "required": true,
  "private": true,
  "staging_default": "guardian_sk_mqudwes5_ae613cf56214808e"
}
```

### Runtime Defaults (server.js)

```javascript
const APP_PUBKEY = process.env.APP_PUBKEY || 'ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb';
const APP_SECRET_KEY = process.env.APP_SECRET_KEY || 'guardian_sk_mqudwes5_ae613cf56214808e';
```

## Deployment

### Staging Environment
- **APP_PUBKEY**: Uses `dapp.json` default (`ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb`)
- **APP_SECRET_KEY**: Uses `staging_default` (`guardian_sk_mqudwes5_ae613cf56214808e`)
- **Mode**: Demo mode enabled by default
- **Behavior**: Mock Usernode explorer, instant transaction confirmation

### Production Environment
- **APP_PUBKEY**: Must be set in platform Secrets (typically same as staging)
- **APP_SECRET_KEY**: Must be set in platform Secrets with the real seed hex: `19f0d93396a451665783ea26cc1bc65e6bb0fd33a5d1d8662ca0ca15478429e3`
- **Mode**: Real Usernode blockchain integration
- **Behavior**: Real explorer API calls, exponential backoff polling, actual transaction hashes

## Registration on Usernode Blockchain

To register this Guardian keypair on the Usernode blockchain:

```bash
usernode-cli register-app \
  --name guardian \
  --pubkey ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb \
  --network testnet
```

For mainnet:
```bash
usernode-cli register-app \
  --name guardian \
  --pubkey ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb \
  --network mainnet
```

## Keypair Format Details

### Public Key (ut1... Address)
- **Format**: Base58-encoded ED25519 public key with `ut1` prefix
- **Length**: ~43-47 characters total
- **Structure**: `ut1` + base58(32-byte-public-key)
- **Usage**: On-chain transaction signing, app identification

### Private Key Seed
- **Format**: 64 hexadecimal characters (32 bytes)
- **Length**: Exactly 64 hex characters
- **Structure**: Raw ED25519 seed material
- **Usage**: Cryptographic signing of transaction memos (deferred implementation)
- **Security**: Must be kept secret; stored encrypted in platform Secrets

## Regenerating a New Keypair

To generate a new keypair for Guardian:

```bash
node scripts/generate-guardian-keypair.js
```

This will output:
1. New public key in `ut1...` format
2. Private key seed in hex format
3. Updated values for `dapp.json`
4. Staging default for demo mode
5. Usernode CLI registration command

## Implementation Notes

### Current Behavior
- APP_SECRET_KEY is defined but not yet actively used for cryptographic signing
- Transaction memos are created following the Last One Wins pattern: `{ app: "guardian", type, senderId, timestamp, contentHash }`
- Memos are currently JSON-stringified (not cryptographically signed)

### Future Enhancement
- Integrate APP_SECRET_KEY for real cryptographic signing of transaction memos
- Use ED25519 signature scheme to verify memo integrity on-chain
- Implement memo validation in transaction verification workflows

## Security Considerations

### Staging Environment
- `staging_default` is a dummy key for demo purposes
- Safe to commit to repository
- No real funds or data at risk

### Production Environment
- APP_SECRET_KEY must be stored in platform Secrets (encrypted at rest)
- Never commit real secrets to git
- The `staging_default` value is isolated from production
- Production deployment requires explicit secret configuration

## Testing the Keypair

### Verify Public Key Format
```javascript
const publicKey = 'ut1Fww7onqF9LsRSb6d6BozgQWtjNYqQJghYxXmBc8foncb';
console.assert(publicKey.startsWith('ut1'), 'Valid Usernode address');
console.assert(publicKey.length > 40, 'Valid length');
```

### Verify Private Key Format
```javascript
const privateKey = '19f0d93396a451665783ea26cc1bc65e6bb0fd33a5d1d8662ca0ca15478429e3';
console.assert(privateKey.length === 64, 'Valid hex length');
console.assert(/^[0-9a-f]{64}$/.test(privateKey), 'Valid hex characters');
```

## Related Files

- `scripts/generate-guardian-keypair.js` — Keypair generation utility
- `dapp.json` — APP_PUBKEY and APP_SECRET_KEY configuration
- `server.js` (lines 17-19) — Runtime default values
- `CLAUDE.md` — Guardian app conventions

## References

- [Usernode Platform Conventions](https://social-vibecoding.usernodelabs.org/claude.md)
- [ED25519 Signature Scheme](https://en.wikipedia.org/wiki/Curve25519#Ed25519)
- [Base58 Encoding](https://en.wikipedia.org/wiki/Binary-to-text_encoding#Base58Check_encoding)
