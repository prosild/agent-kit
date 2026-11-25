import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireAdmin } from '../src/auth.js';

function call(user) {
  const res = { code: 0, status(c) { this.code = c; return this; }, end() { return this; } };
  let passed = false;
  requireAdmin({ user }, res, () => { passed = true; });
  return { status: res.code, passed };
}

test('rejects anonymous request with 401', () => {
  assert.deepEqual(call(undefined), { status: 401, passed: false });
});

test('blocks viewer on /admin/users with 403', () => {
  assert.deepEqual(call({ role: 'VIEWER' }), { status: 403, passed: false });
});

test('allows admin on /admin/users', () => {
  assert.deepEqual(call({ role: 'ADMIN' }), { status: 0, passed: true });
});
