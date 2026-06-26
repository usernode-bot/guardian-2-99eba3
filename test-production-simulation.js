#!/usr/bin/env node

/**
 * Guardian Production Simulation Test
 *
 * This script:
 * 1. Starts the Guardian app locally in staging mode
 * 2. Calls the production simulation endpoint
 * 3. Displays comprehensive test results to stdout
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

function log(text, color = 'reset') {
  console.log(`${colors[color]}${text}${colors.reset}`);
}

function logSection(title) {
  console.log();
  log(`${'═'.repeat(70)}`, 'cyan');
  log(title, 'cyan');
  log(`${'═'.repeat(70)}`, 'cyan');
}

function logSubsection(title) {
  log(`\n${'─'.repeat(70)}`, 'gray');
  log(title, 'blue');
  log(`${'─'.repeat(70)}`, 'gray');
}

async function waitForServer(port, timeout = 30000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/health`, (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`Health check returned ${res.statusCode}`));
          }
        });
        req.on('error', reject);
        req.setTimeout(1000);
      });
      return true;
    } catch (err) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('Server failed to start within timeout');
}

async function callTestEndpoint(port) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: port,
      path: '/api/test/production-simulation',
      method: 'GET',
      timeout: 30000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Failed to parse response: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

function formatTestResult(test) {
  const statusIcon = test.status === 'pass' ? '✓' : '✗';
  const statusColor = test.status === 'pass' ? 'green' : 'red';
  return `  ${colors[statusColor]}${statusIcon}${colors.reset} ${test.status.toUpperCase()}`;
}

function displayResults(results) {
  logSection('GUARDIAN PRODUCTION SIMULATION TEST RESULTS');

  log(`Test Name: ${results.testName}`, 'yellow');
  log(`Timestamp: ${results.timestamp}`, 'yellow');
  log(`Status: ${results.success ? 'PASS' : 'FAIL'}`, results.success ? 'green' : 'red');

  logSubsection('Test Phases');

  // Message Creation
  if (results.tests.messageCreation) {
    log('\n1. Message Creation', 'bright');
    log(formatTestResult(results.tests.messageCreation));
    if (results.tests.messageCreation.messageId) {
      log(`   Message ID: ${results.tests.messageCreation.messageId}`, 'gray');
      log(`   Sender ID: ${results.tests.messageCreation.senderId}`, 'gray');
    }
  }

  // Memo Signing
  if (results.tests.memoSigning) {
    log('\n2. Transaction Memo Signing', 'bright');
    log(formatTestResult(results.tests.memoSigning));
    if (results.tests.memoSigning.memo) {
      log(`   Memo Format: ${results.tests.memoSigning.format}`, 'gray');
      log(`   Memo:`, 'gray');
      log(`     {`, 'gray');
      log(`       app: "${results.tests.memoSigning.memo.app}"`, 'gray');
      log(`       type: "${results.tests.memoSigning.memo.type}"`, 'gray');
      log(`       senderId: ${results.tests.memoSigning.memo.senderId}`, 'gray');
      log(`       timestamp: ${results.tests.memoSigning.memo.timestamp}`, 'gray');
      log(`       contentHash: "${results.tests.memoSigning.memo.contentHash?.slice(0, 16)}..."`, 'gray');
      log(`     }`, 'gray');
      log(`   Content Hash: ${results.tests.memoSigning.contentHash}`, 'gray');
    }
  }

  // Transaction Hash Generation
  if (results.tests.transactionGeneration) {
    log('\n3. Transaction Hash Generation', 'bright');
    log(formatTestResult(results.tests.transactionGeneration));
    if (results.tests.transactionGeneration.transactionHash) {
      log(`   Transaction Hash: ${results.tests.transactionGeneration.transactionHash}`, 'gray');
      log(`   Chain: ${results.tests.transactionGeneration.chain}`, 'gray');
    }
  }

  // Audit Log Insertion
  if (results.tests.auditLogInsertion) {
    log('\n4. Blockchain Audit Log Insertion', 'bright');
    log(formatTestResult(results.tests.auditLogInsertion));
    if (results.tests.auditLogInsertion.auditLogId) {
      log(`   Audit Log ID: ${results.tests.auditLogInsertion.auditLogId}`, 'gray');
      log(`   Initial Status: ${results.tests.auditLogInsertion.initialStatus}`, 'gray');
      log(`   Created At: ${results.tests.auditLogInsertion.createdAt}`, 'gray');
    }
  }

  // Explorer API
  if (results.tests.explorerAPI) {
    log('\n5. Explorer API Integration', 'bright');
    log(formatTestResult(results.tests.explorerAPI));
    if (results.tests.explorerAPI.response) {
      log(`   Response:`, 'gray');
      log(`     ${JSON.stringify(results.tests.explorerAPI.response, null, 8).split('\n').join('\n     ')}`, 'gray');
    }
  }

  // Chain Polling
  if (results.tests.chainPolling) {
    log('\n6. Chain Polling and Confirmation', 'bright');
    log(formatTestResult(results.tests.chainPolling));
    if (results.tests.chainPolling.pollResult) {
      log(`   Poll Result:`, 'gray');
      log(`     Status: ${results.tests.chainPolling.pollResult.status}`, 'gray');
      log(`     Block Number: ${results.tests.chainPolling.pollResult.blockNumber}`, 'gray');
    }
    if (results.tests.chainPolling.confirmationTimeMs) {
      log(`   Confirmation Time: ${results.tests.chainPolling.confirmationTimeMs}ms`, 'gray');
      log(`   Poll Duration: ${results.tests.chainPolling.pollDurationMs}ms`, 'gray');
      log(`   Final Status: ${results.tests.chainPolling.finalStatus}`, 'gray');
    }
  }

  // Final Verification
  if (results.tests.finalAuditLogVerification) {
    log('\n7. Final Audit Log Verification', 'bright');
    log(formatTestResult(results.tests.finalAuditLogVerification));
    if (results.tests.finalAuditLogVerification.auditLog) {
      const al = results.tests.finalAuditLogVerification.auditLog;
      log(`   Audit Log State:`, 'gray');
      log(`     ID: ${al.id}`, 'gray');
      log(`     Status: ${al.status}`, 'gray');
      log(`     TX Hash: ${al.txHash}`, 'gray');
      log(`     Content Hash: ${al.contentHash?.slice(0, 16)}...`, 'gray');
      log(`     App Pubkey: ${al.appPubkey}`, 'gray');
      log(`     Created: ${al.createdAt}`, 'gray');
      log(`     Confirmed: ${al.confirmedAt}`, 'gray');
    }
  }

  // Summary
  if (results.summary) {
    logSubsection('Test Summary');
    log(`Total Tests: ${results.summary.testCount}`, 'bright');
    log(`Passed: ${results.summary.passedCount}`, 'green');
    log(`Failed: ${results.summary.failedCount}`, results.summary.failedCount > 0 ? 'red' : 'gray');
    log(`Total Duration: ${results.summary.totalDurationMs}ms`, 'bright');

    if (results.summary.testsRun) {
      log('\nTests Run:', 'bright');
      results.summary.testsRun.forEach(test => {
        log(`  ${test}`, 'green');
      });
    }
  }

  logSection('TEST COMPLETE');
  if (results.success) {
    log(`✓ All tests passed!`, 'green');
  } else {
    log(`✗ Some tests failed!`, 'red');
  }
  log(`Status: ${results.success ? 'PASS' : 'FAIL'}`, results.success ? 'green' : 'red');
}

async function main() {
  // Use inloop environment if available, otherwise fallback
  const port = process.env.INLOOP_PORT || process.env.PORT || 3000;
  const dbUrl = process.env.INLOOP_DATABASE_URL || process.env.DATABASE_URL;
  const envMode = process.env.INLOOP_ENV || 'staging';

  log(`\n${'═'.repeat(70)}`, 'cyan');
  log(`Guardian Production Simulation Test Runner`, 'cyan');
  log(`${'═'.repeat(70)}`, 'cyan');

  // Start the server
  log(`\n▶ Starting Guardian server in staging mode...`, 'yellow');
  log(`  Environment: USERNODE_ENV=${envMode}`, 'gray');
  log(`  Port: ${port}`, 'gray');
  log(`  Database: ${dbUrl ? 'PostgreSQL' : 'Attempting to connect...'}`, 'gray');

  const env = {
    ...process.env,
    USERNODE_ENV: envMode,
    PORT: port.toString()
  };

  if (dbUrl) {
    env.DATABASE_URL = dbUrl;
  }

  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  server.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg && !msg.includes('Listen on') && !msg.includes('DeprecationWarning')) {
      log(`  [server] ${msg}`, 'gray');
    }
  });

  try {
    // Wait for server to be ready
    log(`\n▶ Waiting for server to start...`, 'yellow');
    await waitForServer(port);
    log(`✓ Server is ready!`, 'green');

    // Call the production simulation endpoint
    log(`\n▶ Calling production simulation endpoint...`, 'yellow');
    const results = await callTestEndpoint(port);

    // Display results
    displayResults(results);

    process.exit(results.success ? 0 : 1);
  } catch (err) {
    log(`\n✗ Error: ${err.message}`, 'red');
    process.exit(1);
  } finally {
    server.kill();
  }
}

main().catch(err => {
  log(`Fatal error: ${err.message}`, 'red');
  process.exit(1);
});
