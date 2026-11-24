// Real Git/PowerShell regression tests in one isolated temporary folder; cross-platform (Windows PowerShell / pwsh).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const KIT = dirname(fileURLToPath(import.meta.url)), VERIFY = join(KIT, 'verify.ps1');
const IS_WIN = process.platform === 'win32';
const PWSH = IS_WIN ? 'powershell' : 'pwsh';
const PWSH_BASE = IS_WIN ? ['-NoProfile', '-ExecutionPolicy', 'Bypass'] : ['-NoProfile'];
const TMP = mkdtempSync(join(tmpdir(), 'verifytest-')), P = join(TMP, 'proj'), NG = join(TMP, 'nogit');
process.on('exit', () => {
  if (dirname(resolve(TMP)) === resolve(tmpdir()) && basename(TMP).startsWith('verifytest-')) {
    try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
});
const git = (args, cwd = P) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  if (r.status) throw new Error(args.join(' ') + ': ' + r.stderr);
  return r.stdout.trim();
};
mkdirSync(join(P, 'handoff'), { recursive: true }); mkdirSync(join(NG, 'handoff'), { recursive: true });
git(['init', '-q', '-b', 'main']);
writeFileSync(join(P, '.gitignore'), 'handoff/\n.worktrees/\nignored-cache/\n');
writeFileSync(join(P, 'a.txt'), 'a\n');
git(['add', '-A']); git(['commit', '-q', '-m', 'init']);
git(['checkout', '-q', '-b', 'feat']); writeFileSync(join(P, 'b.txt'), 'b\n');
git(['add', '-A']); git(['commit', '-q', '-m', 'feat']);
const HEAD = git(['rev-parse', 'HEAD']);
const handoff = (id, cmd = 'echo hello', extra = '', dir = P) =>
  writeFileSync(join(dir, 'handoff', id + '.md'), '---\nid: ' + id + '\nverify: ' + cmd + (extra ? '\n' + extra : '') + '\n---\n## goal\n');
function run(id, opts = {}) {
  const args = [...PWSH_BASE, '-File', VERIFY, '-Id', id, '-Project', opts.project || P];
  for (const [k, flag] of [['repo','-Repo'], ['base','-Base'], ['reviewed','-ReviewedCommit'], ['reviewReport','-ReviewReport']]) if (opts[k]) args.push(flag, opts[k]);
  if (opts.mode) args.push('-' + opts.mode);
  if (opts.rerun) args.push('-Rerun');
  if (opts.manual) args.push('-Manual');
  const r = spawnSync(PWSH, args, { cwd: P, encoding: 'utf8' });
  const out = r.stdout || '';
  return { code:r.status, out, err:r.stderr || '', field:k => (new RegExp('^' + k + ': (.*)$', 'm').exec(out) || [])[1]?.trim() };
}
const prepare = (id, opts = {}) => run(id, { ...opts, mode:'Prepare' });
const read = (id, name) => readFileSync(join(P, 'handoff', id, 'verify', name), 'utf8');
const json = (id, name) => JSON.parse(readFileSync(join(P, 'handoff', id, name), 'utf8'));
const nodePrint = (lines) => {
  const b64 = Buffer.from(lines.join('\n') + '\n', 'utf8').toString('base64');
  return `node -e "process.stdout.write(Buffer.from('${b64}','base64').toString())"`;
};

let bad = 0, total = 0;
function check(name, ok, detail = '') { total++; if (!ok) bad++; console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '\n' + detail)); }
function pass(name, r) { check(name, r.code === 0 && r.field('RESULT')?.startsWith('PASS'), r.out + r.err); }
function fail(name, r, text) { check(name, r.code !== 0 && r.field('RESULT')?.startsWith('FAIL') && (!text || r.out.includes(text)), r.out + r.err); }

handoff('T01');
fail('승인 없는 작업은 명령 실행 전 실패', run('T01'), 'snapshot missing');
let r = prepare('T01'); pass('착수 기준 고정', r);
check('Prepare는 검증을 실행하지 않음', !existsSync(join(P, 'handoff/T01/verify/output.txt')));
const approval = json('T01', 'approved.json');
check('승인 기준은 main commit과 인계 hash', approval.baseRef === 'main' && approval.baseCommit === git(['rev-parse', 'main']) && approval.handoffHash.length === 64);
r = run('T01'); pass('통과 명령: EXIT 0 / 마지막 RESULT PASS', r);
check('전체 커밋 hash', r.field('COMMIT').startsWith(HEAD + ' '));
check('깨끗한 폴더와 변경 없음', r.field('DIRTY') === 'no' && r.field('CHANGED-BY-COMMAND') === 'no');
check('명령 원시 출력과 diff/files 증거', /hello/.test(read('T01','output.txt')) && /b\.txt/.test(read('T01','diff.patch')) && /a\.txt/.test(read('T01','files.txt')));
const firstOut = r.field('OUT'), firstSummary = readFileSync(join(firstOut,'summary.txt'),'utf8');
r = run('T01'); pass('동일 커밋 재실행', r);
check('이전 실행 증거는 보존되고 최신보기만 갱신', r.field('OUT') !== firstOut && readFileSync(join(firstOut,'summary.txt'),'utf8') === firstSummary);
pass('동일 worker PASS에 대한 설계자 경량 수락(재실행 생략)', run('T01',{mode:'Accept'}));
pass('제출 직전 수락 동일성 확인', run('T01',{mode:'CheckAccepted'}));
check('수락 근거가 실제 worker 실행 폴더를 가리킴', existsSync(join(json('T01','accepted.json').run,'summary.txt')));
writeFileSync(join(P,'handoff/T01.md'), readFileSync(join(P,'handoff/T01.md'),'utf8') + 'changed criterion\n');
fail('인수 조건 변경은 실행 전 실패', run('T01'), 'handoff changed');
fail('인수 조건 변경 후 제출 차단', run('T01',{mode:'CheckAccepted'}), 'handoff changed');
pass('설계자 명시 재승인', prepare('T01'));
fail('재승인하면 기존 수락은 무효', run('T01',{mode:'CheckAccepted'}), 'no acceptance');
fail('재승인 뒤 worker PASS 없이 수락 불가', run('T01',{mode:'Accept'}), 'prior worker PASS');
pass('재승인 기준으로 새 검증', run('T01'));

handoff('CRIT','echo critical','review: critical');
pass('critical 승인',prepare('CRIT'));
let critWorker = run('CRIT');
pass('critical 작업자 검증',critWorker);
const critOut1 = critWorker.field('OUT');
const critRep = join(P,'handoff','sub-crit-review-1-report.md');
fail('critical은 검토 커밋 필수',run('CRIT',{mode:'Accept'}),'requires -ReviewedCommit');
fail('critical은 -ReviewReport 필수(누락 시 차단)',run('CRIT',{mode:'Accept',reviewed:HEAD}),'requires -ReviewReport');
writeFileSync(critRep, '판정: 진행 가능\n');
fail('critical 보고서에 높음 0 누락 시 차단',run('CRIT',{mode:'Accept',reviewed:HEAD,reviewReport:'handoff/sub-crit-review-1-report.md'}),'높음 0');
writeFileSync(critRep, '판정: 진행 가능 | 높음 0 | 중간 0 | 낮음 0\n');
fail('critical 보고서에 검토 commit 줄 누락 시 차단',run('CRIT',{mode:'Accept',reviewed:HEAD,reviewReport:'handoff/sub-crit-review-1-report.md'}),'missing 검토 commit');
writeFileSync(critRep, `판정: 진행 가능 | 높음 0 | 중간 0 | 낮음 0\n검토 commit: ${HEAD}\n`);
fail('critical 보고서에 검증 경로 줄 누락 시 차단',run('CRIT',{mode:'Accept',reviewed:HEAD,reviewReport:'handoff/sub-crit-review-1-report.md'}),'missing 검증 경로');
writeFileSync(critRep, `판정: 진행 가능 | 높음 0 | 중간 0 | 낮음 0\n검토 commit: ${HEAD}\n검증 경로:\n`);
fail('critical 보고서의 빈 검증 경로(검증 경로:) 차단',run('CRIT',{mode:'Accept',reviewed:HEAD,reviewReport:'handoff/sub-crit-review-1-report.md'}),'empty 검증 경로');
writeFileSync(critRep, `판정: 진행 가능 | 높음 0 | 중간 0 | 낮음 0\n검토 commit: ${HEAD}\n검증 경로: ${join(P,'handoff','CRIT','verify','runs','other-stale-run')}\n`);
fail('critical 보고서의 검증 경로가 수락할 worker OUT과 다르면 차단',run('CRIT',{mode:'Accept',reviewed:HEAD,reviewReport:'handoff/sub-crit-review-1-report.md'}),'differs from verified worker run OUT');
writeFileSync(critRep, `판정: 진행 가능 | 높음 0 | 중간 0 | 낮음 0\n검토 commit: ${HEAD}\n검증 경로: ${critOut1}\n`);
fail('다른 검토 커밋 수락 차단',run('CRIT',{mode:'Accept',reviewed:'0'.repeat(40),reviewReport:'handoff/sub-crit-review-1-report.md'}),'reviewed commit differs');
pass('검토 보고서(판정·커밋·검증 경로 OUT 일치) 동반 시 critical 경량 수락 성공(이전 실패 후에도 worker PASS 보존)',run('CRIT',{mode:'Accept',reviewed:HEAD,reviewReport:'handoff/sub-crit-review-1-report.md'}));
writeFileSync(join(P,'acceptance-dirty.txt'),'uncommitted');
fail('수락 뒤 실패한 재검증',run('CRIT'),'uncommitted');
rmSync(join(P,'acceptance-dirty.txt'));
fail('실패한 재검증은 이전 수락을 무효화',run('CRIT',{mode:'CheckAccepted'}),'no acceptance');
critWorker = run('CRIT');
pass('critical 새 worker 검증',critWorker);
fail('새 worker 실행 후 옛날 OUT을 가리키는 이전 검토 보고서로는 수락 불가',run('CRIT',{mode:'Accept',reviewed:HEAD,reviewReport:'handoff/sub-crit-review-1-report.md'}),'differs from verified worker run OUT');
const critOut2 = critWorker.field('OUT');
writeFileSync(critRep, `판정: 진행 가능 | 높음 0 | 중간 0 | 낮음 0\n검토 commit: ${HEAD}\n검증 경로: ${critOut2}\n`);
pass('critical -Accept -Rerun 시 workerRun에 검토된 OUT을 보존하고 run에 새 재실행 기록',run('CRIT',{mode:'Accept',rerun:true,reviewed:HEAD,reviewReport:'handoff/sub-crit-review-1-report.md'}));
const critRerunAcc = json('CRIT','accepted.json');
check('-Accept -Rerun의 workerRun이 검토 대상 OUT과 일치하고 run은 별도 재실행임',critRerunAcc.workerRun===critOut2 && critRerunAcc.run!==critOut2);

handoff('FAIL', 'node -e "console.log(\'boot 1\'); console.log(\'boot 2\'); console.log(\'AssertionError: early failure\'); for(let i=4;i<=32;i++) console.log(\'ok step \'+i); console.error(\'err-stream\'); process.exit(7)"'); prepare('FAIL'); r=run('FAIL');
check('명령 실패 code7·앞부분 에러 줄 선별 및 꼬리 병합 FAILURE-EXCERPT 자동 출력',
  r.code===7 && r.field('EXIT')==='7' && /early failure/.test(read('FAIL','output.txt')) && /err-stream/.test(read('FAIL','output.txt'))
  && /\[L[1-5]\] AssertionError: early failure/.test(read('FAIL','failure-excerpt.txt'))
  && /\[L3[23]\]/.test(read('FAIL','failure-excerpt.txt'))
  && /\d+ of 33 line\(s\)/.test(r.field('FAILURE-EXCERPT')||'')
  && /\[L[1-5]\] AssertionError: early failure/.test(r.out)
  && /^FAIL exit 7/.test(r.field('RESULT')), r.out);
for(const [id,body] of [
  ['NONE','---\nverify: -\n---\n'],['COMMENT','---\nverify: - # manual\n---\n'],
  ['BODY','---\nreview: normal\n---\nverify: echo do-not-run\n'],['NOHEADER','verify: echo do-not-run\n']]){
  writeFileSync(join(P,'handoff',id+'.md'),body); r=run(id);
  check(id+' 수동/머리말 없는 명령은 NONE code3',r.code===3 && r.field('RESULT').startsWith('NONE'),r.out);
}
writeFileSync(join(P,'handoff/BADHDR.md'),'---\nverify : echo typo\n---\n');
check('머리말 콜론 앞 공백 오타(verify : ...)는 NONE으로 강등되지 않고 code2 오류',prepare('BADHDR').code===2);
check('점(.)이 포함된 작업 ID 거부(hc --name 호환)',prepare('T1.1').code===2);

handoff('QUOTES','echo "a b" && echo second'); prepare('QUOTES'); r=run('QUOTES');
check('따옴표와 && 명령 유지',r.code===0 && /a b/.test(read('QUOTES','output.txt')) && /second/.test(read('QUOTES','output.txt')));

// Build cache & 0-test checks (including Rust multi-target fix and Go [no test files])
handoff('GRADLEUTD', nodePrint(['> Task :compileTestJava UP-TO-DATE', '> Task :test UP-TO-DATE', 'BUILD SUCCESSFUL', '5 actionable tasks: 5 up-to-date'])); prepare('GRADLEUTD');
r=run('GRADLEUTD'); fail('Gradle 테스트가 UP-TO-DATE로 건너뛰면 PASS가 아님',r,'build cache'); check('캐시 실패는 code1',r.code===1,r.out);
handoff('GRADLESUM', nodePrint(['BUILD SUCCESSFUL', '3 actionable tasks: 1 from cache, 2 up-to-date'])); prepare('GRADLESUM');
fail('실행된 태스크 없는 Gradle 요약도 PASS가 아님',run('GRADLESUM'),'build cache');
handoff('GRADLECACHE', nodePrint(['> Task :app:integrationTest FROM-CACHE', '4 actionable tasks: 1 executed, 1 from cache, 2 up-to-date'])); prepare('GRADLECACHE');
fail('테스트 태스크를 빌드 캐시에서 가져오면 PASS가 아님',run('GRADLECACHE'),'build cache');
handoff('GRADLERAN', nodePrint(['> Task :compileTestJava UP-TO-DATE', '> Task :test', '5 actionable tasks: 1 executed, 4 up-to-date'])); prepare('GRADLERAN');
pass('테스트가 실제로 실행된 Gradle 출력은 PASS',run('GRADLERAN'));
handoff('GRADLESKIP', nodePrint(['> Task :test SKIPPED', '2 actionable tasks: 1 executed, 1 up-to-date'])); prepare('GRADLESKIP');
fail('Gradle 테스트 태스크가 SKIPPED면 PASS가 아님',run('GRADLESKIP'),'build cache');
handoff('GRADLENOSRC', nodePrint(['> Task :check NO-SOURCE', '1 actionable task: 1 executed'])); prepare('GRADLENOSRC');
fail('Gradle check 태스크가 NO-SOURCE면 PASS가 아님',run('GRADLENOSRC'),'build cache');
handoff('GOCACHED', nodePrint(['ok  \texample.com/pkg\t(cached)'])); prepare('GOCACHED');
fail('Go 테스트가 전부 (cached)면 PASS가 아님',run('GOCACHED'),'build cache');
handoff('GONOFILES', nodePrint(['?   \texample.com/pkg\t[no test files]'])); prepare('GONOFILES');
fail('Go 테스트 파일이 아예 없는([no test files]) 출력은 PASS가 아님',run('GONOFILES'),'build cache');
handoff('CARGOOK', nodePrint(['running 12 tests', 'test result: ok. 12 passed; 0 failed', 'Doc-tests mycrate', 'running 0 tests', 'test result: ok. 0 passed'])); prepare('CARGOOK');
pass('Rust cargo test: 단위 테스트가 실행됐으면 doc-test running 0 tests가 있어도 PASS',run('CARGOOK'));
handoff('CARGOZERO', nodePrint(['running 0 tests', 'test result: ok. 0 passed; 0 failed'])); prepare('CARGOZERO');
fail('Rust cargo test: 모든 타겟이 running 0 tests면 FAIL',run('CARGOZERO'),'build cache');
handoff('NOTESTS','echo No tests found, exiting with code 0'); prepare('NOTESTS');
fail('테스트 0건(No tests found) 출력은 PASS가 아님',run('NOTESTS'),'build cache');

// Manual Git task (`verify: -`) prepare + `-Accept -Manual` + `-CheckAccepted` (prevents direct push deadlock)
writeFileSync(join(P,'handoff/MAN.md'),'---\nid: MAN\nreview: normal\nverify: -\n---\n## manual goal\n');
pass('수동 Git 작업(verify: -)도 -Prepare로 기준 고정 가능',prepare('MAN'));
check('수동 Git 작업의 일반 실행은 여전히 NONE code3',run('MAN').code===3);
pass('수동 Git 작업의 -Accept -Manual 수락 기록 생성',run('MAN',{mode:'Accept',manual:true}));
pass('수동 Git 작업 수락 후 -CheckAccepted 통과',run('MAN',{mode:'CheckAccepted'}));

writeFileSync(join(P,'dirty.txt'),'source');
fail('미추적 소스 있으면 실패',run('T01'),'uncommitted');
git(['config','status.showUntrackedFiles','no']);
fail('status 설정으로 미추적 소스를 숨겨도 실패',run('T01'),'uncommitted');
git(['config','--unset','status.showUntrackedFiles']); rmSync(join(P,'dirty.txt'));
handoff('CACHE', 'node -e "require(\'fs\').writeFileSync(\'cache.txt\',\'cache\')"'); prepare('CACHE');
fail('명령이 만든 미추적 파일도 첫 실행부터 실패',run('CACHE'),'uncommitted');
fail('같은 생성물 두 번째 실행도 실패',run('CACHE'),'uncommitted'); rmSync(join(P,'cache.txt'));
handoff('IGNORED', 'node -e "const fs=require(\'fs\');fs.mkdirSync(\'ignored-cache\',{recursive:true});fs.writeFileSync(\'ignored-cache/out.txt\',\'cache\')"'); prepare('IGNORED');
pass('명시 ignore 생성물 첫 실행',run('IGNORED')); pass('명시 ignore 생성물 반복 실행',run('IGNORED'));
handoff('EDIT', 'node -e "require(\'fs\').appendFileSync(\'a.txt\',\'changed\\n\')"'); prepare('EDIT'); r=run('EDIT');
fail('검사 중 추적 파일 수정은 실패',r,'changed tracked'); check('추적 변경 표시',r.field('CHANGED-BY-COMMAND').startsWith('yes'));
git(['restore','a.txt']);
git(['update-index','--skip-worktree','a.txt']); writeFileSync(join(P,'a.txt'),'hidden\n');
fail('skip-worktree 숨긴 변경은 실패',run('T01'),'hidden');
git(['update-index','--no-skip-worktree','a.txt']); git(['restore','a.txt']);
handoff('EMPTY'); prepare('EMPTY',{base:'HEAD'}); fail('명시 기준 HEAD의 빈 diff 실패',run('EMPTY'),'empty diff');
handoff('BASE'); pass('유효한 명시 Base 허용',prepare('BASE',{base:'main'})); pass('같은 명시 Base 검증',run('BASE',{base:'main'}));
fail('승인 뒤 Base 변경 불가',run('BASE',{base:'HEAD'}),'differs from approved');
pass('BASE 수락',run('BASE',{mode:'Accept'})); fail('명령 실행 전 실패한 기본 재실행(다른 Base)',run('BASE',{base:'HEAD'}),'differs from approved');
check('명령 전 기본 재실행 FAIL도 기존 수락을 무효화',!existsSync(join(P,'handoff/BASE/accepted.json')));
fail('무효화된 수락으로는 제출 대조 실패',run('BASE',{mode:'CheckAccepted'}));
fail('존재하지 않는 명시 Base는 fallback 안 함',prepare('BASE',{base:'missing'}),'no valid base');
git(['branch','-m','main','trunk']);
handoff('TRUNK'); fail('기준 후보 없으면 Prepare 실패',prepare('TRUNK'),'no valid base');
pass('trunk 명시 기준',prepare('TRUNK',{base:'trunk'})); pass('trunk 검증',run('TRUNK'));
git(['update-ref','refs/remotes/origin/develop',git(['rev-parse','trunk'])]); git(['symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/develop']);
handoff('REMOTE'); r=prepare('REMOTE'); check('원격 기본 브랜치 develop 자동 선택',r.code===0 && r.field('BASE')==='origin/develop',r.out);
git(['config','agentkit.base','trunk']); handoff('CONFIG'); r=prepare('CONFIG'); check('프로젝트 설정이 원격 기본값보다 우선',r.field('BASE')==='trunk',r.out);
handoff('HEADER','echo hello','base: origin/develop'); r=prepare('HEADER'); check('인계 base가 설정보다 우선',r.field('BASE')==='origin/develop',r.out);
r=prepare('HEADER',{base:'trunk'}); check('명시 -Base가 인계보다 우선',r.field('BASE')==='trunk',r.out);
git(['config','--unset','agentkit.base']); git(['symbolic-ref','--delete','refs/remotes/origin/HEAD']);
git(['branch','-m','trunk','main']);
git(['checkout','-q','--orphan','unrelated']); git(['commit','-q','--allow-empty','-m','unrelated']); git(['checkout','-q','feat']);
handoff('UNRELATED'); prepare('UNRELATED',{base:'unrelated'}); fail('공통 조상 없는 diff 오류 실패',run('UNRELATED'),'git failed: diff');
r=run('UNKNOWN'); check('인계 없음 code2',r.code===2);
r=run('..'); check('상위 경로 ID 거부',r.code===2);
handoff('NG','echo hello','',NG); fail('비Git 자동 성공 금지',run('NG',{project:NG}),'Git repository unavailable');
const WT=join(P,'.worktrees','t07'); handoff('WT');
pass('생성 전 worktree의 경로와 공통 저장소 승인',prepare('WT',{repo:WT}));
git(['worktree','add','-q','-b','wt',WT]); writeFileSync(join(WT,'c.txt'),'c\n'); git(['add','-A'],WT); git(['commit','-q','-m','wt'],WT);
const wtHead=git(['rev-parse','HEAD'],WT);
r=run('WT',{repo:WT}); check('worktree 커밋 검증, 증거는 Project',r.code===0 && r.field('COMMIT').startsWith(wtHead+' ') && !existsSync(join(WT,'handoff/WT/verify')),r.out);
fail('승인과 다른 Repo로 실행 차단',run('WT'),'repository differs');
r=run('WT',{project:WT}); check('worktree 안 Project 거부',r.code===2);
handoff('WT2'); pass('.worktrees가 이미 있어도 생성 전 worktree 승인',prepare('WT2',{repo:join(P,'.worktrees','t08')}));
handoff('WT3'); fail('.worktrees 아래 한 단계가 아닌 경로는 거부',prepare('WT3',{repo:join(P,'.worktrees','x','t09')}),'not a repository or worktree root');
const SUB=join(P,'subrepo-dir'); mkdirSync(SUB,{recursive:true});
handoff('SUB'); fail('저장소 루트가 아닌 하위 폴더 Repo 거부',prepare('SUB',{repo:SUB}),'not a repository or worktree root');
writeFileSync(join(P,'handoff/T01.md'),'---\nid: T01\nverify: -\n---\n## goal\n');
fail('승인된 자동 검증 작업을 verify: - 로 바꾸면 실패',run('T01',{mode:'CheckAccepted'}),'handoff changed');
handoff('T01'); prepare('T01'); pass('T01 원상 복구 후 검증',run('T01'));
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
const relativeRepo = spawnSync(PWSH,[...PWSH_BASE,'-Command',
  'Set-Location -LiteralPath '+psQuote(P)+'; & '+psQuote(VERIFY)+' -Id T01 -Project '+psQuote(P)+' -Repo .'],{cwd:TMP,encoding:'utf8'});
check('세션 내 cd 후 상대 Repo는 PowerShell 현재 폴더 기준',relativeRepo.status===0 && /RESULT: PASS/.test(relativeRepo.stdout),relativeRepo.stdout+relativeRepo.stderr);
handoff('DUP','echo hello','verify: echo duplicate');
check('중복 verify 머리말 거부',prepare('DUP').code===2);
handoff('BADREVIEW','echo hello','review: typo');
check('잘못된 review 등급 거부',prepare('BADREVIEW').code===2);
handoff('MUTATE', 'node -e "require(\'fs\').appendFileSync(\'handoff/MUTATE.md\',\'changed\\n\')"'); prepare('MUTATE');
fail('명령 도중 인계 변경은 수락 근거가 될 수 없음',run('MUTATE'),'handoff changed during command');
handoff('SIGNALS'); prepare('SIGNALS');
mkdirSync(join(P,'test'),{recursive:true}); writeFileSync(join(P,'test','clean.test.js'),'assert.equal(1, 1);\n');
mkdirSync(join(P,'MyApp.UnitTests'),{recursive:true}); writeFileSync(join(P,'MyApp.UnitTests','AuthTests.cs'),'// initial camelcase test\n');
git(['add','-A']); git(['commit','-q','-m','clean new test']);
r=run('SIGNALS'); pass('신규 정상 테스트 추가는 PASS',r);
check('신규 테스트 파일 추가만으로는 TEST-CHANGES 위험 신호가 0',r.field('TEST-CHANGES').startsWith('0') && /added tests: 2/.test(r.field('TEST-CHANGES')),r.out);
handoff('SIGNALS2'); prepare('SIGNALS2',{base:'HEAD'});
writeFileSync(join(P,'test','sample.test.js'),'test.skip("later", () => {});\n');
writeFileSync(join(P,'test','clean.test.js'),'@Disabled\n// assertion removed\n');
writeFileSync(join(P,'MyApp.UnitTests','AuthTests.cs'),'// modified camelcase test\n');
git(['add','-A']); git(['commit','-q','-m','test signal']);
r=run('SIGNALS2'); pass('테스트 변경 신호는 자동 실패 아님',r);
check('기존 테스트 수정(CamelCase AuthTests.cs 포함)·skip·assert 삭제 신호 보존',Number.parseInt(r.field('TEST-CHANGES'))>=5 && /AuthTests\.cs/.test(read('SIGNALS2','test-changes.txt')) && /clean\.test\.js/.test(read('SIGNALS2','test-changes.txt')) && /test\.skip/.test(read('SIGNALS2','test-changes.txt')),r.out+'\n'+read('SIGNALS2','test-changes.txt'));

// SPEC hash, CRLF tolerance, manual evidence, -Accept non-destructive failure, and -ReviewReport whitelist check.
writeFileSync(join(P,'.git','info','exclude'),'/SPEC.md\n');
writeFileSync(join(P,'SPEC.md'),'# Spec v1\n');
handoff('META','echo ok','review: critical'); prepare('META');
const metaApp = json('META','approved.json');
check('Prepare가 SPEC.md 해시를 기록',typeof metaApp.specHash==='string' && metaApp.specHash.length===64);
// CRLF conversion of handoff without text change must keep the same normalized hash
writeFileSync(join(P,'handoff/META.md'), readFileSync(join(P,'handoff/META.md'),'utf8').replace(/\r?\n/g,'\r\n'));
writeFileSync(join(P,'SPEC.md'),'# Spec v2\n');
mkdirSync(join(P,'handoff','META','evidence'),{recursive:true});
const evFresh = join(P,'handoff','META','evidence','fresh.txt');
const evStale = join(P,'handoff','META','evidence','stale.txt');
writeFileSync(evFresh,'fresh'); writeFileSync(evStale,'stale');
spawnSync(PWSH,[...PWSH_BASE,'-Command',`(Get-Item -LiteralPath '${evStale}').LastWriteTimeUtc = (Get-Date).ToUniversalTime().AddHours(-2)`]);
r=run('META'); pass('CRLF 변환 허용 및 SPEC 변경·수동 증거 기록 실행 PASS',r);
check('SPEC 변경 신호 출력',r.field('SPEC-CHANGED').startsWith('yes'),r.out);
check('수동 증거 해시·오래된 증거 WARN 출력',/2 file\(s\); WARN 1 file\(s\) older than HEAD commit \(stale\.txt\)/.test(r.field('EVIDENCE')||''),r.out);
const metaWorkerOut = r.field('OUT');
const metaHead = git(['rev-parse','HEAD']);
const repPath = join(P,'handoff','sub-meta-review-1-report.md');
const badRepPath = join(P,'handoff','sub-meta-review-bad-report.md');
const titledBadRepPath = join(P,'handoff','sub-meta-review-titled-bad-report.md');
writeFileSync(badRepPath,'판정: 중단 | 높음 2 | 중간 0 | 낮음 0\n');
writeFileSync(titledBadRepPath,'# T01 검토 보고\n판정: 중단 | 높음 1 | 중간 0 | 낮음 0\n');
writeFileSync(repPath,`판정: 진행 가능 | 높음 0 | 중간 0 | 낮음 0\n검토 commit: ${metaHead}\n검증 경로: ${metaWorkerOut}\n`);
fail('존재하지 않는 -ReviewReport는 실패',run('META',{mode:'Accept',reviewed:metaHead,reviewReport:'handoff/missing-report.md'}),'review report not found');
fail('판정이 중단인 -ReviewReport는 수락 거부(worker 재실행 없이도 바로 재시도 가능)',run('META',{mode:'Accept',reviewed:metaHead,reviewReport:'handoff/sub-meta-review-bad-report.md'}),'verdict is not pass');
fail('제목 줄 뒤에 중단 판정이 있는 보고서도 화이트리스트로 수락 거부',run('META',{mode:'Accept',reviewed:metaHead,reviewReport:'handoff/sub-meta-review-titled-bad-report.md'}),'verdict is not pass');
pass('실패한 -Accept가 worker PASS를 파괴하지 않아 재검증 없이 즉시 정상 수락 통과',run('META',{mode:'Accept',reviewed:metaHead,reviewReport:'handoff/sub-meta-review-1-report.md'}));
const metaAcc = json('META','accepted.json');
check('accepted.json에 kind·reviewReport·reviewVerdict·evidence 보존',metaAcc.kind==='accept' && /sub-meta-review-1-report\.md$/.test(metaAcc.reviewReport) && metaAcc.reviewVerdict.includes('진행 가능') && Array.isArray(metaAcc.evidence) && metaAcc.evidence.length===2,JSON.stringify(metaAcc));
fail('이미 수락된 뒤 새 worker 검증 없이 동일 보고서 재수락 호출 차단',run('META',{mode:'Accept',reviewed:metaHead,reviewReport:'handoff/sub-meta-review-1-report.md'}),'already accepted');
pass('동일 보고서 중복 호출 거부 뒤에도 기존 유효한 수락(-CheckAccepted)은 보존됨',run('META',{mode:'CheckAccepted'}));
handoff('MANCRIT', '-', 'review: critical'); prepare('MANCRIT');
const manRep = join(P,'handoff','sub-mancrit-review-1-report.md');
writeFileSync(manRep, `판정: 진행 가능 | 높음 0 | 중간 0 | 낮음 0\n검토 commit: ${metaHead}\n검증 경로: handoff/MANCRIT/approved.json\n`);
fail('critical 수동 검증: evidence 파일이 없으면 수락 거부',run('MANCRIT',{mode:'Accept',manual:true,reviewed:metaHead,reviewReport:'handoff/sub-mancrit-review-1-report.md'}),'requires evidence files');
mkdirSync(join(P,'handoff','MANCRIT','evidence'),{recursive:true});
writeFileSync(join(P,'handoff','MANCRIT','evidence','screen.txt'),'ok\n');
fail('critical 수동 검증: 검증 경로가 evidence 밖(approved.json)이면 수락 거부',run('MANCRIT',{mode:'Accept',manual:true,reviewed:metaHead,reviewReport:'handoff/sub-mancrit-review-1-report.md'}),'handoff/MANCRIT/evidence');
writeFileSync(manRep, `판정: 진행 가능 | 높음 0 | 중간 0 | 낮음 0\n검토 commit: ${metaHead}\n검증 경로: handoff/MANCRIT/evidence\n`);
pass('critical 수동 검증: 실제 evidence 경로와 일치하면 수락 성공',run('MANCRIT',{mode:'Accept',manual:true,reviewed:metaHead,reviewReport:'handoff/sub-mancrit-review-1-report.md'}));
rmSync(join(P,'SPEC.md'));
fail('검토 이후 커밋 변경하면 수락 대조 실패',run('CRIT',{mode:'CheckAccepted'}),'no acceptance');
fail('커밋 변경 후 이전 worker PASS로 수락 불가',run('T01',{mode:'Accept'}),'prior worker PASS');
handoff('HEADCHANGE','git -c user.name=t -c user.email=t@t commit --allow-empty -m verification-must-not-commit'); prepare('HEADCHANGE');
fail('명령이 HEAD를 바꾸면 실패',run('HEADCHANGE'),'HEAD changed');
handoff('GITERR','git config core.worktree missing-check-directory'); prepare('GITERR');
const configPath=join(P,'.git/config'), goodConfig=readFileSync(configPath,'utf8');
r=run('GITERR'); fail('검사 이후 Git 조회 실패를 PASS로 숨기지 않음',r,'git failed:');
check('Git 조회 실패와 검사 명령 종료 코드를 구분',r.field('EXIT')==='0',r.out);
fail('검사 이전 Git 조회 오류도 실패',run('T01'),'Git repository unavailable');
writeFileSync(configPath,goodConfig);

// maxVerifyFailures
handoff('CAP','echo ok'); prepare('CAP'); pass('CAP 초기 통과',run('CAP')); pass('CAP 초기 수락',run('CAP',{mode:'Accept'}));
git(['config','agentkit.maxVerifyFailures','2']);
writeFileSync(join(P,'cap-dirty.txt'),'d');
fail('CAP 실패 1/2',run('CAP'),'uncommitted');
fail('CAP 실패 2/2',run('CAP'),'uncommitted');
rmSync(join(P,'cap-dirty.txt'));
fail('CAP 한도(2회) 도달 시 깨끗한 트리에서도 실행 전 차단',run('CAP'),'max verify failures (2) reached');
fail('CAP 한도 차단 시에도 이전 수락(accepted.json)은 무효화됨',run('CAP',{mode:'CheckAccepted'}),'no acceptance');
pass('설계자가 재-Prepare하면 새 approval로 실패 한도 초기화',prepare('CAP'));
pass('재-Prepare 후 CAP 정상 통과',run('CAP'));
git(['config','--unset','agentkit.maxVerifyFailures']);

// End-to-end fixture: actual node --test, init policy, local bare remote, and ff-only submission.
const FLOW=join(TMP,'flow'), REMOTE=join(TMP,'flow-remote.git');
mkdirSync(FLOW);
git(['init','-q','--bare','-b','develop',REMOTE],TMP);
git(['init','-q','-b','develop'],FLOW);
writeFileSync(join(FLOW,'square.cjs'),'module.exports = x => x;\n');
git(['add','-A'],FLOW); git(['commit','-q','-m','baseline'],FLOW);
git(['remote','add','origin',REMOTE],FLOW); git(['push','-q','origin','develop'],FLOW);
const setup = (...args) => spawnSync(PWSH,[...PWSH_BASE,'-File',join(KIT,'init.ps1'),'-Target',FLOW,...args],{encoding:'utf8'});
let s=setup();
check('통합: 제출 방식 선택 전 훅 없음',s.status===0 && !existsSync(join(FLOW,'.git/hooks/pre-push')),s.stdout+s.stderr);
s=setup('-GitSetup','-Submission','pr','-ProtectedBranches','develop','-Base','develop');
check('통합: 합의한 PR 정책 적용',s.status===0 && existsSync(join(FLOW,'.git/hooks/pre-push')),s.stdout+s.stderr);
handoff('FLOW','node --test','review: normal',FLOW);
pass('통합: 구현 전 기준 고정',prepare('FLOW',{project:FLOW}));
git(['checkout','-q','-b','task/flow'],FLOW);
writeFileSync(join(FLOW,'square.cjs'),'module.exports = x => x * x;\n');
writeFileSync(join(FLOW,'square.test.cjs'),'const {test}=require("node:test"); const assert=require("node:assert/strict"); const square=require("./square.cjs"); test("positive and negative squares",()=>{assert.equal(square(3),9);assert.equal(square(-4),16);assert.equal(square(0),0);});\n');
git(['add','-A'],FLOW); git(['commit','-q','-m','implement and test square'],FLOW);
const flowHead=git(['rev-parse','HEAD'],FLOW);
pass('통합: 작업자 실제 Node 테스트',run('FLOW',{project:FLOW}));
git(['push','-q','origin','task/flow'],FLOW);
pass('통합: 설계자 경량 수락',run('FLOW',{project:FLOW,mode:'Accept'}));
pass('통합: 제출 tip 동일성',run('FLOW',{project:FLOW,mode:'CheckAccepted'}));
check('통합: 원격 작업 브랜치 head 일치',git(['ls-remote','origin','refs/heads/task/flow'],FLOW).startsWith(flowHead));
let pushResult=spawnSync('git',['push','origin','HEAD:develop'],{cwd:FLOW,encoding:'utf8'});
check('통합: PR 정책은 직접 develop push 차단',pushResult.status!==0 && /blocked/.test(pushResult.stderr),pushResult.stderr);
s=setup('-GitSetup','-Submission','direct');
check('통합: direct로 합의 변경',s.status===0,s.stdout+s.stderr);
git(['checkout','-q','develop'],FLOW); git(['merge','--ff-only','task/flow'],FLOW);
pass('통합: ff-only 통합 뒤에도 수락한 tip 동일',run('FLOW',{project:FLOW,mode:'CheckAccepted'}));
git(['push','-q','origin','develop'],FLOW);
check('통합: direct 최종 제출 tip 일치',git(['ls-remote','origin','refs/heads/develop'],FLOW).startsWith(flowHead));
s=setup('-GitSetup','-Submission','local'); check('통합: local 합의 변경',s.status===0,s.stdout+s.stderr);
pushResult=spawnSync('git',['push','origin','HEAD:local-delivery'],{cwd:FLOW,encoding:'utf8'});
check('통합: local은 원격 제출 차단',pushResult.status!==0 && /blocked/.test(pushResult.stderr),pushResult.stderr);
pass('통합: local 브랜치 인계는 수락 유지',run('FLOW',{project:FLOW,mode:'CheckAccepted'}));

console.log(bad ? bad+' FAIL / '+total : 'ALL PASS ('+total+')'); process.exit(bad?1:0);
