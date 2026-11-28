import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVersion } from './desktop-version.mjs';

const defaults = { refType: 'branch', refName: 'main', baseVersion: '0.1.0-alpha', tags: [], headTags: [] };

test('main creates a stable patch release even without existing tags', () => {
  assert.deepEqual(resolveVersion(defaults), { version: '0.1.1', tag: 'v0.1.1', release: true });
});

test('next version uses numeric ordering and considers manual prerelease tags', () => {
  const result = resolveVersion({ ...defaults, tags: ['v0.1.9', 'v0.1.10', 'beta-0.2.0', 'other'] });
  assert.equal(result.version, '0.2.1');
});

test('rerunning a published commit reuses its tag', () => {
  const result = resolveVersion({ ...defaults, tags: ['v0.1.2', 'v0.1.3'], headTags: ['v0.1.2'] });
  assert.equal(result.tag, 'v0.1.2');
});

for (const [tag, version] of [['v1.2.3', '1.2.3'], ['alpha-0.2.0', '0.2.0-alpha'], ['beta-0.2.0', '0.2.0-beta'], ['rc-0.2.0', '0.2.0-rc']]) {
  test(`manual tag ${tag} keeps its version`, () => {
    assert.deepEqual(resolveVersion({ ...defaults, refType: 'tag', refName: tag }), { version, tag, release: true });
  });
}

test('invalid release tag is rejected', () => {
  assert.throws(() => resolveVersion({ ...defaults, refType: 'tag', refName: 'vbad' }), /Tag/);
});

test('manual runs on other branches only build artifacts', () => {
  assert.deepEqual(resolveVersion({ ...defaults, refName: 'feature/test' }), { version: '0.1.0-alpha', tag: '', release: false });
});
