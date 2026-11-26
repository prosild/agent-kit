// Regression test for cleanup.ps1 (sub-session mode B + whole-machine mode A + cross-platform paths).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
const KIT = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';
const PWSH = IS_WIN ? 'powershell' : 'pwsh';
const PWSH_BASE = IS_WIN ? ['-NoProfile', '-ExecutionPolicy', 'Bypass'] : ['-NoProfile'];
const TMP = mkdtempSync(join(tmpdir(), 'cleanuptest-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

const BIN = join(TMP, 'bin'); mkdirSync(BIN);
writeFileSync(join(BIN, 'hc.cmd'), '@node "%~dp0mockhc.mjs" %*\r\n@exit /b %errorlevel%\r\n');
writeFileSync(join(BIN, 'hc'), '#!/bin/sh\nexec node "$(dirname "$0")/mockhc.mjs" "$@"\n');
if (!IS_WIN) chmodSync(join(BIN, 'hc'), 0o755);
writeFileSync(join(BIN, 'mockhc.mjs'), `
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
const D = process.env.MOCKHC_DIR, [cmd, addr] = process.argv.slice(2);
appendFileSync(D + '/calls.txt', cmd + ' ' + addr + '\\n');
if (cmd === 'get') {
  const n = existsSync(D + '/n.txt') ? Number(readFileSync(D + '/n.txt', 'utf8')) : 0;
  writeFileSync(D + '/n.txt', String(n + 1));
  const seq = readFileSync(D + '/seq.txt', 'utf8').split('\\n').filter(Boolean);
  const line = seq[Math.min(n, seq.length - 1)];
  if (line === 'FAIL') process.exit(1);
  console.log(line === 'GARBAGE' ? 'not json' : line);
} else if (cmd === 'ls') console.log(existsSync(D + '/ls.json') ? readFileSync(D + '/ls.json', 'utf8') : '{"terminals":[]}');
else if (cmd === 'rm' && existsSync(D + '/rmfail')) process.exit(1);
`);
const DONE = '{"state":"live","status":{"state":"done"}}', WORKING = '{"state":"live","status":{"state":"working"}}';

let n = 0;
// trashHome: move to the trash under this home folder instead of deleting (-Permanent is the default here).
function run({ seq, groups = 'files,hc', git = null, rmfail = false, trashHome = null }) {
  const dir = join(TMP, `case${++n}`), proj = join(dir, 'proj'), mock = join(dir, 'mock');
  mkdirSync(join(proj, 'handoff'), { recursive: true }); mkdirSync(mock);
  if (git === 'broken') writeFileSync(join(proj, '.git'), 'gitdir: C:/agentkit-no-such-gitdir\n');
  if (git === 'ok') spawnSync('git', ['init', '-q'], { cwd: proj });
  const file = join(proj, 'handoff', 'sub-t01-review-1.md'); writeFileSync(file, 'x');
  writeFileSync(join(mock, 'seq.txt'), seq.join('\n') + '\n');
  if (rmfail) writeFileSync(join(mock, 'rmfail'), '');
  const manifest = join(dir, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ Created: new Date().toISOString(), Days: 30, Parent: 't0', Items: [
    { Id: 1, Group: 'files', Label: 'handoff/sub-t01-review-1.md', Paths: [file], Hc: null, Explicit: true, Root: proj, Bytes: 1, Newest: new Date().toISOString() },
    { Id: 2, Group: 'hc', Label: 't9 agy sub-t01-review-1 [LIVE status=done]', Paths: [], Hc: 't9', Explicit: true, Root: null, Bytes: 0, Newest: '' },
  ] }));
  const r = spawnSync(PWSH, [...PWSH_BASE, '-File', join(KIT, 'cleanup.ps1'),
    '-Parent', 't0', '-Manifest', manifest, '-Apply', ...(trashHome ? [] : ['-Permanent']), '-Groups', groups], {
    encoding: 'utf8', env: { ...process.env, ...(trashHome ? { HOME: trashHome, XDG_DATA_HOME: '' } : {}), PATH: `${BIN}${delimiter}${process.env.PATH}`, MOCKHC_DIR: mock, LOCALAPPDATA: join(dir, 'localapp') } });
  const calls = existsSync(join(mock, 'calls.txt')) ? readFileSync(join(mock, 'calls.txt'), 'utf8') : '';
  return { r, out: r.stdout + r.stderr, fileLeft: existsSync(file), calls, file };
}

const cases = [
  ['정상: done 자식은 터미널 제거 후 임시 파일 삭제(Git 아닌 폴더)', () => {
    const x = run({ seq: [DONE] });
    return x.r.status === 0 && !x.fileLeft && /^rm t9$/m.test(x.calls) && /DONE ok=2/.test(x.out);
  }],
  ['N2: 목록 뒤 다시 working이 된 자식 → 아무것도 지우지 않음(-Groups files만 줘도)', () => {
    const x = run({ seq: [WORKING], groups: 'files' });
    return x.r.status === 1 && x.fileLeft && /STOP .*now working - nothing removed/.test(x.out) && !/^(kill|rm) /m.test(x.calls);
  }],
  ['N2: 자식 상태를 읽지 못함(hc get 실패) → 아무것도 지우지 않음', () => {
    const x = run({ seq: ['FAIL'] });
    return x.r.status === 1 && x.fileLeft && /STOP .*state unreadable/.test(x.out) && !/^(kill|rm) /m.test(x.calls);
  }],
  ['N2: 제거 직전 재확인 응답이 깨짐 → 그 뒤 파일 삭제 중단', () => {
    const x = run({ seq: [DONE, 'GARBAGE'] });
    return x.r.status === 1 && x.fileLeft && /STOP .*nothing else removed/.test(x.out);
  }],
  ['N2: 제거 직전 재확인이 출력 없이 실패 → kill·rm·파일 삭제 없음', () => {
    const x = run({ seq: [DONE, 'FAIL'] });
    return x.r.status === 1 && x.fileLeft && /STOP .*nothing else removed/.test(x.out) && !/^(kill|rm) /m.test(x.calls);
  }],
  ['N2: 상태 필드가 없는 응답({}) → 아무것도 지우지 않음', () => {
    const x = run({ seq: ['{}'] });
    return x.r.status === 1 && x.fileLeft && /STOP .*state unreadable/.test(x.out) && !/^(kill|rm) /m.test(x.calls);
  }],
  ['N2: hc rm 실패 → 그 뒤 파일 삭제 중단', () => {
    const x = run({ seq: [DONE], rmfail: true });
    return x.r.status === 1 && x.fileLeft && /STOP .*hc rm/.test(x.out);
  }],
  ['N1: Git이 답하지 못하는 저장소(.git 손상) 안의 파일은 보존', () => {
    const x = run({ seq: [DONE], groups: 'files', git: 'broken' });
    return x.r.status === 1 && x.fileLeft && /git could not tell/.test(x.out);
  }],
  ['N1 대조: 정상 저장소의 미추적 파일은 삭제', () => {
    const x = run({ seq: [DONE], groups: 'files', git: 'ok' });
    return x.r.status === 0 && !x.fileLeft;
  }],
  // The Windows Recycle Bin cannot be pointed at a test folder, so the trash move is only exercised off Windows.
  ...(IS_WIN ? [] : [['휴지통 이동(macOS·Linux 실행): files/<이름>과 원래 경로를 담은 info/<이름>.trashinfo를 함께 만든다', () => {
    const home = join(TMP, 'trash-home'); mkdirSync(home);
    const x = run({ seq: [DONE], groups: 'files', trashHome: home });
    const base = join(home, '.local', 'share', 'Trash');
    const moved = existsSync(join(base, 'files')) ? readdirSync(join(base, 'files')) : [];
    const infoFile = moved.length === 1 ? join(base, 'info', moved[0] + '.trashinfo') : '';
    const m = /^\[Trash Info\]\nPath=(.+)\nDeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/.exec(infoFile && existsSync(infoFile) ? readFileSync(infoFile, 'utf8') : '');
    return x.r.status === 0 && !x.fileLeft && /moved to Trash/.test(x.out) && !!m && decodeURIComponent(m[1]) === x.file;
  }]]),
  ['A2: 하위 세션 목록 뒤 -Parent 없이 -Apply → PC 전체 목록을 적용하지 않음', () => {
    const t = join(TMP, 'tempA2'), d = join(t, 'agent-cleanup'); mkdirSync(d, { recursive: true });
    const victim = join(TMP, 'a2-victim.txt'); writeFileSync(victim, 'x');
    writeFileSync(join(d, 'last.json'), JSON.stringify({ Created: new Date().toISOString(), Days: 30, Parent: '', Items: [
      { Id: 1, Group: 'files', Label: 'victim', Paths: [victim], Hc: null, Explicit: true, Root: TMP, Bytes: 1, Newest: new Date().toISOString() } ] }));
    const later = new Date(Date.now() + 5000);
    writeFileSync(join(d, 'mine-t0.json'), '{}'); utimesSync(join(d, 'mine-t0.json'), later, later);
    const r = spawnSync(PWSH, [...PWSH_BASE, '-File', join(KIT, 'cleanup.ps1'), '-Apply', '-Ids', '1', '-Permanent'],
      { encoding: 'utf8', env: { ...process.env, TEMP: t, TMP: t } });
    return r.status !== 0 && existsSync(victim) && /newer than the whole-PC list/.test(r.stdout + r.stderr);
  }],
  ['F1: 작업 파일의 보고 경로가 번호만 다른 실행(research-10)을 가리켜도 그 실행 파일은 목록에 넣지 않음', () => {
    const dir = join(TMP, 'f1'), proj = join(dir, 'proj'), h = join(proj, 'handoff'), mock = join(dir, 'mock'), t = join(dir, 'temp');
    mkdirSync(h, { recursive: true }); mkdirSync(mock); mkdirSync(t);
    const own = join(h, 'sub-shop-t01-research-1.md');
    writeFileSync(own, `- 보고 파일: ${join(h, 'sub-shop-t01-research-10-report.md')}\n`);
    for (const f of ['sub-shop-t01-research-10.md', 'sub-shop-t01-research-10-report.md', 'sub-shop-t01-research-10.log']) writeFileSync(join(h, f), 'x');
    writeFileSync(join(mock, 'ls.json'), JSON.stringify({ terminals: [{ address: 't9', parent: 't0', state: 'finished', agent: 'agy', name: 'sub-shop-t01-research-1' }] }));
    writeFileSync(join(mock, 'seq.txt'), JSON.stringify({ state: 'finished', status: { state: 'done' }, cwd: proj,
      argv: ['agy.exe', '--mode', 'plan', '-i', `Read ${own} and follow it.`] }) + '\n');
    const r = spawnSync(PWSH, [...PWSH_BASE, '-File', join(KIT, 'cleanup.ps1'), '-Parent', 't0'],
      { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${delimiter}${process.env.PATH}`, MOCKHC_DIR: mock, TEMP: t, TMP: t, LOCALAPPDATA: join(dir, 'localapp') } });
    const m = JSON.parse(readFileSync(join(t, 'agent-cleanup', 'mine-t0.json'), 'utf8').replace(/^\uFEFF/, ''));
    const paths = m.Items.flatMap(i => i.Paths || []);
    return r.status === 0 && paths.some(p => /research-1\.md$/.test(p)) && !paths.some(p => /research-10/.test(p));
  }],
  ['AGY 작업자 로그(task-<p>-<id>.log)도 하위 세션 정리 목록에 포함', () => {
    const dir = join(TMP, 'workerlog'), proj = join(dir, 'proj'), h = join(proj, 'handoff'), mock = join(dir, 'mock'), t = join(dir, 'temp');
    mkdirSync(h, { recursive: true }); mkdirSync(mock); mkdirSync(t);
    const wlog = join(h, 'task-shop-t01.log'); writeFileSync(wlog, 'log');
    const handoffFile = join(h, 'T01.md'); writeFileSync(handoffFile, 'keep me');
    writeFileSync(join(mock, 'ls.json'), JSON.stringify({ terminals: [{ address: 't8', parent: 't0', state: 'finished', agent: 'agy', name: 'task-shop-t01' }] }));
    writeFileSync(join(mock, 'seq.txt'), JSON.stringify({ state: 'finished', status: { state: 'done' }, cwd: proj,
      argv: ['agy.exe', '--mode', 'auto', '--log-file', wlog, '-i', `Read ${handoffFile} and follow it.`] }) + '\n');
    const r = spawnSync(PWSH, [...PWSH_BASE, '-File', join(KIT, 'cleanup.ps1'), '-Parent', 't0'],
      { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${delimiter}${process.env.PATH}`, MOCKHC_DIR: mock, TEMP: t, TMP: t, LOCALAPPDATA: join(dir, 'localapp') } });
    const m = JSON.parse(readFileSync(join(t, 'agent-cleanup', 'mine-t0.json'), 'utf8'));
    const paths = m.Items.flatMap(i => i.Paths || []);
    return r.status === 0 && paths.some(p => /task-shop-t01\.log$/.test(p)) && !paths.some(p => /T01\.md$/.test(p));
  }],
  ['모드 A(PC 전체 기간 스캔): 오래된 세션은 수집하고 보호 파일(settings.json, memory, sqlite) 및 최신 세션은 제외', () => {
    const dir = join(TMP, 'modeA'), fakeHome = join(dir, 'home'), mock = join(dir, 'mock'), t = join(dir, 'temp');
    mkdirSync(mock, { recursive: true }); mkdirSync(t, { recursive: true });
    const oldDate = new Date(Date.now() - 40 * 86_400_000);
    const claudeProj = join(fakeHome, '.claude', 'projects', 'proj1');
    const claudeMem = join(fakeHome, '.claude', 'projects', 'proj1', 's1', 'memory');
    const codexSess = join(fakeHome, '.codex', 'sessions');
    const agyConv = join(fakeHome, '.gemini', 'antigravity-ide', 'conversations');
    mkdirSync(claudeMem, { recursive: true }); mkdirSync(codexSess, { recursive: true }); mkdirSync(agyConv, { recursive: true });
    const oldCodex = join(codexSess, 'rollout-old.jsonl'); writeFileSync(oldCodex, '{}'); utimesSync(oldCodex, oldDate, oldDate);
    const recentCodex = join(codexSess, 'rollout-new.jsonl'); writeFileSync(recentCodex, '{}');
    const protectedSqlite = join(codexSess, 'state.sqlite'); writeFileSync(protectedSqlite, 'db'); utimesSync(protectedSqlite, oldDate, oldDate);
    const protectedClaude = join(claudeProj, 's1.jsonl'); writeFileSync(protectedClaude, '{}'); utimesSync(protectedClaude, oldDate, oldDate);
    const memFile = join(claudeMem, 'notes.md'); writeFileSync(memFile, 'keep'); utimesSync(memFile, oldDate, oldDate);
    utimesSync(claudeMem, oldDate, oldDate); utimesSync(join(claudeProj, 's1'), oldDate, oldDate);
    const oldAgy = join(agyConv, 'conv1.db'); writeFileSync(oldAgy, 'db'); utimesSync(oldAgy, oldDate, oldDate);
    const r = spawnSync(PWSH, [...PWSH_BASE, '-File', join(KIT, 'cleanup.ps1'), '-Days', '30'],
      { encoding: 'utf8', env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, PATH: `${BIN}${delimiter}${process.env.PATH}`, MOCKHC_DIR: mock, TEMP: t, TMP: t, LOCALAPPDATA: join(dir, 'localapp') } });
    const m = JSON.parse(readFileSync(join(t, 'agent-cleanup', 'last.json'), 'utf8'));
    const paths = m.Items.flatMap(i => i.Paths || []);
    return r.status === 0
      && paths.some(p => /rollout-old\.jsonl$/.test(p))
      && paths.some(p => /conv1\.db$/.test(p))
      && !paths.some(p => /rollout-new\.jsonl$/.test(p))
      && !paths.some(p => /state\.sqlite$/.test(p))
      && !paths.some(p => /memory/.test(p));
  }],
  ['수락 검토 보고 보존: accepted.json이 가리키는 검토 보고는 정리 목록·삭제에서 제외', () => {
    const dir = join(TMP, 'accrev'), proj = join(dir, 'proj'), h = join(proj, 'handoff'), mock = join(dir, 'mock'), t = join(dir, 'temp');
    mkdirSync(join(h, 'T01'), { recursive: true }); mkdirSync(mock); mkdirSync(t);
    const taskF = join(h, 'sub-shop-t01-review-1.md');
    const repF = join(h, 'sub-shop-t01-review-1-report.md');
    writeFileSync(taskF, `- 보고 파일: ${repF}\n`);
    writeFileSync(repF, '판정: 진행 가능 | 높음 0 | 중간 0 | 낮음 0\n');
    writeFileSync(join(h, 'T01', 'accepted.json'), JSON.stringify({ commit: 'abc', reviewReport: repF }));
    writeFileSync(join(mock, 'ls.json'), JSON.stringify({ terminals: [{ address: 't9', parent: 't0', state: 'finished', agent: 'agy', name: 'sub-shop-t01-review-1' }] }));
    writeFileSync(join(mock, 'seq.txt'), JSON.stringify({ state: 'finished', status: { state: 'done' }, cwd: proj,
      argv: ['agy.exe', '--mode', 'plan', '-i', `Read ${taskF} and follow it.`] }) + '\n');
    const r = spawnSync(PWSH, [...PWSH_BASE, '-File', join(KIT, 'cleanup.ps1'), '-Parent', 't0'],
      { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${delimiter}${process.env.PATH}`, MOCKHC_DIR: mock, TEMP: t, TMP: t, LOCALAPPDATA: join(dir, 'localapp') } });
    const m = JSON.parse(readFileSync(join(t, 'agent-cleanup', 'mine-t0.json'), 'utf8'));
    const paths = m.Items.flatMap(i => i.Paths || []);
    return r.status === 0 && /KEEP .*referenced by accepted\.json/.test(r.stdout) && paths.some(p => /review-1\.md$/.test(p)) && !paths.some(p => /review-1-report\.md$/.test(p));
  }],
  ['수락 검토 보고 보존(Codex 하위 폴더): handoff/<stem>/<stem>-report.md가 수락 보고서면 상위 <stem> 폴더도 삭제 목록에서 제외', () => {
    const dir = join(TMP, 'accrev-codex'), proj = join(dir, 'proj'), h = join(proj, 'handoff'), mock = join(dir, 'mock'), t = join(dir, 'temp');
    const stemDir = join(h, 'sub-shop-t01-review-1');
    mkdirSync(join(h, 'T01'), { recursive: true }); mkdirSync(stemDir, { recursive: true }); mkdirSync(mock); mkdirSync(t);
    const taskF = join(h, 'sub-shop-t01-review-1.md');
    const repF = join(stemDir, 'sub-shop-t01-review-1-report.md');
    writeFileSync(taskF, `- 보고 파일: ${repF}\n`);
    writeFileSync(repF, '판정: 진행 가능 | 높음 0 | 중간 0 | 낮음 0\n');
    writeFileSync(join(h, 'T01', 'accepted.json'), JSON.stringify({ commit: 'abc', reviewReport: repF }));
    writeFileSync(join(mock, 'ls.json'), JSON.stringify({ terminals: [{ address: 't9', parent: 't0', state: 'finished', agent: 'codex', name: 'sub-shop-t01-review-1' }] }));
    writeFileSync(join(mock, 'seq.txt'), JSON.stringify({ state: 'finished', status: { state: 'done' }, cwd: proj,
      argv: ['codex.exe', '--no-daemon', `Read ${taskF} and follow it.`] }) + '\n');
    const r = spawnSync(PWSH, [...PWSH_BASE, '-File', join(KIT, 'cleanup.ps1'), '-Parent', 't0'],
      { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${delimiter}${process.env.PATH}`, MOCKHC_DIR: mock, TEMP: t, TMP: t, LOCALAPPDATA: join(dir, 'localapp') } });
    const m = JSON.parse(readFileSync(join(t, 'agent-cleanup', 'mine-t0.json'), 'utf8'));
    const paths = m.Items.flatMap(i => i.Paths || []);
    return r.status === 0 && paths.some(p => /review-1\.md$/.test(p)) && !paths.some(p => /sub-shop-t01-review-1(\\|\/|$)/.test(p));
  }],
];
let bad = 0;
for (const [name, fn] of cases) {
  let ok = false, note = '';
  try { ok = fn(); } catch (e) { ok = false; note = '\n  ' + String(e.message || e); }
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note}`);
}
console.log(bad ? `${bad} FAIL` : 'ALL PASS'); process.exit(bad ? 1 : 0);
