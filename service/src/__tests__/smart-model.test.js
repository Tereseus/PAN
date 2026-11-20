import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthStatus, smartModelState, claudeProgram } from '../smart-model.js';

test('the status the program prints when nobody is signed in', () => {
  assert.deepEqual(parseAuthStatus('{\n  "loggedIn": false,\n  "authMethod": "none",\n  "apiProvider": "firstParty"\n}'), { loggedIn: false, method: 'none' });
});

test('the status when signed in, with other lines around it and an email that is not passed on', () => {
  const s = parseAuthStatus('warning: something\n{"loggedIn": true, "authMethod": "claude.ai", "email": "someone@example.com"}\n');
  assert.deepEqual(s, { loggedIn: true, method: 'claude.ai' });
});

test('anything else is not a status', () => {
  assert.equal(parseAuthStatus(''), null);
  assert.equal(parseAuthStatus('Error: not found'), null);
  assert.equal(parseAuthStatus('{"loggedIn": "yes"}'), null);
  assert.equal(parseAuthStatus('{broken'), null);
});

test('signed in is connected', () => {
  const s = smartModelState({ program: true, status: { loggedIn: true, method: 'claude.ai' } });
  assert.equal(s.state, 'connected');
  assert.equal(s.connected, true);
  assert.equal(s.fix, null);
});

test('signed out says what still works and what does not', () => {
  const s = smartModelState({ program: true, status: { loggedIn: false, method: 'none' } });
  assert.equal(s.state, 'signed_out');
  assert.equal(s.connected, false);
  assert.equal(s.fix, 'sign_in');
  assert.match(s.say, /still talks/);
});

test('no program is a broken install, and no answer is not taken for signed out', () => {
  assert.equal(smartModelState({ program: false, status: null }).state, 'missing');
  const s = smartModelState({ program: true, status: null });
  assert.equal(s.state, 'unknown');
  assert.equal(s.connected, false);
});

test('the Claude program comes with PAN', () => {
  assert.match(String(claudeProgram()), /claude-agent-sdk[\\/]cli\.js$/);
});
