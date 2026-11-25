// Regression test for hooks/pre-push and init.ps1 (submission policy, TrackSpec, moved-path refresh, sub-repo projectRoot).
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const PWSH = IS_WIN ? 'powershell' : 'pwsh';
const PWSH_BASE = IS_WIN ? ['-NoProfile', '-ExecutionPolicy', 'Bypass'] : ['-NoProfile'];
const TMP = mkdtempSync(join(tmpdir(), 'prepushtest-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });
process.env.GIT_CONFIG_GLOBAL = join(TMP, 'global.gitconfig');
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[agentkit]\n\tsubmission = direct\n\tprotectedBranches = nothing\n');
const sh = (c, cwd) => execSync(c, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const initR = (...a) => spawnSync(PWSH, [...PWSH_BASE, '-File', join(KIT, 'init.ps1'), ...a], { encoding: 'utf8' });
const init = (...a) => initR(...a).stdout;
const initC = (kv, ...a) => {
  const env = { ...process.env, GIT_CONFIG_COUNT: String(kv.length) };
  kv.forEach(([k, v], n) => { env[`GIT_CONFIG_KEY_${n}`] = k; env[`GIT_CONFIG_VALUE_${n}`] = v; });
  return spawnSync(PWSH, [...PWSH_BASE, '-File', join(KIT, 'init.ps1'), ...a], { encoding: 'utf8', env });
};
const author = (cwd) => git(['log', '-1', '--format=%an <%ae>'], cwd).stdout.trim();
const id = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const cfg = (key, cwd) => git(['config', '--local', '--get', key], cwd).stdout.trim();
const hookOf = (cwd) => sh('git rev-parse --path-format=absolute --git-path hooks', cwd).trim() + '/pre-push';

function mk(name) {
  const dir = `${TMP}/${name}`;
  sh(`git init -q --bare -b main "${TMP}/${name}.git"`);
  sh(`git clone -q "${TMP}/${name}.git" "${dir}"`);
  sh('git checkout -q -b main', dir);
  git([...id, 'commit', '-q', '--allow-empty', '-m', 'init'], dir);
  git(['push', '-q', 'origin', 'main'], dir);
  git([...id, 'commit', '-q', '--allow-empty', '-m', 'main ahead'], dir);
  sh('git checkout -q -b feat', dir);
  git([...id, 'commit', '-q', '--allow-empty', '-m', 'feat'], dir);
  return dir;
}
const REPO = mk('repo');
const DIRECT = mk('direct');
const LOCAL = mk('local');
const DEV = mk('dev');
const OLD = mk('old');
sh('git branch develop', DEV); git(['push', '-q', 'origin', 'develop'], DEV); sh('git remote set-head origin develop', DEV);
sh('git branch develop', DIRECT);
writeFileSync(hookOf(OLD), readFileSync(join(KIT, 'hooks', 'pre-push'), 'utf8'));
sh(`git init -q -b main "${TMP}/fresh"`);
sh(`git init -q -b main "${TMP}/fresh2"`);
sh(`git init -q -b main "${TMP}/husky"`); sh('git config core.hooksPath .husky', `${TMP}/husky`);
sh(`git init -q -b main "${TMP}/own"`); writeFileSync(`${TMP}/own/.git/hooks/pre-push`, '#!/bin/sh\necho mine\n');
mkdirSync(`${REPO}/sub`); mkdirSync(`${TMP}/plain`);

const push = (args, cwd = REPO) => git(['push', '-q', 'origin', ...args], cwd);
const blocked = (r) => r.status !== 0 && /agent-kit pre-push\] blocked/.test(r.stderr);
const setup0 = init('-GitSetup', '-Target', REPO);
const cases = [
  ['미선택: 정책 없으면 훅을 설치하지 않고 설계자에게 안내', () => /PRE-PUSH: skipped \(no agentkit\.submission/.test(setup0) && /POLICY: none .*Designer/.test(setup0)
    && /GIT-EXCLUDE: added/.test(setup0) && !existsSync(hookOf(REPO))],
  ['미선택: 커밋 없는 저장소에 전체 init → 빈 baseline + 지침 복사+exclude(CLAUDE/GEMINI 중복 래퍼 미생성), 정책·훅 없음', () => {
    const F = `${TMP}/fresh2`;
    const o = init('-Target', F);
    return /GIT: baseline commit created \(main; the repository had no commits\)/.test(o) && /CREATED: (?!-)/.test(o) && /GIT-EXCLUDE: added/.test(o)
      && /PRE-PUSH: skipped \(no agentkit\.submission/.test(o) && !existsSync(hookOf(F)) && !cfg('agentkit.submission', F)
      && existsSync(`${F}/AGENTS.md`) && (!existsSync(`${F}/CLAUDE.md`) || /AGENTS-LOAD: created CLAUDE\.md/.test(o)) && !existsSync(`${F}/GEMINI.md`)
      && git(['rev-parse', '--verify', 'HEAD'], F).status === 0 && git(['ls-tree', 'HEAD'], F).stdout.trim() === ''
      && author(F) === 'agent-kit <agent-kit@local>';
  }],
  ['pr: 정책 저장 + 훅 설치 + 이전→새 값 출력', () => {
    const o = init('-GitSetup', '-Submission', 'pr', '-Target', REPO);
    return /POLICY: submission=pr \(was -\), protectedBranches=main \(was -\)/.test(o) && /PRE-PUSH: installed/.test(o)
      && cfg('agentkit.submission', REPO) === 'pr' && cfg('agentkit.protectedBranches', REPO) === 'main';
  }],
  ['pr 기본값: commit 없으면 main,master', () => /protectedBranches=main,master \(was -\)/.test(init('-GitSetup', '-Submission', 'pr', '-Target', `${TMP}/fresh`))],
  ['허용: 작업 브랜치 push', () => push(['feat']).status === 0],
  ['차단: main push', () => blocked(push(['main']))],
  ['차단: feat:main (다른 브랜치를 main으로)', () => blocked(push(['feat:main']))],
  ['차단: main 삭제', () => blocked(push(['--delete', 'main']))],
  ['차단: worktree에서 main push (훅·정책 공유)', () => { sh('git worktree add -q .worktrees/t01 -b t01', REPO); return blocked(push(['t01:main'], `${REPO}/.worktrees/t01`)); }],
  ['허용: worktree에서 작업 브랜치 push', () => push(['t01'], `${REPO}/.worktrees/t01`).status === 0],
  ['재실행: 플래그 없으면 정책 보존, already present', () => {
    const o = init('-GitSetup', '-Target', REPO);
    return /PRE-PUSH: already present/.test(o) && /POLICY: submission=pr, protectedBranches=main, base=-/.test(o) && !/\(was/.test(o) && cfg('agentkit.submission', REPO) === 'pr';
  }],
  ['갱신: CRLF로 바뀐 agent-kit 훅은 LF로 다시 씀', () => {
    const hook = hookOf(REPO);
    writeFileSync(hook, readFileSync(hook, 'utf8').replace(/\n/g, '\r\n'));
    return /PRE-PUSH: updated/.test(init('-GitSetup', '-Target', REPO)) && !readFileSync(hook, 'utf8').includes('\r');
  }],
  ['옛 이름 -ExcludeOnly도 동작', () => /PRE-PUSH: already present/.test(init('-ExcludeOnly', '-Target', REPO))],
  ['-Base 저장, 다른 값은 보존', () => /submission=pr, protectedBranches=main, base=origin\/main \(was -\)/.test(init('-GitSetup', '-Base', 'origin/main', '-Target', REPO)) && cfg('agentkit.base', REPO) === 'origin/main'],
  ['pr 기본값: origin/HEAD의 브랜치(develop)', () => /protectedBranches=develop \(was -\)/.test(init('-GitSetup', '-Submission', 'pr', '-Target', DEV))],
  ['차단: develop 보호', () => { git([...id, 'commit', '-q', '--allow-empty', '-m', 'more'], DEV); return blocked(push(['feat:develop'], DEV)); }],
  ['허용: 보호 목록에 없는 main', () => push(['main'], DEV).status === 0],
  ['direct: 기본 보호 없음', () => /submission=direct \(was -\), protectedBranches=-, /.test(init('-GitSetup', '-Submission', 'direct', '-Target', DIRECT))],
  ['허용: direct에서 main push', () => push(['main'], DIRECT).status === 0],
  ['direct + -ProtectedBranches develop만 주면 목록만 바뀜', () => {
    const o = init('-GitSetup', '-ProtectedBranches', 'develop', '-Target', DIRECT);
    return /submission=direct, protectedBranches=develop \(was -\)/.test(o) && cfg('agentkit.submission', DIRECT) === 'direct';
  }],
  ['차단: direct에서 명시한 develop', () => blocked(push(['develop'], DIRECT))],
  ['허용: direct에서 main은 여전히 허용', () => push(['feat:main'], DIRECT).status === 0],
  ['재초기화: 플래그 없으면 direct+develop 보존', () => /POLICY: submission=direct, protectedBranches=develop, base=-/.test(init('-GitSetup', '-Target', DIRECT)) && cfg('agentkit.protectedBranches', DIRECT) === 'develop'],
  ['변경: -Submission pr은 이전→새 값 출력, 목록도 다시 정함', () => /submission=pr \(was direct\), protectedBranches=main \(was develop\)/.test(init('-GitSetup', '-Submission', 'pr', '-Target', DIRECT))],
  ['차단: pr로 바꾼 뒤 main push', () => { git([...id, 'commit', '-q', '--allow-empty', '-m', 'more'], DIRECT); return blocked(push(['feat:main'], DIRECT)); }],
  ['변경: 다시 -Submission direct면 pr 기본 보호를 지움', () => /submission=direct \(was pr\), protectedBranches=- \(was main\)/.test(init('-GitSetup', '-Submission', 'direct', '-Target', DIRECT)) && !cfg('agentkit.protectedBranches', DIRECT)],
  ['허용: direct로 바꾼 뒤 main push', () => push(['feat:main'], DIRECT).status === 0],
  ['차단: direct라도 승인된 작업(approved.json)이 있으면 accepted.json 없이 main push 및 main 삭제 불가', () => {
    git([...id, 'commit', '-q', '--allow-empty', '-m', 'unaccepted direct'], DIRECT);
    mkdirSync(`${DIRECT}/handoff/T01`, { recursive: true });
    writeFileSync(`${DIRECT}/handoff/T01/approved.json`, '{"version":1}\n');
    return blocked(push(['feat:main'], DIRECT)) && blocked(push(['--delete', 'main'], DIRECT));
  }],
  ['허용: direct에서 accepted.json의 commit과 일치하면 main push 허용 (원격 미반영 상태의 추가 미수락 커밋은 차단)', () => {
    const sha = git(['rev-parse', 'feat'], DIRECT).stdout.trim();
    writeFileSync(`${DIRECT}/handoff/T01/accepted.json`, JSON.stringify({ commit: sha }) + '\n');
    git([...id, 'commit', '-q', '--allow-empty', '-m', 'extra unaccepted on feat'], DIRECT);
    const extraBlocked = blocked(push(['feat:main'], DIRECT));
    sh(`git reset -q --hard ${sha}`, DIRECT);
    return extraBlocked && push(['feat:main'], DIRECT).status === 0;
  }],
  ['허용: 완료된 작업(accepted commit이 이미 원격 main에 반영됨)만 남았을 때는 이후 일반 수동 커밋 push 허용, 새 미수락 작업(T02) 시작 시 다시 차단', () => {
    git([...id, 'commit', '-q', '--allow-empty', '-m', 'manual hotfix after T01 settled'], DIRECT);
    const manualOk = push(['feat:main'], DIRECT).status === 0;
    mkdirSync(`${DIRECT}/handoff/T02`, { recursive: true });
    writeFileSync(`${DIRECT}/handoff/T02/approved.json`, '{"version":1}\n');
    git([...id, 'commit', '-q', '--allow-empty', '-m', 'unaccepted T02'], DIRECT);
    const newTaskBlocked = blocked(push(['feat:main'], DIRECT));
    // An abandoned task is closed with verify.ps1 -Cancel (the guard blocks agents from deleting approved.json by hand).
    const cancel = spawnSync(PWSH, [...PWSH_BASE, '-File', join(KIT, 'verify.ps1'), '-Id', 'T02', '-Project', DIRECT, '-Cancel'], { encoding: 'utf8' });
    const cancelledOk = cancel.status === 0 && /cancelled/.test(cancel.stdout) && push(['feat:main'], DIRECT).status === 0;
    rmSync(`${DIRECT}/handoff`, { recursive: true, force: true });
    return manualOk && newTaskBlocked && cancelledOk;
  }],
  ['하위 폴더 저장소(-ProjectRoot): 상위 폴더의 handoff/approved.json도 direct pre-push가 검증', () => {
    const extProj = `${TMP}/ext-proj`;
    mkdirSync(`${extProj}/handoff/T99`, { recursive: true });
    writeFileSync(`${extProj}/handoff/T99/approved.json`, '{"version":1}\n');
    init('-GitSetup', '-Submission', 'direct', '-ProjectRoot', extProj, '-Target', DIRECT);
    git([...id, 'commit', '-q', '--allow-empty', '-m', 'subrepo check'], DIRECT);
    const blk = blocked(push(['feat:main'], DIRECT));
    const sha = git(['rev-parse', 'feat'], DIRECT).stdout.trim();
    writeFileSync(`${extProj}/handoff/T99/accepted.json`, JSON.stringify({ commit: sha }) + '\n');
    const ok = push(['feat:main'], DIRECT).status === 0;
    init('-GitSetup', '-ProjectRoot', '', '-Target', DIRECT);
    rmSync(extProj, { recursive: true, force: true });
    return blk && ok;
  }],
  ['local: 정책 저장', () => /submission=local \(was -\)/.test(init('-GitSetup', '-Submission', 'local', '-Target', LOCAL))],
  ['차단: local에서 작업 브랜치 push', () => blocked(push(['feat'], LOCAL))],
  ['차단: local worktree에서 push (정책 공유)', () => { sh('git worktree add -q .worktrees/t02 -b t02', LOCAL); return blocked(push(['t02'], `${LOCAL}/.worktrees/t02`)); }],
  ['옛 환경: 정책 없는 훅도 main 차단', () => blocked(push(['main'], OLD))],
  ['옛 환경: 정책 없는 훅도 master 차단', () => blocked(push(['feat:master'], OLD))],
  ['옛 환경: 작업 브랜치 push 허용', () => push(['feat'], OLD).status === 0],
  ['건너뜀: 저장소 하위 폴더 (부모 저장소 설정 안 바꿈)', () => {
    const o = init('-GitSetup', '-Submission', 'local', '-Target', `${REPO}/sub`);
    return /PRE-PUSH: skipped \(not the repository root/.test(o) && /POLICY: skipped \(not the repository root/.test(o) && cfg('agentkit.submission', REPO) === 'pr';
  }],
  ['건너뜀: Git 아님 (정상 종료, 복구 경로 안내, 아무것도 안 만듦)', () => {
    const outside = git(['rev-parse', '--show-toplevel'], `${TMP}/plain`).status !== 0;
    const r = initR('-GitSetup', '-Submission', 'pr', '-Target', `${TMP}/plain`);
    return outside && r.status === 0 && /POLICY: skipped \(not a git repository\); nothing stored.*recovery path/.test(r.stdout) && !existsSync(`${TMP}/plain/.git`);
  }],
  ['보존: core.hooksPath 사용 저장소', () => {
    const o = init('-GitSetup', '-Submission', 'pr', '-Target', `${TMP}/husky`);
    return /PRE-PUSH: skipped \(core.hooksPath/.test(o) && cfg('core.hooksPath', `${TMP}/husky`) === '.husky';
  }],
  ['보존: 기존 다른 pre-push는 덮어쓰지 않음', () => /PRE-PUSH: skipped \(an existing pre-push/.test(init('-GitSetup', '-Submission', 'pr', '-Target', `${TMP}/own`)) && readFileSync(`${TMP}/own/.git/hooks/pre-push`, 'utf8').includes('mine')],
  ['실패: 로컬 설정을 못 쓰면(config.lock) 종료 코드 1, 적용됐다고 말하지 않고 훅도 설치 안 함', () => {
    const L = `${TMP}/locked`;
    sh(`git init -q -b main "${L}"`); writeFileSync(`${L}/.git/config.lock`, '');
    const r = initR('-GitSetup', '-Submission', 'pr', '-Target', L);
    return r.status === 1 && /POLICY: FAILED to write local Git config \(agentkit\.submission/.test(r.stdout) && /submission=- \(NOT changed to pr\)/.test(r.stdout)
      && !/\(was -\)/.test(r.stdout) && /PRE-PUSH: skipped \(no agentkit\.submission/.test(r.stdout) && !existsSync(hookOf(L)) && !cfg('agentkit.submission', L);
  }],
  ['복구: 잠금을 풀고 다시 실행하면 적용(종료 코드 0)', () => {
    const L = `${TMP}/locked`; rmSync(`${L}/.git/config.lock`);
    const r = initR('-GitSetup', '-Submission', 'pr', '-Target', L);
    return r.status === 0 && /submission=pr \(was -\)/.test(r.stdout) && /PRE-PUSH: installed/.test(r.stdout);
  }],
  ['-ProtectedBranches만 주고 정책이 없으면 저장하지 않음', () => /ignored: give -Submission too/.test(init('-GitSetup', '-ProtectedBranches', 'x', '-Target', OLD)) && !cfg('agentkit.protectedBranches', OLD)],
  ['대문자 PR 입력도 소문자로 저장하고 지정 브랜치 보호', () => {
    const r = initR('-GitSetup', '-Submission', 'PR', '-ProtectedBranches', 'develop', '-Target', DEV);
    return r.status === 0 && cfg('agentkit.submission', DEV) === 'pr' && blocked(push(['feat:develop'], DEV));
  }],
  ['대문자 LOCAL 입력도 모든 push 차단', () => {
    const r = initR('-GitSetup', '-Submission', 'LOCAL', '-Target', DIRECT);
    return r.status === 0 && cfg('agentkit.submission', DIRECT) === 'local' && blocked(push(['feat'], DIRECT));
  }],
  ['수동 대문자 LOCAL 설정도 pre-push가 차단', () => {
    sh('git config --local agentkit.submission LOCAL', DIRECT);
    const ok = blocked(push(['feat'], DIRECT));
    sh('git config --local agentkit.submission local', DIRECT);
    return ok;
  }],
  ['오래된 info/exclude 블록은 최신 블록으로 갱신', () => {
    const ex = `${REPO}/.git/info/exclude`;
    writeFileSync(ex, '# >>> agent-kit\n/AGENTS.md\n# <<< agent-kit\n');
    const o = init('-GitSetup', '-Target', REPO);
    return /GIT-EXCLUDE: updated/.test(o) && readFileSync(ex, 'utf8').includes('/handoff/');
  }],
  ['worktree 폴더에 -GitSetup 없이 전체 init 실행 거부', () => {
    const r = initR('-Target', `${REPO}/.worktrees/t01`);
    return r.status === 2 && /inside \.worktrees/.test(r.stdout);
  }],
  ['호출 정책 옵션: -CrossAgentMode/-MaxVerifyFailures 저장 및 보존', () => {
    const o1 = init('-GitSetup', '-CrossAgentMode', 'manual', '-MaxVerifyFailures', '3', '-Target', REPO);
    const o2 = init('-GitSetup', '-Target', REPO);
    return /crossAgentMode=manual \(was -\), maxVerifyFailures=3 \(was -\)/.test(o1)
      && /crossAgentMode=manual, maxVerifyFailures=3/.test(o2)
      && cfg('agentkit.crossAgentMode', REPO) === 'manual' && cfg('agentkit.maxVerifyFailures', REPO) === '3';
  }],
  ['호출 정책 옵션: -MaxVerifyFailures 0(무제한) 저장 및 빈 문자열로 해제', () => {
    const o1 = init('-GitSetup', '-CrossAgentMode', '', '-MaxVerifyFailures', '0', '-Target', REPO);
    return /crossAgentMode=- \(was manual\), maxVerifyFailures=0 \(was 3\)/.test(o1)
      && !cfg('agentkit.crossAgentMode', REPO) && cfg('agentkit.maxVerifyFailures', REPO) === '0';
  }],
  ['호출 정책 옵션: 음수 MaxVerifyFailures 거부(exit 2)', () => {
    const r2 = initR('-GitSetup', '-MaxVerifyFailures', '-1', '-Target', REPO);
    return r2.status === 2 && /must be >= 0/.test(r2.stdout);
  }],
  ['새 빈 폴더에 전체 init 실행: git init(main) + baseline 커밋 + git-exclude까지 자동 완료', () => {
    const NEWDIR = `${TMP}/brandnew`;
    mkdirSync(NEWDIR);
    const r = initR('-Target', NEWDIR);
    const ex = `${NEWDIR}/.git/info/exclude`;
    const head = git(['rev-parse', '--verify', 'HEAD'], NEWDIR);
    const ignored = git(['check-ignore', 'AGENTS.md', 'agent-roles/DESIGNER.md', 'handoff/T01.md'], NEWDIR);
    const kitPosix = KIT.replace(/\\/g, '/').replace(/\/+$/, '');
    const agentsTxt = readFileSync(`${NEWDIR}/AGENTS.md`, 'utf8');
    const designerTxt = readFileSync(`${NEWDIR}/agent-roles/DESIGNER.md`, 'utf8');
    const workerTxt = readFileSync(`${NEWDIR}/agent-roles/WORKER.md`, 'utf8');
    const pathsResolved = [agentsTxt, designerTxt, workerTxt].every((t) => !t.includes('<agent-kit>') && t.includes(kitPosix));
    return r.status === 0 && /GIT: initialized \(main, baseline commit\)/.test(r.stdout) && /GIT-EXCLUDE: added/.test(r.stdout)
      && head.status === 0 && existsSync(ex) && readFileSync(ex, 'utf8').includes('/agent-roles/') && ignored.status === 0 && pathsResolved;
  }],
  ['-TrackSpec 옵션: AGENTS.md·SPEC.md·agent-roles/는 Git 추적 허용하고 handoff/만 제외', () => {
    const TSDIR = `${TMP}/trackspec-proj`;
    mkdirSync(TSDIR);
    const r = initR('-Target', TSDIR, '-TrackSpec');
    const specIgnored = git(['check-ignore', 'SPEC.md'], TSDIR).status === 0;
    const agentsIgnored = git(['check-ignore', 'AGENTS.md'], TSDIR).status === 0;
    const handoffIgnored = git(['check-ignore', 'handoff/T01.md'], TSDIR).status === 0;
    const claudeIgnored = git(['check-ignore', 'CLAUDE.md'], TSDIR).status === 0;
    return r.status === 0 && !specIgnored && !agentsIgnored && !claudeIgnored && handoffIgnored && cfg('agentkit.trackSpec', TSDIR) === 'true';
  }],
  ['상위 폴더에 CLAUDE.md가 있으면 @AGENTS.md를 가져오는 CLAUDE.md를 만들고, 가져오기 줄이 없는 기존 CLAUDE.md는 경고만 한다', () => {
    const PARENT = `${TMP}/claude-parent`;
    mkdirSync(`${PARENT}/proj-a`, { recursive: true }); mkdirSync(`${PARENT}/proj-b`, { recursive: true });
    writeFileSync(`${PARENT}/CLAUDE.md`, '# parent rules\n');
    writeFileSync(`${PARENT}/proj-b/CLAUDE.md`, '# my own rules\n');
    const a = init('-Target', `${PARENT}/proj-a`, '-NoGit');
    const b = init('-Target', `${PARENT}/proj-b`, '-NoGit');
    const madeA = /AGENTS-LOAD: created CLAUDE\.md/.test(a) && /^@AGENTS\.md\s*$/m.test(readFileSync(`${PARENT}/proj-a/CLAUDE.md`, 'utf8'));
    const keptB = /AGENTS-LOAD: WARN/.test(b) && readFileSync(`${PARENT}/proj-b/CLAUDE.md`, 'utf8') === '# my own rules\n';
    writeFileSync(`${PARENT}/proj-b/CLAUDE.md`, '@AGENTS.md\n# my own rules\n');
    const quietB = !/AGENTS-LOAD:/.test(init('-Target', `${PARENT}/proj-b`, '-NoGit'));
    return madeA && keptB && quietB;
  }],
  ['새 빈 폴더에 -NoGit으로 전체 init 실행: Git 초기화 생략', () => {
    const NOGIT = `${TMP}/nogit-init`;
    mkdirSync(NOGIT);
    const r = initR('-Target', NOGIT, '-NoGit');
    return r.status === 0 && /GIT-EXCLUDE: skipped \(not a git repository\)/.test(r.stdout) && !existsSync(`${NOGIT}/.git`);
  }],
  ['baseline 실패(서명 강제): 종료 코드 1, 성공 문구 없음, 원인 출력, 지침 파일 복사 안 함', () => {
    const S = `${TMP}/signfail`; mkdirSync(S);
    const r = initC([['commit.gpgsign', 'true'], ['gpg.program', 'agentkit-no-such-gpg']], '-Target', S);
    return r.status === 1 && /GIT: initialized \(main\) but baseline commit FAILED \((?!no output)/.test(r.stdout) && !/baseline commit\)/.test(r.stdout)
      && /NEXT: stopped before copying/.test(r.stdout) && !existsSync(`${S}/AGENTS.md`) && git(['rev-parse', '--verify', 'HEAD'], S).status !== 0;
  }],
  ['baseline 실패 뒤 원인 해소 후 재실행: baseline 생성 + 지침 복사(SKIPPED 없음)', () => {
    const S = `${TMP}/signfail`;
    const r = initR('-Target', S);
    return r.status === 0 && /GIT: baseline commit created \(main/.test(r.stdout) && /SKIPPED \(already exist\): -/.test(r.stdout)
      && existsSync(`${S}/AGENTS.md`) && git(['rev-parse', '--verify', 'HEAD'], S).status === 0;
  }],
  ['커밋 없는 저장소에 stage된 파일: 종료 코드 1, 커밋·복사 안 함, index 보존', () => {
    const D = `${TMP}/staged`;
    sh(`git init -q -b develop "${D}"`); writeFileSync(`${D}/app.txt`, 'x'); sh('git add app.txt', D);
    const r = initR('-Target', D);
    return r.status === 1 && /no commits yet and 1 staged file\(s\) on develop/.test(r.stdout) && !existsSync(`${D}/AGENTS.md`)
      && git(['rev-parse', '--verify', 'HEAD'], D).status !== 0 && git(['ls-files', '--cached'], D).stdout.trim() === 'app.txt';
  }],
  ['stage를 풀고 재실행: develop에 빈 baseline, -Base develop 안내', () => {
    const D = `${TMP}/staged`; sh('git rm -q --cached app.txt', D);
    const r = initR('-Target', D);
    return r.status === 0 && /baseline commit created \(develop; .*give -Base develop with -GitSetup/.test(r.stdout)
      && git(['rev-parse', '--abbrev-ref', 'HEAD'], D).stdout.trim() === 'develop' && git(['ls-tree', 'HEAD'], D).stdout.trim() === '';
  }],
  ['신원: 사용자 이름만 있으면 이름은 그대로, 빠진 이메일만 agent-kit으로 보충', () => {
    const P = `${TMP}/ident`; mkdirSync(P);
    const r = initC([['user.name', 'Kim']], '-Target', P);
    return r.status === 0 && author(P) === 'Kim <agent-kit@local>';
  }],
  ['읽을 수 없는 .git(손상)은 다시 git init하지 않고 종료 코드 1, 복사 안 함', () => {
    const B = `${TMP}/brokengit`; mkdirSync(B); writeFileSync(`${B}/.git`, 'gitdir: C:/agentkit-no-such-gitdir\n');
    const r = initR('-Target', B);
    return r.status === 1 && /GIT: git cannot read the repository here/.test(r.stdout) && !existsSync(`${B}/AGENTS.md`)
      && readFileSync(`${B}/.git`, 'utf8').startsWith('gitdir: C:/agentkit-no-such-gitdir');
  }],
  ['detached HEAD(커밋 있음)는 그대로 두고 진행', () => {
    const P = `${TMP}/detached`; sh(`git init -q -b main "${P}"`); git([...id, 'commit', '-q', '--allow-empty', '-m', 'c1'], P); sh('git checkout -q --detach', P);
    const r = initR('-Target', P);
    return r.status === 0 && !/GIT: /.test(r.stdout) && git(['rev-list', '--count', 'HEAD'], P).stdout.trim() === '1';
  }],
  ['재실행: 커밋 있는 저장소에는 baseline을 더 만들지 않음', () => {
    const P = `${TMP}/ident`;
    const before = git(['rev-list', '--count', 'HEAD'], P).stdout.trim();
    const r = initR('-Target', P);
    return r.status === 0 && !/GIT: /.test(r.stdout) && git(['rev-list', '--count', 'HEAD'], P).stdout.trim() === before;
  }],
  ['local-defaults 격리: AGENTKIT_DEFAULTS_FILE=off이면 한글 기본 자리표시자로 치환되고 미치환 <default-*>가 남지 않음', () => {
    const P = `${TMP}/def-off`; mkdirSync(P);
    const r = spawnSync(PWSH, [...PWSH_BASE, '-File', join(KIT, 'init.ps1'), '-Target', P, '-NoGit'],
      { encoding: 'utf8', env: { ...process.env, AGENTKIT_DEFAULTS_FILE: 'off' } });
    const ag = readFileSync(`${P}/AGENTS.md`, 'utf8');
    return r.status === 0 && !/<(agent-kit|hc-prefix|default-[a-z-]+)>/.test(ag) && ag.includes('설계자 도구·모델');
  }],
  ['local-defaults 격리: 커스텀 JSON(|·개행 정제 및 값 내부 <agent-kit> 치환)과 손상 JSON 경고 확인', () => {
    const P1 = `${TMP}/def-custom`, P2 = `${TMP}/def-bad`; mkdirSync(P1); mkdirSync(P2);
    const goodJson = `${TMP}/good-defaults.json`, badJson = `${TMP}/bad-defaults.json`;
    writeFileSync(goodJson, JSON.stringify({ designer: 'MyDesigner|v1\nline2', worker: 'Worker at <agent-kit>' }));
    writeFileSync(badJson, '{ broken json ');
    const r1 = spawnSync(PWSH, [...PWSH_BASE, '-File', join(KIT, 'init.ps1'), '-Target', P1, '-NoGit'],
      { encoding: 'utf8', env: { ...process.env, AGENTKIT_DEFAULTS_FILE: goodJson } });
    const r2 = spawnSync(PWSH, [...PWSH_BASE, '-File', join(KIT, 'init.ps1'), '-Target', P2, '-NoGit'],
      { encoding: 'utf8', env: { ...process.env, AGENTKIT_DEFAULTS_FILE: badJson } });
    const ag1 = readFileSync(`${P1}/AGENTS.md`, 'utf8');
    const kitPosix = KIT.replace(/\\/g, '/').replace(/\/+$/, '');
    return r1.status === 0 && ag1.includes('MyDesigner/v1 line2') && ag1.includes(`Worker at ${kitPosix}`) && !ag1.includes('<agent-kit>')
      && r2.status === 0 && /DEFAULTS: WARN invalid JSON/.test(r2.stdout);
  }],
  ['기존 프로젝트 재실행: 옮겨진 옛 agent-kit 절대경로 및 skills/antigravity-delegate/ 경로 자동 갱신', () => {
    const P = `${TMP}/legacy-proj`; mkdirSync(P);
    initR('-Target', P, '-NoGit');
    const wf = `${P}/agent-roles/WORKER.md`;
    const kitPosix = KIT.replace(/\\/g, '/').replace(/\/+$/, '');
    writeFileSync(wf, readFileSync(wf, 'utf8')
      .replace('/skills/agent-delegate/', '/skills/antigravity-delegate/')
      .replaceAll(kitPosix, 'D:/old-location/agent-kit'));
    const r = initR('-Target', P, '-NoGit');
    const updated = readFileSync(wf, 'utf8');
    return r.status === 0 && /UPDATED \(placeholders\/paths refreshed\): agent-roles\/WORKER\.md/.test(r.stdout)
      && updated.includes('/skills/agent-delegate/') && !updated.includes('/skills/antigravity-delegate/')
      && updated.includes(`${kitPosix}/verify.ps1`) && !updated.includes('D:/old-location/agent-kit');
  }],
  ['check-tools 훅 무결성 점검: 미치환 <agent-kit>, guard.mjs 누락, disableAllHooks 비활성화 시 WARN 출력', () => {
    const H1 = `${TMP}/home-placeholder`, H2 = `${TMP}/home-missing`, H3 = `${TMP}/home-ok`, H4 = `${TMP}/home-disabled`;
    mkdirSync(`${H1}/.codex`, { recursive: true });
    writeFileSync(`${H1}/.codex/hooks.json`, '{"command":"node <agent-kit>/hooks/guard.mjs"}');
    mkdirSync(`${H2}/.claude`, { recursive: true });
    writeFileSync(`${H2}/.claude/settings.json`, '{"hooks":{}}');
    mkdirSync(`${H3}/.codex`, { recursive: true });
    writeFileSync(`${H3}/.codex/hooks.json`, '{"command":"node /opt/agent-kit/hooks/guard.mjs"}');
    mkdirSync(`${H4}/.claude`, { recursive: true });
    writeFileSync(`${H4}/.claude/settings.json`, '{"disableAllHooks":true,"command":"node /opt/agent-kit/hooks/guard.mjs"}');
    const runChk = (h) => spawnSync(PWSH, [...PWSH_BASE, '-File', join(KIT, 'check-tools.ps1')],
      { encoding: 'utf8', env: { ...process.env, AGENTKIT_HOME: h } }).stdout;
    return /\[hooks: WARN codex hook has unresolved <agent-kit> placeholder/.test(runChk(H1))
      && /\[hooks: WARN claude config has no guard\.mjs hook registered/.test(runChk(H2))
      && !/\[hooks: WARN/.test(runChk(H3))
      && /\[hooks: WARN claude guard\.mjs hook is disabled/.test(runChk(H4));
  }],
];
let bad = 0;
for (const [name, fn] of cases) {
  let ok = false, errNote = '';
  try { ok = fn(); } catch (e) { ok = false; errNote = '\n  ' + String(e.message || e); }
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${errNote}`);
}
console.log(bad ? `${bad} FAIL` : 'ALL PASS'); process.exit(bad ? 1 : 0);
