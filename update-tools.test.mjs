// update-tools.ps1 / update-tools.sh tests with mock executables only; the real CLIs are never on the PATH used here.
// Windows: compiled mock .exe files, a PATH limited to the mock folder and System32, LOCALAPPDATA pointed at the temp folder.
// WSL (if the Ubuntu distro exists): update-tools.sh run without a login shell, under env -i with a mock-only PATH.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const KIT = dirname(fileURLToPath(import.meta.url)), PS1 = join(KIT, 'update-tools.ps1'), SH = join(KIT, 'update-tools.sh');
const SYS = join(process.env.SystemRoot || 'C:\\Windows', 'System32'), POWERSHELL = join(SYS, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TMP = mkdtempSync(join(tmpdir(), 'updtest-')), BIN = join(TMP, 'bin'), LAD = join(TMP, 'lad'), FB = join(LAD, 'Programs', 'OpenAI', 'Codex', 'bin');
// The WSL temp folder is only used (and removed) when mktemp exited 0 and printed exactly this pattern.
const WSL_TMP = /^\/tmp\/updtest-[A-Za-z0-9]+$/;
let wslDir = '';
process.on('exit', () => {
  if (WSL_TMP.test(wslDir)) spawnSync('wsl.exe', ['-d', 'Ubuntu', '-e', 'rm', '-rf', wslDir]);
  if (dirname(resolve(TMP)) === resolve(tmpdir()) && basename(TMP).startsWith('updtest-')) {
    try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
});
let bad = 0, total = 0;
function check(name, ok, detail = '') { total++; if (!ok) bad++; console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '\n' + detail)); }

// Off Windows the script has nothing to update. The only thing to test there is that it says so and stops.
if (process.platform !== 'win32') {
  const p = spawnSync('pwsh', ['-NoProfile', '-File', PS1, '-Apply'], { encoding: 'utf8' });
  const out = (p.stdout || '') + (p.stderr || '');
  check('Windows 밖: 안내만 하고 종료 코드 2, 도구를 찾거나 실행하지 않음', p.status === 2 && /Windows only/.test(out) && !/READY|FAIL|SKIP|UPDATED/.test(out), `${p.status}\n${out}`);
  console.log(`\n${total - bad}/${total} passed (the Windows and WSL checks were not run on ${process.platform})`);
  process.exit(bad ? 1 : 0);
}

// ---- mock .exe: --version prints <name>.ver (fails silently with <name>.verfail; prints but exits 4 with <name>.verexit);
// update logs to calls.log, fails with exit 3 if <name>.fail exists, otherwise copies <name>.next into <name>.ver
// and, with <name>.verexitafter, makes later --version calls exit 4.
const MOCK = join(TMP, 'mock.exe');
const CS = `using System; using System.IO;
public static class M {
  static void Utf8(Stream stream, string text) { byte[] b = new System.Text.UTF8Encoding(false).GetBytes(text + "\\n"); stream.Write(b, 0, b.Length); stream.Flush(); }
  public static int Main(string[] a) {
  string exe = System.Reflection.Assembly.GetExecutingAssembly().Location, d = Path.GetDirectoryName(exe), n = Path.GetFileNameWithoutExtension(exe);
  Func<string,string> f = s => Path.Combine(d, n + s);
  if (n == "wsl") {
    if (Array.IndexOf(a, "wslpath") >= 0) { Console.WriteLine("/mock/update-tools.sh"); return 0; }
    Utf8(Console.OpenStandardOutput(), "WSL \\uC5C5\\uB370\\uC774\\uD2B8 \\uC548\\uB0B4");
    Utf8(Console.OpenStandardError(), "WSL \\uC624\\uB958 \\uBA54\\uC2DC\\uC9C0");
    foreach (string t in new [] { "codex", "claude", "agy" }) Console.WriteLine("ROW\\t" + t + "\\t1.0.0\\t-\\tREADY\\t/mock/" + t);
    return 0;
  }
  if (a.Length > 0 && a[0] == "update" && File.Exists(f(".korean"))) {
    Utf8(Console.OpenStandardOutput(), "\\uC5C5\\uB370\\uC774\\uD2B8 \\uC548\\uB0B4");
    Utf8(Console.OpenStandardError(), "\\uC624\\uB958 \\uBA54\\uC2DC\\uC9C0");
  }
  if (a.Length > 0 && a[0] == "--version") { if (File.Exists(f(".verfail"))) return 1; Console.WriteLine(n + " " + (File.Exists(f(".ver")) ? File.ReadAllText(f(".ver")).Trim() : "1.0.0")); return File.Exists(f(".verexit")) ? 4 : 0; }
  if (a.Length > 0 && a[0] == "update") { File.AppendAllText(Path.Combine(d, "calls.log"), n + " update\\r\\n"); if (File.Exists(f(".fail"))) return 3; if (File.Exists(f(".next"))) File.Copy(f(".next"), f(".ver"), true); if (File.Exists(f(".verexitafter"))) File.WriteAllText(f(".verexit"), ""); return 0; }
  return 2; } }`;
writeFileSync(join(TMP, 'mock.cs'), CS);
let r = spawnSync(POWERSHELL, ['-NoProfile', '-Command', `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${join(TMP, 'mock.cs')}')) -OutputAssembly '${MOCK}' -OutputType ConsoleApplication`], { encoding: 'utf8' });
if (!existsSync(MOCK)) { console.log('FAIL  mock exe build\n' + r.stdout + r.stderr); process.exit(1); }

const TOOLS = ['codex', 'claude', 'agy'];
function resetWin(tools = TOOLS) {
  rmSync(BIN, { recursive: true, force: true }); rmSync(LAD, { recursive: true, force: true }); mkdirSync(BIN, { recursive: true });
  for (const t of tools) { copyFileSync(MOCK, join(BIN, t + '.exe')); writeFileSync(join(BIN, t + '.ver'), '1.0.0'); writeFileSync(join(BIN, t + '.next'), '1.1.0'); }
}
const calls = (dir = BIN) => existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
function runPs(args = [], { legacyCodePage = false, includeWsl = false } = {}) {
  const env = { ...process.env, PATH: [BIN, SYS, join(SYS, 'WindowsPowerShell', 'v1.0')].join(';'), LOCALAPPDATA: LAD };
  const scriptArgs = [...(includeWsl ? [] : ['-WindowsOnly']), ...args];
  const quote = s => "'" + s.replaceAll("'", "''") + "'";
  const invocation = legacyCodePage
    ? ['-Command', `[Console]::InputEncoding=[Text.Encoding]::GetEncoding(949); [Console]::OutputEncoding=[Text.Encoding]::GetEncoding(949); $OutputEncoding=[Text.Encoding]::ASCII; & ${quote(PS1)} ${scriptArgs.map(s => /^-[A-Za-z]+$/.test(s) ? s : quote(s)).join(' ')}; exit $LASTEXITCODE`]
    : ['-File', PS1, ...scriptArgs];
  const res = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...invocation], { encoding: 'utf8', env });
  const out = res.stdout + res.stderr;
  const row = t => { const m = new RegExp('^' + t + '\\s+Windows\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)', 'm').exec(res.stdout); return m ? { before: m[1], after: m[2], status: m[3] } : {}; };
  return { code: res.status, out, row };
}

resetWin();
r = runPs();
check('미리보기: 모두 READY, 종료 0', r.code === 0 && TOOLS.every(t => r.row(t).status === 'READY') && /RESULT: OK/.test(r.out), r.out);
check('미리보기: update 호출 없음', calls().length === 0, calls().join('\n'));
check('미리보기: 실행할 명령과 경로 표시', r.out.includes('would run: ' + join(BIN, 'codex.exe') + ' update'), r.out);

resetWin(); writeFileSync(join(BIN, 'claude.next'), '1.0.0');
r = runPs(['-Apply']);
check('적용: 각 도구 update 정확히 1회', JSON.stringify(calls().sort()) === JSON.stringify(TOOLS.map(t => t + ' update').sort()), calls().join('\n'));
check('적용: 이전/이후 버전과 UPDATED/CURRENT', r.code === 0 && r.row('codex').before === '1.0.0' && r.row('codex').after === '1.1.0' && r.row('codex').status === 'UPDATED' && r.row('claude').status === 'CURRENT', r.out);

resetWin(); writeFileSync(join(BIN, 'codex.fail'), '');
r = runPs(['-Apply']);
check('부분 실패: codex FAIL, 나머지는 계속 갱신', r.row('codex').status === 'FAIL' && r.row('claude').status === 'UPDATED' && r.row('agy').status === 'UPDATED' && calls().length === 3, r.out);
check('부분 실패: 비영 종료와 RESULT FAIL', r.code === 1 && /RESULT: FAIL \(1\)/.test(r.out), r.out);

resetWin(['codex', 'claude']);
r = runPs(['-Apply']);
check('미설치 agy는 SKIP, 설치하지 않음, 종료 0', r.code === 0 && r.row('agy').status === 'SKIP' && !calls().includes('agy update') && !existsSync(join(BIN, 'agy.exe')), r.out);

resetWin(['claude', 'agy']); writeFileSync(join(BIN, 'codex.cmd'), '@echo codex-cli 0.169.0\r\n@echo %* >> "%~dp0npm-calls.log"\r\n');
r = runPs(['-Apply']);
check('npm 런처만 있는 codex는 FAIL(독립 설치 필요), 실행하지 않음', r.code === 1 && r.row('codex').status === 'FAIL' && /standalone install required/.test(r.out) && !calls().includes('codex update') && !(existsSync(join(BIN, 'npm-calls.log')) && /update|install/.test(readFileSync(join(BIN, 'npm-calls.log'), 'utf8'))), r.out);
check('npm 런처 버전은 .cmd로 기록만', r.row('codex').before === '0.169.0', r.out);

resetWin(['claude', 'agy']); mkdirSync(FB, { recursive: true }); copyFileSync(MOCK, join(FB, 'codex.exe')); writeFileSync(join(FB, 'codex.ver'), '0.169.0');
r = runPs();
check('PATH에 없으면 설치기 기본 경로의 codex.exe 사용', r.code === 0 && r.row('codex').status === 'READY' && r.out.includes(join(FB, 'codex.exe') + ' update') && calls(FB).length === 0, r.out);

const AGY_FB = join(LAD, 'agy', 'bin');
resetWin(['codex', 'claude']); mkdirSync(AGY_FB, { recursive: true }); copyFileSync(MOCK, join(AGY_FB, 'agy.exe')); writeFileSync(join(AGY_FB, 'agy.ver'), '1.5.15');
r = runPs();
check('PATH에 없으면 설치기 기본 경로의 agy.exe 사용', r.code === 0 && r.row('agy').status === 'READY' && r.out.includes(join(AGY_FB, 'agy.exe') + ' update') && calls(AGY_FB).length === 0, r.out);

resetWin(); writeFileSync(join(BIN, 'agy.verfail'), '');
r = runPs(['-Apply']);
check('버전 확인 실패는 FAIL이고 업데이트하지 않음', r.code === 1 && r.row('agy').status === 'FAIL' && !calls().includes('agy update') && calls().length === 2, r.out);

resetWin(); writeFileSync(join(BIN, 'agy.verexit'), '');
r = runPs(['-Apply']);
check('적용 전: 버전을 출력해도 --version 비영 종료면 FAIL, 업데이트 안 함', r.code === 1 && r.row('agy').status === 'FAIL' && /version check failed/.test(r.out) && !calls().includes('agy update') && calls().length === 2, r.out);
resetWin(); writeFileSync(join(BIN, 'agy.verexit'), '');
r = runPs();
check('미리보기에서도 --version 비영 종료는 FAIL', r.code === 1 && r.row('agy').status === 'FAIL' && calls().length === 0, r.out);

resetWin(); writeFileSync(join(BIN, 'claude.verexitafter'), '');
r = runPs(['-Apply']);
check('적용 후: --version 비영 종료면 FAIL(버전을 출력해도)', r.code === 1 && r.row('claude').status === 'FAIL' && /version check after update failed/.test(r.out) && r.row('claude').after === '-' && r.row('codex').status === 'UPDATED' && calls().length === 3, r.out);

resetWin(); writeFileSync(join(BIN, 'codex.next'), '1.2.0-beta.1');
r = runPs(['-Apply']);
check('prerelease suffix 보존', r.code === 0 && r.row('codex').after === '1.2.0-beta.1' && r.row('codex').status === 'UPDATED', r.out);

resetWin(); writeFileSync(join(BIN, 'codex.korean'), ''); writeFileSync(join(BIN, 'codex.fail'), '');
r = runPs(['-Apply'], { legacyCodePage: true });
check('CP949/NoProfile: UTF-8 한글 stdout 안내와 stderr 오류 보존', r.out.includes('업데이트 안내') && r.out.includes('오류 메시지'), r.out);
check('한글 오류 출력 뒤에도 실패 코드와 나머지 업데이트 보존', r.code === 1 && r.row('codex').status === 'FAIL' && r.row('agy').status === 'UPDATED', r.out);
resetWin(); copyFileSync(MOCK, join(BIN, 'wsl.exe'));
r = runPs([], { legacyCodePage: true, includeWsl: true });
check('CP949/NoProfile: WSL 경유 UTF-8 한글 안내와 오류 보존', r.code === 0 && r.out.includes('WSL 업데이트 안내') && r.out.includes('WSL 오류 메시지') && /WSL:Ubuntu/.test(r.out) && calls().length === 0, r.out);

// ---- WSL half ----
const wslOk = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-e', 'true']).status === 0;
if (!wslOk) console.log('SKIP  WSL Ubuntu 없음: update-tools.sh 테스트 생략');
else {
  const lin = p => spawnSync('wsl.exe', ['-d', 'Ubuntu', '-e', 'wslpath', '-a', '-u', p], { encoding: 'utf8' }).stdout.trim();
  check('update-tools.sh는 LF', !readFileSync(SH, 'utf8').includes('\r'));
  const MOCKSH = '#!/bin/sh\nd=$(dirname "$0"); n=$(basename "$0")\ncase $1 in\n--version) [ -f "$d/$n.verfail" ] && exit 1; echo "$n $(cat "$d/$n.ver" 2>/dev/null || echo 1.0.0)"; [ -f "$d/$n.verexit" ] && exit 4; exit 0;;\nupdate) echo "$n update" >> "$d/calls.log"; [ -f "$d/$n.fail" ] && exit 3; [ -f "$d/$n.next" ] && cp "$d/$n.next" "$d/$n.ver"; [ -f "$d/$n.verexitafter" ] && touch "$d/$n.verexit"; exit 0;;\nesac\n';
  writeFileSync(join(TMP, 'mock.sh'), MOCKSH);
  // a Windows-side folder seen from WSL as /mnt/...: a tool found there must never be run with update
  const WINSIDE = join(TMP, 'winside'); mkdirSync(WINSIDE); writeFileSync(join(WINSIDE, 'agy'), MOCKSH.replace(/\n/g, '\n'));
  const SETUP = 'set -e\nd=$(mktemp -d /tmp/updtest-XXXXXX)\nmkdir -p "$d/bin"\necho "$d"\n';
  writeFileSync(join(TMP, 'setup.sh'), SETUP);
  const mk = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-e', 'bash', lin(join(TMP, 'setup.sh'))], { encoding: 'utf8' });
  const made = (mk.stdout || '').trim();
  if (mk.status !== 0 || !WSL_TMP.test(made)) {
    check('WSL 임시 폴더 준비(mktemp 종료 0, 정확한 /tmp/updtest-* 경로)', false, `exit ${mk.status}: ${JSON.stringify(made)} ${mk.stderr || ''}`);
    console.log(`\n${total - bad}/${total} passed (WSL 테스트 중단: 임시 폴더를 만들지 못함)`);
    process.exit(1);
  }
  wslDir = made;
  const MOCKLIN = lin(join(TMP, 'mock.sh')), SHLIN = lin(SH), WINLIN = lin(WINSIDE);
  const bash = script => spawnSync('wsl.exe', ['-d', 'Ubuntu', '-e', 'bash', '-c', script], { encoding: 'utf8' });
  const resetLin = (tools = TOOLS) => bash(`set -e; b='${wslDir}/bin'; rm -rf "$b"; mkdir -p "$b"; for t in ${tools.join(' ')}; do cp '${MOCKLIN}' "$b/$t"; chmod +x "$b/$t"; echo 1.0.0 > "$b/$t.ver"; echo 1.1.0 > "$b/$t.next"; done; chmod +x '${WINLIN}/agy' || true`);
  const linCalls = () => bash(`cat '${wslDir}/bin/calls.log' 2>/dev/null`).stdout.trim().split('\n').filter(Boolean);
  const runSh = (mode, extraPath = '') => {
    const res = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-e', 'env', '-i', 'HOME=/tmp', `PATH=${wslDir}/bin:/usr/bin:/bin${extraPath}`, 'bash', SHLIN, mode], { encoding: 'utf8' });
    const rows = Object.fromEntries(res.stdout.split('\n').filter(l => l.startsWith('ROW\t')).map(l => { const p = l.split('\t'); return [p[1], { before: p[2], after: p[3], status: p[4], detail: p[5] }]; }));
    return { code: res.status, out: res.stdout + res.stderr, rows };
  };
  if (!WSL_TMP.test(wslDir)) check('WSL 임시 폴더 준비', false, wslDir);
  else {
    resetLin();
    let s = runSh('preview');
    check('WSL 미리보기: 모두 READY, update 없음, 종료 0', s.code === 0 && TOOLS.every(t => s.rows[t]?.status === 'READY') && linCalls().length === 0, s.out);
    resetLin(); bash(`echo 1.0.0 > '${wslDir}/bin/agy.next'`);
    s = runSh('apply');
    check('WSL 적용: 각 1회, UPDATED/CURRENT', s.code === 0 && linCalls().length === 3 && s.rows.codex?.status === 'UPDATED' && s.rows.codex.after === '1.1.0' && s.rows.agy?.status === 'CURRENT', s.out);
    resetLin(); bash(`touch '${wslDir}/bin/claude.fail'`);
    s = runSh('apply');
    check('WSL 부분 실패: 계속 진행 후 비영 종료', s.code === 1 && s.rows.claude?.status === 'FAIL' && s.rows.agy?.status === 'UPDATED' && linCalls().length === 3, s.out);
    resetLin(['codex', 'claude']);
    s = runSh('apply', ':' + WINLIN);
    check('WSL 경계: /mnt/ 경로의 agy는 SKIP, 실행하지 않음', s.code === 0 && s.rows.agy?.status === 'SKIP' && /Windows binary/.test(s.rows.agy.detail) && !existsSync(join(WINSIDE, 'calls.log')), s.out);
    resetLin(['codex']);
    s = runSh('apply');
    check('WSL 미설치는 SKIP', s.code === 0 && s.rows.claude?.status === 'SKIP' && s.rows.agy?.status === 'SKIP' && linCalls().length === 1, s.out);
    resetLin(); bash(`touch '${wslDir}/bin/agy.verexit'`);
    s = runSh('apply');
    check('WSL 적용 전: --version 비영 종료면 FAIL, 업데이트 안 함', s.code === 1 && s.rows.agy?.status === 'FAIL' && /version check failed/.test(s.rows.agy.detail) && !linCalls().includes('agy update') && linCalls().length === 2, s.out);
    resetLin(); bash(`touch '${wslDir}/bin/claude.verexitafter'`);
    s = runSh('apply');
    check('WSL 적용 후: --version 비영 종료면 FAIL', s.code === 1 && s.rows.claude?.status === 'FAIL' && /after update failed/.test(s.rows.claude.detail) && s.rows.codex?.status === 'UPDATED' && linCalls().length === 3, s.out);
    resetLin(); bash(`echo 1.2.0-beta.1 > '${wslDir}/bin/codex.next'`);
    s = runSh('apply');
    check('WSL prerelease suffix 보존', s.code === 0 && s.rows.codex?.after === '1.2.0-beta.1', s.out);
  }
}
console.log(`\n${total - bad}/${total} passed`);
process.exit(bad ? 1 : 0);
