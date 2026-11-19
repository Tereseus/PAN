// node --test service/src/__tests__/listen-host.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listenHost, listenWords, THIS_COMPUTER, openToNetwork, answersDiscovery, addsOwnFirewallRule } from '../listen-host.js';

test('a fresh PAN listens on this computer only', () => {
  assert.equal(listenHost({}), '127.0.0.1');
  assert.equal(listenHost({ PAN_HOST: '' }), '127.0.0.1');
  assert.equal(listenHost({ PAN_HOST: '   ' }), '127.0.0.1');
});

test('open to the network only when asked', () => {
  assert.equal(listenHost({ PAN_HOST: '0.0.0.0' }), '0.0.0.0');
  assert.equal(listenHost({ PAN_HOST: ' 0.0.0.0 ' }), '0.0.0.0');
  assert.equal(listenHost({ PAN_HOST: '127.0.0.1' }), '127.0.0.1');
});

test('the log says who can reach it', () => {
  assert.match(listenWords(THIS_COMPUTER), /this computer only/);
  assert.match(listenWords('0.0.0.0'), /anyone who reaches it is treated as the owner/);
});

test('a PAN on this computer only adds no firewall rule and answers no discovery', () => {
  for (const env of [{}, { PAN_HOST: '127.0.0.1' }, { PAN_HOST: 'localhost' }, { PAN_HOST: '::1' }]) {
    assert.equal(openToNetwork(env), false);
    assert.equal(answersDiscovery(env), false);
    assert.equal(addsOwnFirewallRule(env), false);
  }
});

test('an open PAN may, but a Craft never adds a rule for its inner port', () => {
  assert.equal(answersDiscovery({ PAN_HOST: '0.0.0.0' }), true);
  assert.equal(addsOwnFirewallRule({ PAN_HOST: '0.0.0.0' }), true);
  assert.equal(addsOwnFirewallRule({ PAN_HOST: '0.0.0.0', PAN_CRAFT: '1' }), false);
  assert.equal(answersDiscovery({ PAN_HOST: '0.0.0.0', PAN_CRAFT: '1' }), true);
});
