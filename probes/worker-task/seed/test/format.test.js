import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDateTime } from '../src/format.js';

test('formatDateTime: UTC 기준 분까지', () => {
  assert.equal(formatDateTime('2026-11-13T05:07:00Z'), '2026-11-13 05:07');
});
