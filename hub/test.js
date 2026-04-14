#!/usr/bin/env node
// Quick integration test — two PAN instances connect, authenticate, and exchange a message

import crypto from 'crypto';
import WebSocket from 'ws';
import { initDb } from './src/db.js';
import { createServer } from './src/server.js';

const PORT = 19999;
const DATA_DIR = './data-test';

// ─── Helpers ───

function makeIdentity() {
  const kp = crypto.generateKeyPairSync('ed25519');
  const rawPub = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
  const pubBase64 = rawPub.toString('base64');
  const hash = crypto.createHash('sha256').update(rawPub).digest('hex');
  const id = 'pan_' + hash.slice(0, 16);
  return { id, pubBase64, privateKey: kp.privateKey };
}

function signChallenge(privateKey, nonce, timestamp, instanceId) {
  const message = Buffer.from(`${nonce}|${timestamp}|${instanceId}`);
  return crypto.sign(null, message, privateKey).toString('base64');
}

function connectAndAuth(url, identity) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'challenge') {
        const timestamp = new Date().toISOString();
        const signature = signChallenge(identity.privateKey, msg.nonce, timestamp, identity.id);
        ws.send(JSON.stringify({
          type: 'auth',
          instanceId: identity.id,
          publicKey: identity.pubBase64,
          nonce: msg.nonce,
          timestamp,
          signature
        }));
      }

      if (msg.type === 'auth_ok') {
        clearTimeout(timeout);
        resolve({ ws, msg });
      }

      if (msg.type === 'auth_failed') {
        clearTimeout(timeout);
        reject(new Error(msg.error));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ─── Test ───

async function test() {
  console.log('=== PAN Hub Integration Test ===\n');

  // Start server
  initDb(DATA_DIR);
  const { server } = createServer(PORT, DATA_DIR);
  await new Promise(r => setTimeout(r, 500));

  const alice = makeIdentity();
  const bob = makeIdentity();
  console.log(`Alice: ${alice.id}`);
  console.log(`Bob:   ${bob.id}\n`);

  // Test 1: Alice connects and registers
  console.log('Test 1: Alice connects and authenticates...');
  const aliceConn = await connectAndAuth(`ws://127.0.0.1:${PORT}/ws`, alice);
  console.log(`  ✓ Alice authenticated (registered: ${aliceConn.msg.registered})\n`);

  // Test 2: Bob connects and registers
  console.log('Test 2: Bob connects and authenticates...');
  const bobConn = await connectAndAuth(`ws://127.0.0.1:${PORT}/ws`, bob);
  console.log(`  ✓ Bob authenticated (registered: ${bobConn.msg.registered})\n`);

  // Test 3: Alice sends a direct message to Bob
  console.log('Test 3: Alice sends message to Bob...');
  const messageReceived = new Promise((resolve) => {
    bobConn.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'message') resolve(msg.envelope);
    });
  });

  aliceConn.ws.send(JSON.stringify({
    type: 'message',
    envelope: {
      to: bob.id,
      type: 'direct',
      payload: 'dGVzdCBtZXNzYWdl' // "test message" base64
    }
  }));

  const received = await messageReceived;
  console.log(`  ✓ Bob received message from ${received.from}`);
  console.log(`  ✓ Payload: ${received.payload}\n`);

  // Test 4: Health endpoint
  console.log('Test 4: Health endpoint...');
  const healthRes = await fetch(`http://127.0.0.1:${PORT}/health`);
  const health = await healthRes.json();
  console.log(`  ✓ Status: ${health.status}, Instances: ${health.instances.total} total, ${health.instances.online} online\n`);

  // Test 5: Message to offline instance gets queued
  console.log('Test 5: Message to offline instance gets queued...');
  const charlie = makeIdentity();
  // Register Charlie but don't keep connected
  const charlieConn = await connectAndAuth(`ws://127.0.0.1:${PORT}/ws`, charlie);
  charlieConn.ws.close();
  await new Promise(r => setTimeout(r, 200));

  // Wait for ack
  const ackPromise = new Promise((resolve) => {
    aliceConn.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'message_ack') resolve(msg);
    });
  });

  aliceConn.ws.send(JSON.stringify({
    type: 'message',
    envelope: {
      to: charlie.id,
      type: 'direct',
      payload: 'b2ZmbGluZSBtc2c=' // "offline msg" base64
    }
  }));

  const ack = await ackPromise;
  console.log(`  ✓ Message queued: ${ack.queued}, ID: ${ack.msgId}\n`);

  // Test 6: Charlie reconnects and gets queued message
  console.log('Test 6: Charlie reconnects and receives queued message...');
  const queuedMessage = new Promise((resolve) => {
    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws2.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'challenge') {
        const ts = new Date().toISOString();
        const sig = signChallenge(charlie.privateKey, msg.nonce, ts, charlie.id);
        ws2.send(JSON.stringify({
          type: 'auth', instanceId: charlie.id, publicKey: charlie.pubBase64,
          nonce: msg.nonce, timestamp: ts, signature: sig
        }));
      }
      if (msg.type === 'message') {
        resolve(msg.envelope);
        ws2.close();
      }
    });
  });

  const queuedEnvelope = await queuedMessage;
  console.log(`  ✓ Charlie received queued message from ${queuedEnvelope.from}`);
  console.log(`  ✓ Was queued: ${queuedEnvelope.queued}\n`);

  // Test 7: Federation — Alice registers an org
  console.log('Test 7: Org federation...');
  const orgResult = new Promise((resolve) => {
    aliceConn.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'org_register_result') resolve(msg);
    });
  });

  aliceConn.ws.send(JSON.stringify({
    type: 'org_register',
    orgId: 'org_test_project',
    nameEncrypted: 'encrypted_name_here'
  }));

  const orgRes = await orgResult;
  console.log(`  ✓ Org registered: ${orgRes.ok}\n`);

  // Test 8: Alice adds Bob to the org
  console.log('Test 8: Add Bob to org...');
  const addResult = new Promise((resolve) => {
    aliceConn.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'org_add_member_result') resolve(msg);
    });
  });

  aliceConn.ws.send(JSON.stringify({
    type: 'org_add_member',
    orgId: 'org_test_project',
    memberInstanceId: bob.id
  }));

  const addRes = await addResult;
  console.log(`  ✓ Bob added to org: ${addRes.ok}\n`);

  // Cleanup
  aliceConn.ws.close();
  bobConn.ws.close();
  server.close();

  console.log('=== All tests passed! ===');

  // Clean up test data
  const { rmSync } = await import('fs');
  try { rmSync(DATA_DIR, { recursive: true }); } catch {}

  process.exit(0);
}

test().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
