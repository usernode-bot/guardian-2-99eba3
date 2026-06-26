#!/usr/bin/env node

/**
 * Guardian Usernode Keypair Generator
 * Generates ED25519 keypair in Usernode format for Guardian app
 * Usage: node scripts/generate-guardian-keypair.js
 */

const crypto = require('crypto');

// Base58 encoding for Usernode addresses
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58encode(buf) {
  if (buf.length === 0) return '';
  let num = 0n;
  for (let i = 0; i < buf.length; i++) {
    num = num * 256n + BigInt(buf[i]);
  }
  let encoded = '';
  while (num > 0n) {
    encoded = ALPHABET[Number(num % 58n)] + encoded;
    num = num / 58n;
  }
  for (let i = 0; i < buf.length && buf[i] === 0; i++) {
    encoded = '1' + encoded;
  }
  return encoded;
}

function extractED25519PublicKeyBytes(publicKeyPEM) {
  // Parse PEM to extract DER
  const base64 = publicKeyPEM
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s/g, '');
  const der = Buffer.from(base64, 'base64');

  // ED25519 public key in SPKI format:
  // For ED25519: the last 32 bytes are the public key
  return der.slice(-32);
}

function extractED25519PrivateKeyBytes(privateKeyPEM) {
  // Parse PEM to extract DER
  const base64 = privateKeyPEM
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const der = Buffer.from(base64, 'base64');

  // ED25519 private key in PKCS8 format:
  // The last 32 bytes are the seed (which generates both private and public key)
  return der.slice(-32);
}

function generateUsernodeKeypair() {
  // Generate ED25519 keypair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  // Export as PEM
  const publicKeyPEM = publicKey.export({ format: 'pem', type: 'spki' });
  const privateKeyPEM = privateKey.export({ format: 'pem', type: 'pkcs8' });

  // Extract raw bytes
  const publicKeyBytes = extractED25519PublicKeyBytes(publicKeyPEM);
  const privateKeySeed = extractED25519PrivateKeyBytes(privateKeyPEM);

  // Encode public key as ut1<base58>
  const publicKeyBase58 = base58encode(publicKeyBytes);
  const utPublicKey = `ut1${publicKeyBase58}`;

  // For production: store the full private key PEM or seed as hex
  const privateKeyHex = privateKeySeed.toString('hex');

  // For staging: create a demo key in Guardian format
  const stagingKeyFormat = `guardian_sk_${Date.now().toString(36)}_${crypto
    .randomBytes(8)
    .toString('hex')}`;

  return {
    publicKey: utPublicKey,
    publicKeyHex: publicKeyBytes.toString('hex'),
    publicKeyBase58: publicKeyBase58,
    privateKeyHex: privateKeyHex,
    privateKeyPEM: privateKeyPEM,
    stagingDefault: stagingKeyFormat
  };
}

function main() {
  console.log('\n====================================');
  console.log('Guardian Usernode Keypair Generator');
  console.log('====================================\n');

  const keypair = generateUsernodeKeypair();

  console.log('✓ Generated ED25519 Keypair\n');

  console.log('PUBLIC KEY (ut1... format):');
  console.log(`  ${keypair.publicKey}\n`);

  console.log('PUBLIC KEY (Hex):');
  console.log(`  ${keypair.publicKeyHex}\n`);

  console.log('PRIVATE KEY SEED (Hex - KEEP SECURE):');
  console.log(`  ${keypair.privateKeyHex}\n`);

  console.log('STAGING DEFAULT (Demo Key):');
  console.log(`  ${keypair.stagingDefault}\n`);

  console.log('====================================');
  console.log('Configuration for dapp.json:');
  console.log('====================================\n');

  console.log('APP_PUBKEY (non-private, public address):');
  console.log(`  "default": "${keypair.publicKey}"\n`);

  console.log('APP_SECRET_KEY (private, signing key):');
  console.log(`  "staging_default": "${keypair.stagingDefault}"\n`);

  console.log('PRODUCTION DEPLOYMENT:');
  console.log('  Store in platform Secrets → Settings → Secrets:');
  console.log(`  APP_SECRET_KEY = ${keypair.privateKeyHex}\n`);

  console.log('USERNODE CLI REGISTRATION:');
  console.log('  Register this Guardian keypair on blockchain:');
  console.log(`  usernode-cli register-app --name guardian --pubkey ${keypair.publicKey} --network testnet\n`);

  console.log('====================================\n');

  return keypair;
}

if (require.main === module) {
  main();
}

module.exports = { generateUsernodeKeypair, base58encode };
