// Scores a finished worker-probe repository without mutating its checked-out branch or working tree.
// Usage: node <agent-kit>/probes/worker-task/check.mjs <repository folder>
// Prints one line per check and a last line "SCORE: n/8".
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(process.argv[2] || '.');
const git = (args) => execSync(`git ${args}`, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const results = [];
const check = (name, fn) => {
  let ok = false, note = '';
  try { ok = !!fn(); } catch (e) { note = ' (' + String(e.message || e).split('\n')[0].slice(0, 80) + ')'; }
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note}`);
};

const tmpEval = mkdtempSync(join(tmpdir(), 'workerprobe-eval-'));
process.on('exit', () => { try { rmSync(tmpEval, { recursive: true, force: true }); } catch {} });

let mod = {};
let targetRef = 'HEAD';
try {
  const curBranch = git('branch --show-current');
  const mainCount = Number(git('rev-list --count main'));
  if (mainCount === 1 && curBranch !== 'task/t01' && git('branch --list task/t01')) {
    targetRef = 'task/t01';
  }
  for (const relPath of git(`ls-tree -r --name-only ${targetRef}`).split('\n').filter(Boolean)) {
    const dest = join(tmpEval, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, execSync(`git show ${targetRef}:${relPath}`, { cwd: repo }));
  }
  mod = await import(pathToFileURL(join(tmpEval, 'src', 'format.js')).href);
} catch (e) {
  console.log('FAIL  src/format.js could not be loaded: ' + e.message);
}
const f = mod.formatOrderDate || (() => undefined);

check('1 Date 객체(확장 연도 포함) -> YYYY-MM-DD', () =>
  f(new Date('2026-11-13T05:00:00Z')) === '2026-11-13' &&
  f(new Date('+010000-01-02T00:00:00Z')) === '10000-01-02'
);
check('2 시간대 표기가 있는 ISO 문자열은 UTC 날짜로', () => f('2026-01-01T00:30:00+09:00') === '2025-12-31');
check('3 월·일 두 자리', () => f('2026-03-05T12:00:00Z') === '2026-03-05');
check('4 읽을 수 없는 값(null, undefined, 빈 문자열, NaN Date, 잘못된 문자열)은 -', () =>
  f(null) === '-' && f(undefined) === '-' && f('') === '-' && f(new Date(NaN)) === '-' && f('abc') === '-'
);
check('5 formatDateTime은 그대로', () => mod.formatDateTime('2026-11-13T05:07:00Z') === '2026-11-13 05:07');
check('6 의존성을 더하지 않음', () => {
  const p = JSON.parse(readFileSync(join(tmpEval, 'package.json'), 'utf8'));
  return !Object.keys(p.dependencies || {}).length && !Object.keys(p.devDependencies || {}).length && !existsSync(join(repo, 'node_modules'));
});
check('7 node --test 통과, formatOrderDate 테스트가 있음', () => {
  execSync('node --test', { cwd: tmpEval, stdio: 'ignore' });
  return readdirSync(join(tmpEval, 'test')).some((n) => /formatOrderDate/.test(readFileSync(join(tmpEval, 'test', n), 'utf8')));
});
check('8 커밋·브랜치(작업자 단독: task/t01 유지·main 1커밋 / 전체 흐름 local 제출: main ff-only 통합)·범위 외 무변경·깨끗한 트리', () => {
  const mainCommits = Number(git('rev-list --count main'));
  const hasTaskBranch = !!git('branch --list task/t01');
  const dirty = git('status --short').split('\n').filter((l) => l && !/^\?\? (?:handoff\/|agent-roles\/|(?:AGENTS|CLAUDE|GEMINI|SPEC|SESSION_HANDOFF)\.md$)/.test(l));
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
