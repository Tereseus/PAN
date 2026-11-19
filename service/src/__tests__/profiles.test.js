// node --test service/src/__tests__/profiles.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { featureOn, captureDefault } from '../profiles.js';

const WATCHERS = ['remote_screen', 'dashboard_watchdog', 'dashboard_health', 'vision_verifier', 'forge_dashboard'];

test('nothing looks at a screen by itself, in any profile', () => {
  for (const profile of ['full', 'core', 'wearable']) {
    for (const name of WATCHERS) assert.equal(featureOn(name, profile, {}), false, `${name} in ${profile}`);
    for (const name of ['identity', 'screen', 'activity']) assert.equal(captureDefault(name, profile), false);
  }
});

test('one of them comes on only when asked for by name', () => {
  assert.equal(featureOn('remote_screen', 'full', { PAN_ENABLE_REMOTE_SCREEN: '1' }), true);
  assert.equal(featureOn('remote_screen', 'full', { PAN_ENABLE_REMOTE_SCREEN: '0' }), false);
  assert.equal(featureOn('vision_verifier', 'full', { PAN_ENABLE_REMOTE_SCREEN: '1' }), false);
  assert.equal(featureOn('public_tunnel', 'full', {}), false);
});

test('the rest of the profiles are as they were', () => {
  assert.equal(featureOn('claude_control', 'full', {}), true);
  assert.equal(featureOn('claude_control', 'wearable', {}), true);
  assert.equal(featureOn('claude_control', 'core', {}), false);
  assert.equal(featureOn('terminal_server', 'wearable', {}), false);
  assert.equal(featureOn('dashboard_ui', 'core', {}), true);
  assert.equal(featureOn('something_not_listed', 'core', {}), true);
});
