// 로그인 처리. 비밀번호 비교와 응답 만들기만 한다.
import { findUser } from './users.js';
import { createHash, timingSafeEqual } from 'node:crypto';

function hash(password, salt) {
  return createHash('sha256').update(salt + password).digest();
}

// 돌려주는 값: { ok: true } 또는 { ok: false, reason: 'no-user' | 'bad-password' }
export function verifyPassword(user, password) {
  if (!user) return { ok: false, reason: 'no-user' };
  const given = hash(password, user.salt);
  const same = given.length === user.passwordHash.length && timingSafeEqual(given, user.passwordHash);
  return same ? { ok: true } : { ok: false, reason: 'bad-password' };
}

export function login(id, password) {
  const user = findUser(id);
  const result = verifyPassword(user, password);
  if (!result.ok) return { status: 401, message: '아이디 또는 비밀번호가 올바르지 않습니다' };
  return { status: 200, userId: user.id };
}
