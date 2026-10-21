import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releasePlan } from './release-plan.mjs';

const manifest = { name: '@hepi/client', version: '0.1.0', private: false };
test('a release tag selects its matching package and exact image version', () => {
  assert.deepEqual(releasePlan('v0.1.0', manifest, 'Someone/Hepi'), { version: '0.1.0', npmTag: 'latest', imagePrefix: 'ghcr.io/someone/hepi', repositoryUrl: 'git+https://github.com/Someone/Hepi.git' });
});
test('prereleases do not replace npm latest', () => {
  assert.equal(releasePlan('v0.2.0-rc.1', { ...manifest, version: '0.2.0-rc.1' }, 'Someone/Hepi').npmTag, 'next');
});
test('invalid or mismatched tags cannot publish', () => {
  for (const tag of ['v0.2.0', 'main', 'v01.1.0', 'v0.1.0+build', 'v0.1.0-01', 'v0.1.0\nmalicious']) {
    assert.throws(() => releasePlan(tag, manifest, 'Someone/Hepi'));
  }
  assert.throws(() => releasePlan('v0.1.0', { ...manifest, private: true }, 'Someone/Hepi'));
  assert.throws(() => releasePlan('v0.1.0', { ...manifest, dependencies: { bad: 'workspace:*' } }, 'Someone/Hepi'));
  assert.throws(() => releasePlan('v0.1.0', manifest, '../bad\nrepo'));
});
