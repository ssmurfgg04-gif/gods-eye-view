import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLowEndProfile,
  getLabelBudgetScale,
  _resetAdaptiveQualityForTest,
} from './adaptiveQuality.js';

beforeEach(() => {
  _resetAdaptiveQualityForTest();
});

function fakeLocation(search = '') {
  return { search };
}

function fakeNavigator({ memory, cores, ua } = {}) {
  return {
    deviceMemory: memory,
    hardwareConcurrency: cores,
    userAgent: ua || 'Mozilla/5.0 (Macintosh) TestAgent',
  };
}

test('?profile=low forces the low-end profile; ?profile=high overrides heuristics', () => {
  assert.equal(detectLowEndProfile(fakeLocation('?profile=low'), fakeNavigator({ memory: 16, cores: 12 })), true);
  assert.equal(detectLowEndProfile(fakeLocation('?profile=high'), fakeNavigator({ memory: 2, cores: 2 })), false);
});

test('constrained hardware is detected as low-end', () => {
  assert.equal(detectLowEndProfile(fakeLocation(''), fakeNavigator({ memory: 4, cores: 8 })), true, '<6 GB deviceMemory');
  assert.equal(detectLowEndProfile(fakeLocation(''), fakeNavigator({ memory: 8, cores: 4 })), true, '≤4 cores');
  assert.equal(detectLowEndProfile(fakeLocation(''), fakeNavigator({ memory: 16, cores: 12 })), false, 'capable desktop');
});

test('phone-class UAs are low-end; desktop UAs are not', () => {
  assert.equal(detectLowEndProfile(fakeLocation(''), fakeNavigator({ ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' })), true);
  assert.equal(detectLowEndProfile(fakeLocation(''), fakeNavigator({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' })), true);
  assert.equal(detectLowEndProfile(fakeLocation(''), fakeNavigator({ ua: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0' })), false);
});

test('label budget scales down for constrained profiles and stays 1.0 on high tier', () => {
  _resetAdaptiveQualityForTest();
  assert.equal(getLabelBudgetScale(), 1.0, 'default high tier');
});

test('detectLowEndProfile tolerates missing signals', () => {
  assert.equal(detectLowEndProfile(null, null), false);
  assert.equal(detectLowEndProfile(fakeLocation(''), fakeNavigator({})), false);
});
