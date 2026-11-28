import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger, sanitize } from './src/logger.js';

test('local logs redact credentials and URL paths', () => {
  const clean = sanitize('wss://user:pass@example.com/rtc?access_token=sensitive password=private Bearer hidden');
  assert.match(clean, /wss:\/\/example.com/);
  for (const secret of ['user:pass', '/rtc', 'sensitive', 'private', 'hidden']) assert.ok(!clean.includes(secret), secret);
});

test('operational logs still reach stdout without a collector', () => {
  const original = process.stdout.write;
  let output = '';
  process.stdout.write = chunk => { output += chunk; return true; };
  try { logger.error('password=private', new Error('secret detail')); }
  finally { process.stdout.write = original; }
  const record = JSON.parse(output);
  assert.equal(record.severity, 'ERROR');
  assert.ok(record.timestamp);
  assert.ok(!record.message.includes('private'));
  assert.ok(!record.message.includes('secret detail'));
});
