// 사용자 저장소. 지금은 메모리에만 둔다.
import { createHash } from 'node:crypto';

const users = new Map();

export function addUser(id, password) {
  const salt = id + ':salt';
  users.set(id, { id, salt, passwordHash: createHash('sha256').update(salt + password).digest() });
}

export function findUser(id) {
  return users.get(id) || null;
}
