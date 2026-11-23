// Scores a finished worker-probe repository. The worker never sees this file.
// Usage: node <agent-kit>/probes/worker-task/check.mjs <repository folder>
// Prints one line per check and a last line "SCORE: n/8".
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(process.argv[2] || '.');
const git = (args) => execSync(`git ${args}`, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const results = [];
const check = (name, fn) => { let ok = false, note = ''; try { ok = !!fn(); } catch (e) { note = ' (' + String(e.message || e).split('\n')[0].slice(0, 80) + ')'; } results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note}`); };

let mod = {};
try {
  if (git('branch --show-current') !== 'task/t01' && git('branch --list task/t01')) git('checkout -q task/t01');
  mod = await import(pathToFileURL(join(repo, 'src', 'format.js')).href + '?t=' + Date.now());
} catch (e) { console.log('FAIL  src/format.js could not be loaded: ' + e.message); }
const f = mod.formatOrderDate || (() => undefined);

check('1 Date 객체 -> YYYY-MM-DD', () => f(new Date('2026-11-13T05:00:00Z')) === '2026-11-13');
check('2 시간대 표기가 있는 ISO 문자열은 UTC 날짜로', () => f('2026-01-01T00:30:00+09:00') === '2025-12-31');
check('3 월·일 두 자리', () => f('2026-03-05T12:00:00Z') === '2026-03-05');
check('4 읽을 수 없는 값은 -', () => f(null) === '-' && f(undefined) === '-' && f('abc') === '-');
check('5 formatDateTime은 그대로', () => mod.formatDateTime('2026-11-13T05:07:00Z') === '2026-11-13 05:07');
check('6 의존성을 더하지 않음', () => {
  const p = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  return !Object.keys(p.dependencies || {}).length && !Object.keys(p.devDependencies || {}).length && !existsSync(join(repo, 'node_modules'));
});
check('7 node --test 통과, formatOrderDate 테스트가 있음', () => {
  execSync('node --test', { cwd: repo, stdio: 'ignore' });
  return readdirSync(join(repo, 'test')).some((n) => /formatOrderDate/.test(readFileSync(join(repo, 'test', n), 'utf8')));
});
check('8 커밋·브랜치(작업자 단독: task/t01 유지·main 1커밋 / 전체 흐름 local 제출: main ff-only 통합)·범위 외 무변경·깨끗한 트리', () => {
  const mainCommits = Number(git('rev-list --count main'));
  const hasTaskBranch = !!git('branch --list task/t01');
  const dirty = git('status --short').split('\n').filter((l) => l && !/^\?\? (handoff|AGENTS\.md|CLAUDE\.md|GEMINI\.md|SPEC\.md|SESSION_HANDOFF\.md|agent-roles)/.test(l));
  if (dirty.length !== 0) return false;
  if (mainCommits === 1) {
    if (!hasTaskBranch) return false;
    const ahead = Number(git('rev-list --count main..task/t01'));
    const files = git('diff --name-only main...task/t01').split('\n').filter(Boolean);
    return ahead >= 1 && files.length > 0 && files.every((n) => n === 'src/format.js' || n.startsWith('test/'));
  }
  const root = git('rev-list --max-parents=0 main').split('\n')[0];
  const files = git(`diff --name-only ${root}...main`).split('\n').filter(Boolean);
  const taskAligned = !hasTaskBranch || git('rev-parse task/t01') === git('rev-parse main');
  return mainCommits >= 2 && taskAligned && files.length > 0 && files.every((n) => n === 'src/format.js' || n.startsWith('test/'));
});
console.log(`SCORE: ${results.filter(Boolean).length}/8`);
