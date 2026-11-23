// Regression test for guard.mjs. Run: node <agent-kit>/hooks/guard.test.mjs (tests the guard.mjs next to it)
// Creates a throwaway repo (main) + worktree (feat) in the temp folder to check push rules.
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'guard.mjs'); // the guard next to this test (also works in a worktree)
const TMP = mkdtempSync(join(tmpdir(), 'guardtest-'));
execSync(`git init -q -b main "${TMP}/repo" && git -C "${TMP}/repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init && git -C "${TMP}/repo" worktree add -q -b feat "${TMP}/repo-wt"`);
// Repos with a submission policy (local Git config, as init.ps1 writes it): direct (nothing protected), local (no pushes,
// with a worktree), pr protecting develop (checked out on develop).
for (const [name, cfg] of [['direct', 'agentkit.submission direct'], ['local', 'agentkit.submission local'], ['dev', 'agentkit.submission pr'], ['manual', 'agentkit.crossAgentMode manual']]) {
  execSync(`git init -q -b main "${TMP}/${name}" && git -C "${TMP}/${name}" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init && git -C "${TMP}/${name}" config ${cfg}`);
}
execSync(`git -C "${TMP}/dev" config agentkit.protectedBranches develop && git -C "${TMP}/dev" checkout -q -b develop && git -C "${TMP}/local" worktree add -q -b lw "${TMP}/local-wt"`);
process.argv[2] = TMP.split(String.fromCharCode(92)).join('/');
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });
const B = String.fromCharCode(92), R = process.argv[2];
const bash = (c, cwd) => ({ tool_name: 'Bash', tool_input: { command: c }, cwd });
const codex = (tool, c, cwd) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: c }, cwd: cwd || 'C:/p', permission_mode: 'default' });
const FLAG = ['--dangerously', 'skip', 'permissions'].join('-');
// Antigravity payload (camelCase). Expected results: DENY = exit 0 + {"decision":"deny"}, AUTO = exit 0 + {"decision":"allow"},
// ALLOW = exit 0 + empty stdout (no opinion). BLOCK = exit 2 (no hook_event_name) or, for a PreToolUse event,
// exit 0 + hookSpecificOutput.permissionDecision="deny" JSON.
const agy = (name, args, last) => ({ toolCall: { name, args }, cwd: 'C:/p', hookEventName: 'PreToolUse', workspacePaths: ['C:/p'], lastUserInput: last || 'help me' });
const REV = 'Read C:/p/handoff/sub-t01-review-1.md and follow it.';
const KITDIR = join(dirname(GUARD), '..').split(B).join('/');   // the folder guard.mjs treats as agent-kit
const HOMEDIR = homedir().split(B).join('/');
const ps = (c, cwd) => ({ tool_name: 'PowerShell', tool_input: { command: c }, cwd: cwd || 'C:/p' });
const AGYRUN = 'hc run --bg --name sub-t01-review-1 --cwd C:/p C:/Users/u/AppData/Local/agy/bin/agy.exe --model m';
const RES = 'Read C:/p/handoff/sub-t01-research-1.md and follow it.';
const cases = [
  ['BLOCK', "'--'로 감싼 hc run ... codex도 --no-daemon 누락 차단", bash("hc run --bg --name task-p-t01 '--' codex \"Read handoff/T01.md and follow it.\"")],
  ['ALLOW', "'--'로 감싼 작업자 정상 실행", bash("hc run --bg --name task-p-t01 '--' claude --model m --permission-mode auto \"Read handoff/T01.md and follow it.\"")],
  ['BLOCK', "'--'로 감싼 hc run ... claude <우회 플래그>", bash("hc run --bg --name task-p-t01 '--' claude " + FLAG + ' "Read x"')],
  ['BLOCK', 'PreToolUse 이벤트(Claude·Codex 실제 형태)의 .env 읽기는 deny JSON + exit 0', { hook_event_name: 'PreToolUse', session_id: 's', turn_id: 't', model: 'm', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'Get-Content C:/x/hooktest/.env' }, cwd: 'C:/p' }],
  ['BLOCK', 'PreToolUse 이벤트의 --no-daemon 없는 hc run codex도 deny JSON', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'hc run --bg --name x -- codex --version' }, cwd: 'C:/p' }],
  ['ALLOW', 'PreToolUse 이벤트의 통과는 stdout 없음', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: 'C:/p' }],
  ['ALLOW', '일반 요청의 검토 작업 경로 언급은 역할을 바꾸지 않음', agy('write_file', { Path: 'C:/p/src/app.js', Content: 'x' }, '앞서 handoff/sub-t01-review-1.md 지적을 반영해줘')],
  ['ALLOW', '일반 요청의 검토 경로 언급은 셸도 잠그지 않음', agy('run_command', { CommandLine: 'npm test' }, '앞서 handoff/sub-t01-review-1.md 지적을 반영해줘')],
  ['ALLOW', 'Read로 시작해도 검토 인계가 아닌 요청', agy('write_file', { Path: 'C:/p/src/app.js', Content: 'x' }, 'Read handoff/sub-t01-review-1.md and fix the implementation.')],
  ['ALLOW', 'credentials 이름의 TS 소스 검색', { tool_name: 'Glob', tool_input: { pattern: 'src/**/*credentials*.ts' } }],
  ['ALLOW', 'CredentialsForm TSX 검색', { tool_name: 'Glob', tool_input: { pattern: 'src/**/CredentialsForm.tsx' } }],
  ['ALLOW', 'credentials 소스 안 Grep', { tool_name: 'Grep', tool_input: { pattern: 'export', glob: 'src/**/*credentials*.ts' } }],
  ['BLOCK', 'credentials JSON 검색은 계속 차단', { tool_name: 'Glob', tool_input: { pattern: '**/credentials.json' } }],
  ['BLOCK', '확장자가 불명확한 credentials 검색은 계속 차단', { tool_name: 'Glob', tool_input: { pattern: '**/*credentials*' } }],
  ['ALLOW', 'Read 백슬래시 일반 파일', { tool_name: 'Read', tool_input: { file_path: ['C:', 'x', 'app.js'].join(B) } }],
  ['BLOCK', 'Read 백슬래시 .env', { tool_name: 'Read', tool_input: { file_path: ['C:', 'x', '.env'].join(B) } }],
  ['ALLOW', 'Read .env.example', { tool_name: 'Read', tool_input: { file_path: 'C:/x/.env.example' } }],
  ['BLOCK', 'Read mcp_oauth_tokens.json', { tool_name: 'Read', tool_input: { file_path: ['C:', 'Users', 'u', '.gemini', 'antigravity-cli', 'mcp_oauth_tokens.json'].join(B) } }],
  ['BLOCK', 'Grep glob mcp_oauth_tokens*', { tool_name: 'Grep', tool_input: { pattern: 'x', glob: 'mcp_oauth_tokens*' } }],
  ['BLOCK', 'cat 백슬래시 .pem', bash('cat ' + ['C:', 'Users', 'u', 'x.pem'].join(B))],
  ['BLOCK', 'cat 슬래시 .pem', bash('cat C:/Users/u/x.pem')],
  ['BLOCK', 'Get-Content .' + B + 'private.key', { tool_name: 'PowerShell', tool_input: { command: 'Get-Content .' + B + 'private.key' } }],
  ['BLOCK', 'cat server.key (VIEWERS는 경로 없는 .key도 차단)', bash('cat server.key')],
  ['ALLOW', 'node -e obj.key (오탐 방지)', bash('node -e "console.log(obj.key)"')],
  ['BLOCK', 'git -C show HEAD:.env', bash('git -C /tmp show HEAD:.env')],
  ['BLOCK', 'git --no-pager diff .env', bash('git --no-pager diff .env')],
  ['ALLOW', 'git status', bash('git status')],
  // ---- 15차: 적대적 검토(G10) 재현 사례 ----
  ['BLOCK', '& git push --no-verify origin main (PowerShell 호출 연산자)', ps('& git push --no-verify origin main', R + '/repo')],
  ['BLOCK', '& git -c core.hooksPath=x push', ps('& git -c core.hooksPath=C:/nohooks push -u origin feat', R + '/repo-wt')],
  ['BLOCK', '& "…/hc.exe" run … -- claude <우회 플래그>', ps('& "C:/x/hc.exe" run --bg --name task-t01 --cwd C:/p -- claude ' + FLAG + ' "Read handoff/T01.md and follow it."')],
  ['BLOCK', 'git push "--no-verify" (따옴표)', bash('git push "--no-verify" origin feat', R + '/repo-wt')],
  ['BLOCK', 'git push --no-verif (옵션 축약)', bash('git push --no-verif origin feat', R + '/repo-wt')],
  ['BLOCK', 'if git push --no-verify …; then', bash('if git push --no-verify origin feat; then echo ok; fi', R + '/repo-wt')],
  ['BLOCK', 'command git push --no-verify', bash('command git push --no-verify origin feat', R + '/repo-wt')],
  ['BLOCK', 'cmd /c git push --no-verify', ps('cmd /c git push --no-verify origin feat', R + '/repo-wt')],
  ['BLOCK', 'GIT_CONFIG_COUNT 환경 변수로 hooksPath', bash('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x git push origin feat', R + '/repo-wt')],
  ['BLOCK', '$env:GIT_CONFIG_COUNT = 1', ps('$env:GIT_CONFIG_COUNT = 1')],
  ['BLOCK', 'git config alias.p "push --no-verify"', bash('git config alias.p "push --no-verify"')],
  ['BLOCK', 'git send-pack', bash('git send-pack origin feat:refs/heads/main', R + '/repo-wt')],
  ['BLOCK', 'main 폴더에서 git push origin @', bash('git push origin @', R + '/repo')],
  ['ALLOW', 'git push -u origin fix/main (브랜치 이름에 main, 이전엔 오탐)', bash('git push -u origin fix/main', R + '/repo-wt')],
  ['ALLOW', 'main 폴더에서 git push --tags (이전엔 오탐)', bash('git push --tags', R + '/repo')],
  ['ALLOW', 'git push origin feat  # not main (주석, 이전엔 오탐)', bash('git push origin feat  # not main', R + '/repo-wt')],
  ['ALLOW', 'git config core.hooksPath (값 읽기, 이전엔 오탐)', bash('git config core.hooksPath')],
  ['BLOCK', 'git config core.hooksPath <값> (쓰기)', bash('git config core.hooksPath C:/nohooks')],
  // 보호 파일: Git 훅·설정, 훅 등록 파일, agent-kit
  ['BLOCK', 'rm .git/hooks/pre-push', bash('rm .git/hooks/pre-push', R + '/repo')],
  ['BLOCK', 'Write .git/hooks/pre-push', { tool_name: 'Write', tool_input: { file_path: R + '/repo/.git/hooks/pre-push', content: 'exit 0' }, cwd: 'C:/p' }],
  ['BLOCK', 'Edit .git/config', { tool_name: 'Edit', tool_input: { file_path: R + '/repo/.git/config', old_string: 'x', new_string: 'y' }, cwd: 'C:/p' }],
  ['BLOCK', 'echo > .git/hooks/pre-push (리다이렉션)', bash('echo exit 0 > .git/hooks/pre-push', R + '/repo')],
  ['BLOCK', 'Write ~/.gemini/config/hooks.json (guard 없음)', { tool_name: 'Write', tool_input: { file_path: HOMEDIR + '/.gemini/config/hooks.json', content: '{}' }, cwd: 'C:/p' }],
  ['BLOCK', '일반 프로젝트 세션: Write ~/.gemini/config/hooks.json 차단', { tool_name: 'Write', tool_input: { file_path: HOMEDIR + '/.gemini/config/hooks.json', content: '{"x":"node C:/k/hooks/guard.mjs"}' }, cwd: 'C:/p' }],
  ['ALLOW', '키트 유지보수 세션: Write ~/.gemini/config/hooks.json (guard 유지)', { tool_name: 'Write', tool_input: { file_path: HOMEDIR + '/.gemini/config/hooks.json', content: '{"x":"node C:/k/hooks/guard.mjs"}' }, cwd: KITDIR }],
  ['BLOCK', 'Edit ~/.claude/settings.json: guard 등록 줄 삭제', { tool_name: 'Edit', tool_input: { file_path: HOMEDIR + '/.claude/settings.json', old_string: '"command": "node C:/k/hooks/guard.mjs"', new_string: '' }, cwd: KITDIR }],
  ['BLOCK', '일반 프로젝트 세션: Edit ~/.claude/settings.json 권한 추가 차단(CVE-2025-53773 패턴)', { tool_name: 'Edit', tool_input: { file_path: HOMEDIR + '/.claude/settings.json', old_string: '"allow": []', new_string: '"allow": ["Bash(*)"]' }, cwd: 'C:/p' }],
  ['ALLOW', '키트 유지보수 세션: Edit ~/.claude/settings.json (guard 유지)', { tool_name: 'Edit', tool_input: { file_path: HOMEDIR + '/.claude/settings.json', old_string: '"allow": []', new_string: '"allow": ["Bash(npm test)"]' }, cwd: KITDIR }],
  ['BLOCK', '일반 프로젝트 세션: ~/.codex/rules/default.rules 수정 차단', { tool_name: 'Edit', tool_input: { file_path: HOMEDIR + '/.codex/rules/default.rules', old_string: 'a', new_string: 'b' }, cwd: 'C:/p' }],
  ['BLOCK', '일반 프로젝트 세션: ~/.codex/config.toml 수정 차단', { tool_name: 'Write', tool_input: { file_path: HOMEDIR + '/.codex/config.toml', content: 'x' }, cwd: 'C:/p' }],
  ['BLOCK', '일반 프로젝트 세션: 프로젝트 .claude/settings.local.json 수정 차단', { tool_name: 'Write', tool_input: { file_path: 'C:/p/.claude/settings.local.json', content: '{}' }, cwd: 'C:/p' }],
  ['BLOCK', '일반 프로젝트 세션: 프로젝트 .agents/hooks.json 수정 차단', { tool_name: 'Write', tool_input: { file_path: 'C:/p/.agents/hooks.json', content: '{}' }, cwd: 'C:/p' }],
  ['BLOCK', 'apply_patch: ~/.codex/hooks.json 삭제', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Delete File: ' + HOMEDIR + '/.codex/hooks.json\n*** End Patch\n' }, cwd: 'C:/p' }],
  ['BLOCK', 'Remove-Item ~/.gemini/config/hooks.json', ps('Remove-Item ' + HOMEDIR + '/.gemini/config/hooks.json')],
  ['BLOCK', 'cp agent-kit 파일 → ~/.gemini/config/hooks.json 직접 덮어쓰기 차단(isHookRestore 우회 제거)', bash('cp ' + KITDIR + '/hooks/agy-hooks.json ' + HOMEDIR + '/.gemini/config/hooks.json', KITDIR)],
  ['BLOCK', '키트 유지보수 세션에서도 미치환 <agent-kit> 경로로 훅 등록 Write 차단', { tool_name: 'Write', tool_input: { file_path: HOMEDIR + '/.gemini/config/hooks.json', content: '{"x":"node <agent-kit>/hooks/guard.mjs"}' }, cwd: KITDIR }],
  ['BLOCK', '일반 프로젝트 세션: 스킬 정션(~/.claude/skills/...) 경유 Edit 차단', { tool_name: 'Edit', tool_input: { file_path: HOMEDIR + '/.claude/skills/agent-delegate/SKILL.md', old_string: 'a', new_string: 'b' }, cwd: 'C:/p' }],
  ['BLOCK', '일반 프로젝트 세션: Codex 스킬 정션(~/.agents/skills/...) 경유 Write 차단', { tool_name: 'Write', tool_input: { file_path: HOMEDIR + '/.agents/skills/agent-kit-start/SKILL.md', content: 'x' }, cwd: 'C:/p' }],
  ['BLOCK', '작업자 세션: 키트 폴더 안에서도 local-defaults.json 수정 차단', { tool_name: 'Write', tool_input: { file_path: KITDIR + '/local-defaults.json', content: '{}' }, cwd: KITDIR }, 'local-defaults.json', 'worker-caller'],
  ['BLOCK', '작업자 세션: 키트 폴더 안에서도 전역 ~/.claude/settings.json 수정 차단', { tool_name: 'Edit', tool_input: { file_path: HOMEDIR + '/.claude/settings.json', old_string: 'a', new_string: 'b' }, cwd: KITDIR }, '권한 설정', 'worker-caller'],
  ['BLOCK', '일반 프로젝트 세션: agent-kit 파일 Edit 차단', { tool_name: 'Edit', tool_input: { file_path: KITDIR + '/hooks/guard.mjs', old_string: 'a', new_string: 'b' }, cwd: 'C:/p' }],
  ['ALLOW', '키트 유지보수 세션: agent-kit 파일 Edit 허용', { tool_name: 'Edit', tool_input: { file_path: KITDIR + '/hooks/guard.mjs', old_string: 'a', new_string: 'b' }, cwd: KITDIR }],
  ['ALLOW', '프로젝트 세션이 agent-kit 파일 Read', { tool_name: 'Read', tool_input: { file_path: KITDIR + '/RUNBOOK.md' }, cwd: 'C:/p' }],
  ['BLOCK', 'hc run --parent (부모 바꾸기)', bash('hc run --bg --parent t9 --name x -- claude "hi"')],
  // 권한 우회 플래그 변형
  ['BLOCK', '--permission-mode "bypassPermissions" (따옴표)', bash('claude --permission-mode "bypassPermissions"')],
  ['BLOCK', '--allow-' + FLAG.slice(2), bash('claude --allow-' + FLAG.slice(2))],
  ['BLOCK', 'codex --dangerously-bypass-hook-trust', bash('codex --dangerously-bypass-hook-trust')],
  ['BLOCK', 'npm exec -- claude <우회 플래그>', bash('npm exec -- claude ' + FLAG)],
  ['ALLOW', 'claude --permission-mode auto (작업자 정상 실행)', bash('hc run --bg --name task-t01 --cwd C:/p -- claude --model m --permission-mode auto "Read handoff/T01.md and follow it."')],
  // AGY direct hc run / mode / task-file rules (no forced single-turn lock)
  ['ALLOW', '검토 세션 직접 실행(plan + 자기 작업 파일)', bash(AGYRUN + ' --mode plan --sandbox -i "Read C:/p/handoff/sub-t01-review-1.md and follow it."')],
  ['ALLOW', '조사 세션 직접 실행(plan + 자기 작업 파일)', bash('hc run --bg --name sub-t01-research-1 --cwd C:/p agy.exe --model m --mode plan --sandbox -i "Read C:/p/handoff/sub-t01-research-1.md and follow it."')],
  ['ALLOW', 'agy 작업자 --mode auto 직접 실행 허용', bash('hc run --bg --name task-t01 --cwd C:/p -- agy.exe --model m --mode auto --sandbox -i "Read handoff/T01.md and follow it."')],
  ['BLOCK', '수동 인계 저장소에서 AGY 작업자 실행 차단', bash('hc run --bg --name task-demo-t01 --cwd C:/p -- agy.exe --mode auto -i "Read handoff/T01.md and follow it."', R + '/manual')],
  ['BLOCK', '검토 세션을 plan 없이 실행', bash(AGYRUN + ' --sandbox -i "Read C:/p/handoff/sub-t01-review-1.md and follow it."')],
  ['BLOCK', '검토 세션 시작 문장에 자기 작업 파일이 없음', bash(AGYRUN + ' --mode plan --sandbox -i "Review the changes."')],
  ['BLOCK', 'agy --mode auto (조사 세션)', bash('hc run --bg --name sub-t01-research-1 --cwd C:/p agy.exe --mode auto -i "Read C:/p/handoff/sub-t01-research-1.md and follow it."')],
  ['BLOCK', '이름 없는 agy --mode auto', bash('agy.exe --mode auto -i "do it"')],
  ['BLOCK', '조사 세션을 모드 없이 실행(auto 모드로 돈다, 17차)', bash('hc run --bg --name sub-t01-research-1 --cwd C:/p agy.exe --model m --sandbox -i "Read C:/p/handoff/sub-t01-research-1.md and follow it."')],
  ['BLOCK', '조사 세션을 accept-edits로 실행', bash('hc run --bg --name sub-t01-research-1 --cwd C:/p agy.exe --model m --mode accept-edits --sandbox -i "Read C:/p/handoff/sub-t01-research-1.md and follow it."')],
  ['ALLOW', '직접 AGY 도움말 출력은 허용', ps('agy --help')],
  ['ALLOW', '인용된 AGY 예시를 실행으로 보지 않음', ps('Write-Output "Policy FAQ (agy requires human input); agy --mode plan"')],
  ['ALLOW', 'PowerShell here-string 속 AGY 예시는 허용', ps("Write-Output @'\nUsage: it's a command example.\nagy --mode auto\n'@")],
  ['ALLOW', 'PowerShell 래퍼의 문자열 속 AGY를 실행으로 보지 않음', ps('powershell -Command "Write-Output C:/docs/agy.exe"')],
  ['ALLOW', 'Codex 프롬프트에 인용된 AGY 명령은 허용', bash('hc run --bg --no-notify --name task-t01 -- codex --no-daemon "Review output (agy --mode auto) and report."')],
  ['ALLOW', 'Claude 프롬프트 내의 AGY 명령은 허용', bash('hc run --bg --no-notify --name task-t02 -- claude "Review AGY logs; agy --mode plan is mentioned."')],
  // 비밀 파일 이름·읽기 명령
  ['BLOCK', 'Read .env.production.local', { tool_name: 'Read', tool_input: { file_path: 'C:/p/.env.production.local' } }],
  ['BLOCK', 'Read ~/.aws/credentials', { tool_name: 'Read', tool_input: { file_path: 'C:/Users/u/.aws/credentials' } }],
  ['BLOCK', 'Read .git-credentials', { tool_name: 'Read', tool_input: { file_path: 'C:/Users/u/.git-credentials' } }],
  ['ALLOW', 'Read .env.d.ts (소스 파일)', { tool_name: 'Read', tool_input: { file_path: 'C:/p/src/.env.d.ts' } }],
  ['BLOCK', 'Write-Output (Get-Content .env) (괄호)', ps('Write-Output (Get-Content C:/x/.env)')],
  ['BLOCK', 'foreach ($l in (gc .env))', ps('foreach ($l in (gc C:/x/.env)) { $l }')],
  ['BLOCK', '백틱 치환 안의 cat .env', bash('echo ' + String.fromCharCode(96) + 'cat C:/x/.env' + String.fromCharCode(96))],
  ['BLOCK', 'done < .env (입력 리다이렉션)', bash('while read l; do echo $l; done < C:/x/.env')],
  ['BLOCK', 'Select-String -Path .env KEY (경로가 검색어로 지워지던 오판)', ps('Select-String -Path C:/x/.env KEY')],
  ['BLOCK', 'findstr /c:KEY .env', ps('findstr /c:KEY C:/x/.env')],
  ['BLOCK', 'hc file read .env', bash('hc file read C:/x/.env')],
  ['BLOCK', 'hc exec cat .env', bash('hc exec cat C:/x/.env')],
  ['BLOCK', 'env X=1 cat .env', bash('env X=1 cat C:/x/.env')],
  ['BLOCK', 'git log -p -- .env', bash('git log -p -- C:/x/.env')],
  ['BLOCK', 'mv .env x.txt', bash('mv C:/x/.env C:/x/x.txt')],
  ['ALLOW', 'cp .env.example .env (템플릿을 .env로 복사)', bash('cp .env.example .env')],
  ['BLOCK', 'cp .env .env.bak (원본이 .env면 계속 차단)', bash('cp C:/x/.env C:/x/.env.bak')],
  ['BLOCK', '공백 경로 git -C "..." push --no-verify 차단', bash('git -C "C:/My Projects/repo" push --no-verify origin feat')],
  ['BLOCK', '공백 옵션 git -c user.name="John Doe" push origin main 차단', bash('git -c user.name="John Doe" push origin main', R + '/repo-wt')],
  ['ALLOW', 'Glob **/*.env.ts (소스 파일)', { tool_name: 'Glob', tool_input: { pattern: '**/*.env.ts' } }],
  ['ALLOW', 'node --env-file=.env server.js (이전엔 오탐)', bash('node --env-file=.env server.js')],
  ['ALLOW', 'curl --cacert certs/ca.pem (이전엔 오탐)', bash('curl --cacert certs/ca.pem https://localhost')],
  ['ALLOW', 'Glob src/**/*.key.ts (이전엔 오탐)', { tool_name: 'Glob', tool_input: { pattern: 'src/**/*.key.ts' } }],
  ['ALLOW', 'Grep glob *.env.d.ts (이전엔 오탐)', { tool_name: 'Grep', tool_input: { pattern: 'x', glob: '*.env.d.ts' } }],
  ['BLOCK', 'Glob **/.env.local (여전히 차단)', { tool_name: 'Glob', tool_input: { pattern: '**/.env.local' } }],
  // Antigravity 세션 범위
  ['DENY', '검토 세션: 경로에 공백이 있어도 셸 차단', agy('run_command', { CommandLine: 'dir' }, 'Read "C:/My Projects/app/handoff/sub-t01-review-1.md" and follow it.')],
  ['DENY', '검토 세션: 문장을 바꿔 써도 셸 차단', agy('run_command', { CommandLine: 'dir' }, 'handoff/sub-t01-review-1.md를 다시 읽고 따라')],
  ['DENY', 'stem에 -review-가 있으면 검토(sub-x-review-1-research-2)', agy('run_command', { CommandLine: 'dir' }, 'Read C:/p/handoff/sub-x-review-1-research-2.md and follow it.')],
  ['AUTO', '검토 세션: 공백 경로의 자기 보고 파일 자동 허용', agy('write_file', { Path: 'C:/My Projects/app/handoff/sub-t01-review-1-report.md', Content: 'x' }, 'Read "C:/My Projects/app/handoff/sub-t01-review-1.md" and follow it.')],
  ['ALLOW', '검토 세션: 문장이 맨 앞이 아니면 자기 보고 파일은 평소 승인(자동 허용 아님)', agy('write_file', { Path: 'C:/p/handoff/sub-t01-review-1-report.md', Content: 'x' }, 'please redo: Read C:/p/handoff/sub-t01-review-1.md and follow it.')],
  ['DENY', '조사 세션: 다른 인계 파일 쓰기', agy('write_file', { Path: 'C:/p/handoff/T01.md', Content: 'x' }, RES)],
  ['DENY', '조사 세션: verify 증거 파일 쓰기', agy('write_file', { Path: 'C:/p/handoff/T01/verify/summary.txt', Content: 'x' }, RES)],
  ['ALLOW', '조사 세션: handoff 밖 쓰기는 평소 승인 규칙', agy('write_file', { Path: 'C:/p/notes.txt', Content: 'x' }, RES)],
  ['BLOCK', 'PowerShell if 블록 안의 Get-Content .env (13차)', { tool_name: 'PowerShell', tool_input: { command: 'if ($true) { Get-Content C:/x/.env }' } }],
  ['BLOCK', 'PowerShell 공백 없는 블록 if($true){gc C:/x/.env}', { tool_name: 'PowerShell', tool_input: { command: 'if($true){gc C:/x/.env}' } }],
  ['BLOCK', 'try 블록 안의 git push --no-verify', { tool_name: 'PowerShell', tool_input: { command: 'try { git push --no-verify origin feat }' }, cwd: R + '/repo-wt' }],
  ['BLOCK', 'bash if ... then cat .env', bash('if true; then cat C:/x/.env; fi')],
  ['BLOCK', 'echo $(cat .env)', bash('echo $(cat C:/x/.env)')],
  ['BLOCK', 'cat ${HOME}/.env (변수 중괄호는 나누지 않음)', bash('cat ${HOME}/.env')],
  ['ALLOW', 'if 블록 안의 일반 명령', { tool_name: 'PowerShell', tool_input: { command: 'if (Test-Path x) { Get-Content C:/x/app.js }' } }],
  ['ALLOW', 'feat worktree에서 try 블록 push', { tool_name: 'PowerShell', tool_input: { command: 'try { git push -u origin feat }' }, cwd: R + '/repo-wt' }],
  ['BLOCK', 'main 폴더에서 push', bash('git push', R + '/repo')],
  ['BLOCK', 'push origin main', bash('git push origin main', R + '/repo-wt')],
  ['ALLOW', 'feat worktree에서 push', bash('git push -u origin feat', R + '/repo-wt')],
  ['ALLOW', 'main 폴더에서 git -C <feat worktree> push (이전엔 오탐)', bash('git -C ' + R + '/repo-wt push -u origin feat', R + '/repo')],
  ['BLOCK', 'feat 폴더에서 git -C <main repo> push', bash('git -C ' + R + '/repo push', R + '/repo-wt')],
  ['BLOCK', '권한 우회 플래그', bash('claude ' + FLAG)],
  ['BLOCK', 'Read 테스트 계정 JSON', { tool_name: 'Read', tool_input: { file_path: 'C:/p/.t07-local-test-accounts.json' } }],
  ['BLOCK', 'Edit 테스트 계정 JSON', { tool_name: 'Edit', tool_input: { file_path: 'C:/p/handoff/T01/test_accounts.json' } }],
  ['ALLOW', 'Write 테스트 계정 JSON (생성은 허용)', { tool_name: 'Write', tool_input: { file_path: 'C:/p/handoff/T01/test_accounts.json' } }],
  ['BLOCK', 'Read 백슬래시 cookie.txt', { tool_name: 'Read', tool_input: { file_path: ['C:', 'Users', 'u', 'cookie.txt'].join(B) } }],
  ['BLOCK', 'Read 접두사 붙은 user_cookies.txt', { tool_name: 'Read', tool_input: { file_path: 'C:/p/handoff/T01/user_cookies.txt' } }],
  ['BLOCK', 'cat storageState.json', bash('cat handoff/T01/storageState.json')],
  ['BLOCK', 'Get-Content test-accounts.json', { tool_name: 'PowerShell', tool_input: { command: 'Get-Content handoff/T01/test-accounts.json' } }],
  ['BLOCK', 'Grep glob **/cookies.txt', { tool_name: 'Grep', tool_input: { pattern: 'x', glob: '**/cookies.txt' } }],
  ['ALLOW', 'curl -b cookies.txt (테스트 도구 인자)', bash('curl -b handoff/T01/cookies.txt -c handoff/T01/cookies.txt http://localhost:3000/api/me')],
  ['ALLOW', 'node 테스트에 storageState 전달', bash('node tests/auth.mjs handoff/T01/storageState.json')],
  ['ALLOW', 'Read 테스트 코드 test_accounts.py', { tool_name: 'Read', tool_input: { file_path: 'C:/p/tests/test_accounts.py' } }],
  ['ALLOW', 'Read cookie_utils.js', { tool_name: 'Read', tool_input: { file_path: 'C:/p/src/cookie_utils.js' } }],
  ['ALLOW', 'Glob 테스트 소스 **/test_accounts*.py', { tool_name: 'Glob', tool_input: { pattern: '**/test_accounts*.py' } }],
  ['ALLOW', 'Grep glob *storage_state*.ts', { tool_name: 'Grep', tool_input: { pattern: 'x', glob: '*storage_state*.ts' } }],
  // test-account names: "test" must start a word (A01)
  ['ALLOW', 'Read latest-accounts.json (부분 일치 오탐 해소)', { tool_name: 'Read', tool_input: { file_path: 'C:/p/data/latest-accounts.json' } }],
  ['ALLOW', 'Read contest_account.json (부분 일치 오탐 해소)', { tool_name: 'Read', tool_input: { file_path: 'C:/p/data/contest_account.json' } }],
  ['ALLOW', 'Glob **/latest-accounts.json', { tool_name: 'Glob', tool_input: { pattern: '**/latest-accounts.json' } }],
  ['ALLOW', 'Grep glob contest_account*.json', { tool_name: 'Grep', tool_input: { pattern: 'x', glob: 'contest_account*.json' } }],
  ['ALLOW', 'Grep path latest-accounts.json', { tool_name: 'Grep', tool_input: { pattern: 'x', path: 'C:/p/data/latest-accounts.json' } }],
  ['ALLOW', 'cat latest-accounts.json', bash('cat data/latest-accounts.json')],
  ['ALLOW', 'Get-Content contest_account.json', ps('Get-Content data/contest_account.json')],
  ['BLOCK', 'Read test-accounts.json (계속 차단)', { tool_name: 'Read', tool_input: { file_path: 'C:/p/test-accounts.json' } }],
  ['BLOCK', 'Read project-test-accounts.json (계속 차단)', { tool_name: 'Read', tool_input: { file_path: 'C:/p/project-test-accounts.json' } }],
  ['BLOCK', 'Read test_accounts.dev.json (계속 차단)', { tool_name: 'Read', tool_input: { file_path: 'C:/p/test_accounts.dev.json' } }],
  ['BLOCK', 'Read TestAccounts.json (대소문자)', { tool_name: 'Read', tool_input: { file_path: 'C:/p/TestAccounts.json' } }],
  ['BLOCK', 'Glob **/*test-accounts*.json (계속 차단)', { tool_name: 'Glob', tool_input: { pattern: '**/*test-accounts*.json' } }],
  ['BLOCK', 'Grep glob project-test-accounts.json (계속 차단)', { tool_name: 'Grep', tool_input: { pattern: 'x', glob: 'project-test-accounts.json' } }],
  ['BLOCK', 'cat test_accounts.dev.json (계속 차단)', bash('cat handoff/T01/test_accounts.dev.json')],
  // submission policy (B03): same local Git config as the pre-push hook
  ['ALLOW', 'direct: main 폴더에서 git push', bash('git push', R + '/direct')],
  ['ALLOW', 'direct: git push origin main', bash('git push origin main', R + '/direct')],
  ['BLOCK', 'direct: --no-verify는 계속 차단', bash('git push --no-verify origin main', R + '/direct')],
  ['BLOCK', 'local: 작업 브랜치 push도 차단', bash('git push -u origin feat', R + '/local')],
  ['BLOCK', 'local: worktree에서 push(정책 공유)', bash('git push -u origin lw', R + '/local-wt')],
  ['BLOCK', 'local: git push --tags도 차단', bash('git push --tags', R + '/local')],
  ['BLOCK', 'pr+develop: git push origin develop', bash('git push origin develop', R + '/dev')],
  ['BLOCK', 'pr+develop: feat:develop', bash('git push origin feat:develop', R + '/dev')],
  ['BLOCK', 'pr+develop: develop 브랜치에서 git push', bash('git push', R + '/dev')],
  ['ALLOW', 'pr+develop: develop에서 다른 브랜치로 명시 push', bash('git push origin develop:feat', R + '/dev')],
  ['ALLOW', 'pr+develop: 보호 목록에 없는 main', bash('git push origin feat:main', R + '/dev')],
  ['ALLOW', 'git -C <direct> push origin main (정책 없는 폴더에서)', bash('git -C ' + R + '/direct push origin main', R + '/repo-wt')],
  ['BLOCK', 'git -C <local> push (direct 폴더에서)', bash('git -C ' + R + '/local push origin feat', R + '/direct')],
  ['BLOCK', 'git -C <정책 없는 main 저장소> push origin main (direct 폴더에서)', bash('git -C ' + R + '/repo push origin main', R + '/direct')],
  ['BLOCK', '저장소 밖 폴더: push origin master (옛 기본값)', bash('git push origin master', 'C:/p')],
  ['BLOCK', '전역 설정 submission=direct는 쓰지 않음: 정책 없는 저장소의 main push', bash('git push origin main', R + '/repo')],
  // pre-push hook must not be skipped
  ['BLOCK', 'git push --no-verify', bash('git push --no-verify -u origin feat', R + '/repo-wt')],
  ['BLOCK', 'git -c core.hooksPath=x push', bash('git -c core.hooksPath=/dev/null push -u origin feat', R + '/repo-wt')],
  ['BLOCK', 'git config core.hooksPath', bash('git config core.hooksPath .nohooks')],
  ['ALLOW', 'git push -u origin feat (기존 허용 유지)', bash('git push -u origin feat', R + '/repo-wt')],
  // Codex payloads (tool_name Bash / apply_patch, tool_input.command, cwd)
  ['BLOCK', 'Codex Bash: Get-Content .env', codex('Bash', 'Get-Content C:/p/.env')],
  ['BLOCK', 'Codex Bash: push origin main', codex('Bash', 'git push origin main', R + '/repo-wt')],
  ['BLOCK', 'Codex Bash: main 폴더에서 push', codex('Bash', 'git push', R + '/repo')],
  ['ALLOW', 'Codex Bash: 작업 브랜치 push', codex('Bash', 'git push -u origin feat', R + '/repo-wt')],
  ['BLOCK', 'Codex Bash: 권한 우회 플래그', codex('Bash', 'codex exec --dangerously-bypass-approvals-and-sandbox x')],
  ['BLOCK', 'Codex Bash: cat cookies.txt', codex('Bash', 'cat handoff/T01/cookies.txt')],
  ['ALLOW', 'Codex Bash: curl -b cookies.txt', codex('Bash', 'curl -b handoff/T01/cookies.txt http://localhost:3000/api/me')],
  ['BLOCK', 'Codex apply_patch: .env 수정', codex('apply_patch', '*** Begin Patch\n*** Update File: C:/p/.env\n@@\n-A=1\n+A=2\n*** End Patch\n')],
  ['BLOCK', 'Codex apply_patch: 키 파일 추가', codex('apply_patch', '*** Begin Patch\n*** Add File: C:/p/certs/server.pem\n+x\n*** End Patch\n')],
  ['BLOCK', 'Codex apply_patch: 테스트 계정 수정', codex('apply_patch', '*** Begin Patch\n*** Update File: handoff/T01/test-accounts.json\n@@\n-a\n+b\n*** End Patch\n')],
  ['ALLOW', 'Codex apply_patch: 테스트 계정 새로 만들기', codex('apply_patch', '*** Begin Patch\n*** Add File: handoff/T01/test-accounts.json\n+{}\n*** End Patch\n')],
  ['ALLOW', 'Codex apply_patch: 일반 소스 수정', codex('apply_patch', '*** Begin Patch\n*** Update File: src/app.js\n@@\n-a\n+b\n*** End Patch\n')],
  ['BLOCK', 'Codex Edit 별칭 + 패치 본문: .env 수정', codex('Edit', '*** Begin Patch\n*** Update File: .env\n@@\n-a\n+b\n*** End Patch\n')],
  // bypass flags count only when an agent/process is launched with them
  ['BLOCK', 'hc run ... -- claude <우회 플래그>', bash('hc run --bg --name task-t01 --cwd C:/p -- claude ' + FLAG + ' "Read handoff/T01.md"')],
  ['BLOCK', 'hc run --no-parent', bash('hc run --bg --no-parent --name x -- claude "hi"')],
  ['BLOCK', 'PowerShell & "agy.exe" <우회 플래그>', { tool_name: 'PowerShell', tool_input: { command: '& "C:/Users/u/AppData/Local/agy/bin/agy.exe" ' + FLAG } }],
  ['BLOCK', 'npx claude-code <우회 플래그>', bash('npx @anthropic-ai/claude-code ' + FLAG)],
  ['BLOCK', 'Start-Process codex 우회', { tool_name: 'PowerShell', tool_input: { command: "Start-Process codex -ArgumentList '--dangerously-bypass-approvals-and-sandbox'" } }],
  ['ALLOW', 'git commit -m 에 플래그 이름 언급(오탐 해소)', bash('git commit -m "docs: ' + FLAG + ' 금지 규칙"')],
  ['ALLOW', 'hc send 메시지에 플래그 이름 언급(오탐 해소)', bash('hc send task-t01 "' + FLAG + ' 쓰지 마"')],
  ['ALLOW', 'heredoc 본문 줄에 플래그 이름(오탐 해소)', bash("cat > handoff/x.md <<'EOF'\n- 금지: " + FLAG + "\nEOF")],
  // core.hooksPath: only writing it is blocked
  ['ALLOW', 'git commit -m 에 core.hooksPath 언급', bash('git commit -m "pre-push: core.hooksPath 저장소는 건너뜀"')],
  ['ALLOW', 'git config --get core.hooksPath', bash('git config --get core.hooksPath')],
  ['ALLOW', 'git config --unset core.hooksPath', bash('git config --unset core.hooksPath')],
  ['ALLOW', 'git grep core.hooksPath', bash('git grep core.hooksPath')],
  ['BLOCK', 'git --git-dir <d> push --no-verify', bash('git --git-dir C:/p/.git push --no-verify -u origin feat')],
  // search patterns are text, file arguments are still checked
  ['ALLOW', 'Codex rg "cookies.txt" src/ (검색어)', codex('Bash', 'rg "cookies.txt" src/')],
  ['ALLOW', 'Select-String -Pattern ".env" (검색어)', codex('Bash', 'Select-String -Path src/*.ts -Pattern ".env"')],
  ['BLOCK', 'Select-String -Path .env (파일)', codex('Bash', 'Select-String -Path C:/p/.env -Pattern KEY')],
  ['BLOCK', 'grep KEY .env (파일)', bash('grep KEY C:/p/.env')],
  ['BLOCK', '(Get-Content .env) 괄호 시작', codex('Bash', '(Get-Content C:/p/.env).Length')],
  // unexpected Codex input shapes are still checked (G04)
  ['BLOCK', 'shell 도구 + argv 배열', { tool_name: 'shell', tool_input: { command: ['powershell.exe', '-Command', 'Get-Content C:/p/.env'] }, cwd: 'C:/p' }],
  ['BLOCK', 'Bash + cmd 필드', { tool_name: 'Bash', tool_input: { cmd: 'cat C:/p/.env' }, cwd: 'C:/p' }],
  ['BLOCK', 'exec_command + cmd 문자열', { tool_name: 'exec_command', tool_input: { cmd: 'git push origin main' }, cwd: 'C:/p' }],
  ['BLOCK', '알 수 없는 도구 + command 필드', { tool_name: 'run_terminal', tool_input: { command: 'type C:/p/.env' }, cwd: 'C:/p' }],
  ['ALLOW', 'command 없는 MCP 도구', { tool_name: 'mcp__notion__search', tool_input: { query: '.env' }, cwd: 'C:/p' }],
  // leading assignments
  ['BLOCK', '$x = Get-Content .env', codex('Bash', '$x = Get-Content C:/p/.env')],
  ['BLOCK', '$x=Get-Content .env', codex('Bash', '$x=Get-Content C:/p/.env')],
  ['BLOCK', 'FOO=1 cat .env', bash('FOO=1 cat C:/p/.env')],
  // Codex bypass options
  ['BLOCK', 'codex -s danger-full-access', bash('codex -s danger-full-access "do it"')],
  ['BLOCK', 'codex exec -a never', bash('codex exec -a never "do it"')],
  ['BLOCK', 'hc run -- codex --sandbox danger-full-access', bash('hc run --bg --name task-t01 -- codex --no-daemon --sandbox danger-full-access "x"')],
  ['BLOCK', 'codex -c approval_policy=never', bash('codex -c approval_policy=never "x"')],
  ['BLOCK', 'codex --yolo', bash('codex --yolo "x"')],
  ['ALLOW', 'codex -s workspace-write -a on-request', bash('codex --no-daemon -s workspace-write -a on-request "x"')],
  ['ALLOW', 'git commit -s (sign-off)', bash('git commit -s -m "x"')],
  // argv arrays: only a shell's own -c/-Command marks the command (Argon G04 item 1)
  ['BLOCK', '배열 git -C <main 저장소> push', { tool_name: 'shell', tool_input: { command: ['git', '-C', R + '/repo', 'push'] }, cwd: R + '/repo-wt' }],
  ['BLOCK', '배열 git -c core.hooksPath=x push', { tool_name: 'shell', tool_input: { command: ['git', '-c', 'core.hooksPath=/dev/null', 'push', '-u', 'origin', 'feat'] }, cwd: R + '/repo-wt' }],
  ['BLOCK', '배열 codex -c approval_policy=never', { tool_name: 'shell', tool_input: { command: ['codex', '-c', 'approval_policy=never', 'do it'] }, cwd: 'C:/p' }],
  ['BLOCK', '배열 bash -lc "cat .env"', { tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'cat C:/p/.env'] }, cwd: 'C:/p' }],
  ['BLOCK', '배열 cmd /c type .env', { tool_name: 'shell', tool_input: { command: ['cmd.exe', '/c', 'type', 'C:/p/.env'] }, cwd: 'C:/p' }],
  ['ALLOW', '배열 powershell -File script.ps1 -c arg', { tool_name: 'shell', tool_input: { command: ['powershell.exe', '-File', 'script.ps1', '-c', 'arg'] }, cwd: 'C:/p' }],
  // assignments (item 2)
  ['BLOCK', '$x= Get-Content .env (= 뒤 공백)', codex('Bash', '$x= Get-Content C:/p/.env')],
  ['BLOCK', '$a = $b = Get-Content .env (연속 대입)', codex('Bash', '$a = $b = Get-Content C:/p/.env')],
  // Antigravity (11차): same rules, decision JSON on stdout, exit 0
  ['DENY', 'agy read_file .env', agy('read_file', { Path: 'C:/p/.env' })],
  ['ALLOW', 'agy read_file 일반 소스(출력 없음)', agy('read_file', { Path: 'C:/p/src/app.js' })],
  ['DENY', 'agy write_file .env', agy('write_file', { Path: 'C:/p/.env', Content: 'x' })],
  ['DENY', 'agy edit_file 테스트 계정', agy('edit_file', { Path: 'C:/p/handoff/T01/test-accounts.json', Target: 'a', Replacement: 'b' })],
  ['DENY', 'agy run_command Get-Content .env', agy('run_command', { CommandLine: 'Get-Content C:/p/.env' })],
  ['DENY', 'agy run_command push origin main', agy('run_command', { CommandLine: 'git push origin main' })],
  ['DENY', 'agy run_command 우회 플래그로 claude 실행', agy('run_command', { CommandLine: 'claude ' + FLAG })],
  ['ALLOW', 'agy run_command npm test(일반 세션)', agy('run_command', { CommandLine: 'npm test' })],
  ['ALLOW', 'agy 브라우저 등 그 밖의 도구', agy('browser_click', { Selector: '#a' })],
  // Antigravity review sub-session: own report auto-approved, read tools pass, everything else is denied
  ['AUTO', '검토 세션: 자기 보고 파일 쓰기 자동 허용', agy('write_file', { Path: 'C:/p/handoff/sub-t01-review-1-report.md', Content: 'r' }, REV)],
  ['AUTO', '검토 세션: 백슬래시 경로의 자기 보고 파일', agy('write_file', { Path: 'C:\\p\\handoff\\sub-t01-review-1-report.md', Content: 'r' }, REV)],
  ['AUTO', '검토 세션: 자기 폴더 안 파일', agy('edit_file', { Path: 'C:/p/handoff/sub-t01-review-1/notes.md', Target: 'a', Replacement: 'b' }, REV)],
  ['DENY', '검토 세션: 소스 파일 쓰기', agy('write_file', { Path: 'C:/p/src/app.js', Content: 'x' }, REV)],
  ['DENY', '검토 세션: 다른 실행의 보고 파일', agy('write_file', { Path: 'C:/p/handoff/sub-t01-review-2-report.md', Content: 'x' }, REV)],
  ['DENY', '검토 세션: 셸 명령', agy('run_command', { CommandLine: 'npm test' }, REV)],
  ['ALLOW', '검토 세션: 읽기는 평소대로', agy('read_file', { Path: 'C:/p/src/app.js' }, REV)],
  ['DENY', '검토 세션: 비밀 파일 읽기는 여전히 차단', agy('read_file', { Path: 'C:/p/.env' }, REV)],
  // research sub-session: own report auto-approved, other writes/commands follow normal approval
  ['AUTO', '조사 세션: 자기 보고 파일 자동 허용', agy('write_file', { Path: 'C:/p/handoff/sub-t01-research-1-report.md', Content: 'r' }, RES)],
  ['ALLOW', '조사 세션: 다른 쓰기는 평소 승인 규칙', agy('write_file', { Path: 'C:/p/notes.md', Content: 'x' }, RES)],
  ['ALLOW', '조사 세션: 셸 명령은 평소 승인 규칙', agy('run_command', { CommandLine: 'npm test' }, RES)],
  // Argon G06-2 지적 1(높음): 경로 조작·비밀 파일·상대 경로 첫 문장
  ['DENY', '검토 세션: 자기 폴더/../../ 로 소스 쓰기', agy('write_file', { Path: 'C:/p/handoff/sub-t01-review-1/../../src/app.js', Content: 'x' }, REV)],
  ['DENY', '검토 세션: 자기 폴더/../../.env', agy('write_file', { Path: 'C:/p/handoff/sub-t01-review-1/../../.env', Content: 'x' }, REV)],
  ['DENY', '검토 세션: 자기 폴더 안 .env는 비밀 검사가 먼저', agy('write_file', { Path: 'C:/p/handoff/sub-t01-review-1/.env', Content: 'x' }, REV)],
  ['DENY', '조사 세션: 자기 폴더 안 쿠키 파일 편집', agy('edit_file', { Path: 'C:/p/handoff/sub-t01-research-1/cookies.txt', Target: 'a', Replacement: 'b' }, RES)],
  ['AUTO', '검토 세션: 대소문자 다른 자기 보고 파일', agy('write_file', { Path: 'c:/P/Handoff/SUB-T01-REVIEW-1-REPORT.md', Content: 'r' }, REV)],
  ['AUTO', '상대 경로 첫 문장 + 절대 경로 쓰기', agy('write_file', { Path: 'C:/p/handoff/sub-t01-review-1-report.md', Content: 'r' }, 'Read handoff/sub-t01-review-1.md and follow it.')],
  ['DENY', '상대 경로 첫 문장: 범위 밖 쓰기 차단', agy('write_file', { Path: 'C:/p/src/app.js', Content: 'x' }, 'Read handoff/sub-t01-review-1.md and follow it.')],
  ['AUTO', '따옴표 첫 문장 + 상대 경로 쓰기', agy('write_file', { Path: 'handoff/sub-t01-review-1-report.md', Content: 'r' }, 'Read "C:/p/handoff/sub-t01-review-1.md" and follow it.')],
  ['DENY', '검토 세션: 경로 없는 쓰기도 차단(이상한 args)', { toolCall: { name: 'write_file', args: 'oops' }, cwd: 'C:/p', lastUserInput: REV }],
  // 12차: review session read-only is an allow-list (unknown, MCP and browser tools are denied); research/normal unchanged
  ['DENY', '검토 세션: args 없는 알 수 없는 도구', { toolCall: { name: 'browser_snapshot' }, cwd: 'C:/p', lastUserInput: REV }],
  ['DENY', '검토 세션: MCP 쓰기 도구', agy('mcp_notion-remote_notion-create-pages', { pages: [] }, REV)],
  ['DENY', '검토 세션: MCP 도구(실제 이름 call_mcp_tool, 2026-11-12 시험)', agy('call_mcp_tool', { ServerName: 'notion-remote', ToolName: 'notion-create-pages', Arguments: {} }, REV)],
  ['DENY', '검토 세션: 모르는 변이 도구 delete_file', agy('delete_file', { Path: 'C:/p/src/app.js' }, REV)],
  ['DENY', '검토 세션: manage_task(작업 종료·입력)', agy('manage_task', { Action: 'kill', TaskId: '1' }, REV)],
  ['DENY', '검토 세션: 브라우저 조작', agy('browser_click', { Selector: '#a' }, REV)],
  ['DENY', '검토 세션: 웹 읽기(search_web)', agy('search_web', { query: 'x' }, REV)],
  ['DENY', '검토 세션: 허용 목록에 없는 읽기 이름(list_dir)도 차단', agy('list_dir', { DirectoryPath: 'C:/p/src' }, REV)],
  ['ALLOW', '검토 세션: view_file(옛 읽기 이름)', agy('view_file', { Path: 'C:/p/src/app.js' }, REV)],
  ['ALLOW', '검토 세션: .git/logs/HEAD 읽기(근거 시점 대조)', agy('read_file', { Path: 'C:/p/.git/logs/HEAD' }, REV)],
  ['DENY', '검토 세션: 이름 일부만 같은 도구(read_file_and_write)', agy('read_file_and_write', { Path: 'C:/p/x' }, REV)],
  ['ALLOW', '조사 세션: MCP 도구는 평소 승인 규칙', agy('mcp_notion-remote_notion-create-pages', { pages: [] }, RES)],
  ['ALLOW', '조사 세션: 브라우저는 평소 승인 규칙', agy('browser_click', { Selector: '#a' }, RES)],
  ['ALLOW', '일반 세션: MCP 도구는 평소 승인 규칙', agy('mcp_notion-remote_notion-create-pages', { pages: [] })],
  ['ALLOW', '문장이 입력 중간에만 있으면 범위를 열지 않음(13차, 자동 허용 없음)', agy('write_file', { Path: 'C:/p/handoff/sub-t01-research-1/a.txt', Content: 'x' }, 'note: "Read C:/p/handoff/sub-t01-research-1.md and follow it." was the old prompt')],
  ['AUTO', '첫 문장으로 시작하면 자기 폴더 쓰기 자동 허용', agy('write_file', { Path: 'C:/p/handoff/sub-t01-research-1/a.txt', Content: 'x' }, RES)],
  ['DENY', 'hc send 재요청의 실제 모양(/plan <hc from=…>Read …</hc>)도 검토 범위 유지', agy('run_command', { CommandLine: 'dir' }, '/plan <hc from="t2h">Read C:/p/handoff/sub-t01-review-1.md and follow it. 다시 확인해</hc>')],
  ['DENY', 'hc 태그만 붙은 모양도 검토 범위 유지', agy('run_command', { CommandLine: 'dir' }, '<hc from="t2h">Read C:/p/handoff/sub-t01-review-1.md and follow it.</hc>')],
  ['DENY', '첫 문장 + 짧은 지시 재요청(hc send)도 검토 범위 유지', agy('manage_task', { Action: 'list' }, 'Read C:/p/handoff/sub-t01-review-1.md and follow it. 다시 확인해')],
  // ---- 오케스트레이션 정책 및 안전성 보강 (AC-2, AC-3, AC-4) ----
  ['BLOCK', 'manual 모드: hc run 차단', bash('hc run --bg --name task-t01 --cwd C:/p -- claude --model m --permission-mode auto "Read handoff/T01.md"', R + '/manual')],
  ['BLOCK', 'manual 모드: --cwd가 manual 저장소면 외부 폴더에서도 hc run 차단', bash('hc run --bg --name task-t01 --cwd ' + R + '/manual -- claude --model m --permission-mode auto "Read handoff/T01.md"', 'C:/p')],
  ['BLOCK', 'manual 모드: hc send 차단', bash('hc send task-t01 "hello"', R + '/manual')],
  ['BLOCK', 'manual 모드: if 블록 안의 hc keys 차단', ps('if ($true) { hc keys sub-t01-review-1 enter }', R + '/manual')],
  ['BLOCK', 'approved.json 직접 Write 차단', { tool_name: 'Write', tool_input: { file_path: 'C:/p/handoff/T01/approved.json', content: '{}' }, cwd: 'C:/p' }],
  ['BLOCK', 'accepted.json 직접 Edit 차단', { tool_name: 'Edit', tool_input: { file_path: 'C:/p/handoff/T01/accepted.json', old_string: 'a', new_string: 'b' }, cwd: 'C:/p' }],
  ['BLOCK', 'Codex apply_patch로 verify/summary.txt 직접 수정 차단', codex('apply_patch', '*** Begin Patch\n*** Update File: handoff/T01/verify/summary.txt\n@@\n-RESULT: FAIL\n+RESULT: PASS\n*** End Patch\n')],
  ['BLOCK', 'rm handoff/T01/accepted.json 직접 삭제 차단', bash('rm handoff/T01/accepted.json')],
  ['BLOCK', 'cp agent-kit 파일로 approved.json 덮어쓰기 차단(fromKit 예외 우회 방지)', bash('cp ' + KITDIR + '/README.md C:/p/handoff/T01/approved.json')],
  ['ALLOW', 'powershell verify.ps1 실행은 허용', ps('powershell -NoProfile -ExecutionPolicy Bypass -File C:/agent-kit/verify.ps1 -Id T01')],
  ['ALLOW', '작업자 보고 파일(handoff/T01-report.md) Write는 허용', { tool_name: 'Write', tool_input: { file_path: 'C:/p/handoff/T01-report.md', content: 'ok' }, cwd: 'C:/p' }],
  ['BLOCK', 'hc run ... codex에서 --no-daemon 누락 차단', bash('hc run --bg --name task-t01 --cwd C:/p -- codex "Read handoff/T01.md and follow it."')],
  ['BLOCK', 'hc run ... codex에서 프롬프트에만 --no-daemon이 있고 실제 플래그가 없으면 차단', bash('hc run --bg --name task-t01 --cwd C:/p -- codex "Use --no-daemon in docs"')],
  ['ALLOW', 'hc run ... codex --no-daemon 정상 실행 허용', bash('hc run --bg --name task-t01 --cwd C:/p -- codex --no-daemon "Read handoff/T01.md and follow it."')],
  ['ALLOW', 'Claude 검토 누적 4회까지 허용', bash('hc run --bg --name sub-t01-review-4 --cwd C:/p -- claude "Read handoff/sub-t01-review-4.md and follow it."')],
  ['BLOCK', 'Claude 검토 누적 5회 이상은 상한 차단', bash('hc run --bg --name sub-t01-review-5 --cwd C:/p -- claude "Read handoff/sub-t01-review-5.md and follow it."')],
  ['BLOCK', "프로젝트 약칭 이름(sub-<p>-<id>-review-5, '--')도 검토 상한 차단", bash("hc run --bg --name sub-myshop-t01-review-5 --cwd C:/p '--' claude \"Read handoff/sub-myshop-t01-review-5.md and follow it.\"")],
  ['ALLOW', "프로젝트 약칭 이름(sub-<p>-<id>-review-4, '--')은 허용", bash("hc run --bg --name sub-myshop-t01-review-4 --cwd C:/p '--' claude \"Read handoff/sub-myshop-t01-review-4.md and follow it.\"")],
  ['BLOCK', "PreToolUse 이벤트(Codex 형태)의 검토 상한도 deny JSON", codex('shell', "hc run --bg --name sub-myshop-t01-review-5 --cwd C:/p '--' codex --no-daemon \"Read handoff/sub-myshop-t01-review-5.md and follow it.\"")],
  ['ALLOW', '설계자 세션에서 AGY 터미널에 직접 hc send 허용', codex('shell', 'hc send agy-by-argv "Read handoff/T01.md"')],
  ['ALLOW', '설계자 세션에서 AGY 터미널에 직접 hc keys 허용', bash('hc --json keys agy-by-foreground enter')],
  ['ALLOW', '설계자 세션에서 working AGY 터미널에도 직접 hc interrupt 허용', bash('hc interrupt agy-by-app')],
  ['ALLOW', '설계자 세션에서 다른 에이전트 터미널에 입력 허용', bash('hc send task-t01 "Continue"')],
  ['ALLOW', '설계자 세션에서 셸 터미널에 키 입력 허용', bash('hc keys named-shell enter')],
  ['ALLOW', 'Herdr 대기는 입력 제어가 아님', bash('hc wait agy-by-foreground --timeout 5')],
  ['BLOCK', 'worktree 폴더(.worktrees/t01) 안에서 다른 작업자(task-t02) 스폰 차단', bash('hc run --bg --name task-t02 --cwd C:/p -- claude --model m --permission-mode auto "Read handoff/T02.md"', 'C:/p/.worktrees/t01')],
  ['DENY', '조사 세션: hc run으로 다른 에이전트 스폰 차단', agy('run_command', { CommandLine: 'hc run --bg --name task-t02 --cwd C:/p -- claude --model m --permission-mode auto "Read handoff/T02.md"' }, RES)],
  ['DENY', '조사 세션: 경로 붙은 hc.exe send도 차단', agy('run_command', { CommandLine: 'C:/Users/u/AppData/Local/Programs/herdr-core/hc.exe send task-t01 "hi"' }, RES)],
  // ---- 비밀/자격증명 우회 차단 및 전 도구 공통 역할 경계 (3사 검토 통합 반영) ----
  ['BLOCK', 'python -c 인라인 스크립트 내 따옴표 .env 읽기 차단', bash('python -c "print(open(\'.env\').read())"')],
  ['BLOCK', 'node -e 인라인 스크립트 내 .env 읽기 차단', bash('node -e "console.log(fs.readFileSync(\'.env\',\'utf8\'))"')],
  ['BLOCK', 'cp로 cookies.txt 복사 우회 차단', bash('cp handoff/T01/cookies.txt handoff/T01/c.txt')],
  ['BLOCK', 'Read viewer.cookies 차단', { tool_name: 'Read', tool_input: { file_path: 'C:/p/handoff/T04/viewer.cookies' } }],
  ['BLOCK', 'cat admin.cookies 차단', bash('cat handoff/T04/admin.cookies')],
  ['BLOCK', 'Read ~/.docker/config.json 차단', { tool_name: 'Read', tool_input: { file_path: HOMEDIR + '/.docker/config.json' } }],
  ['BLOCK', 'Read ~/.kube/config 차단', { tool_name: 'Read', tool_input: { file_path: HOMEDIR + '/.kube/config' } }],
  ['BLOCK', 'Read certs/app.jks 차단', { tool_name: 'Read', tool_input: { file_path: 'C:/p/certs/app.jks' } }],
  ['BLOCK', 'Codex 검토 하위 세션: hc run 샌드박스 탈출 차단', codex('Bash', 'hc run --bg --name x -- powershell -Command whoami'), '하위 세션', 'sub-rev-caller'],
  ['BLOCK', 'Codex 검토 하위 세션: verify.ps1 실행 차단', codex('Bash', 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/agent-kit/verify.ps1 -Id T01 -Accept'), 'verify.ps1', 'sub-rev-caller'],
  ['BLOCK', 'Codex 검토 하위 세션: init.ps1 실행 차단', codex('Bash', 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/agent-kit/init.ps1 -GitSetup -Submission direct'), 'init.ps1', 'sub-rev-caller'],
  ['BLOCK', '작업자 세션(worktree 밖): 다른 작업자(task-*) 스폰 차단', bash('hc run --bg --name task-p-t02 --cwd C:/p -- claude --model m --permission-mode auto "Read handoff/T02.md"'), '다른 작업자', 'worker-caller'],
  ['BLOCK', '작업자 세션: verify.ps1 -Prepare 실행 차단', ps('powershell -NoProfile -ExecutionPolicy Bypass -File C:/agent-kit/verify.ps1 -Id T01 -Prepare'), '-Prepare', 'worker-caller'],
  ['BLOCK', '작업자 세션: verify.ps1 -Accept 실행 차단', ps('powershell -NoProfile -ExecutionPolicy Bypass -File C:/agent-kit/verify.ps1 -Id T01 -Accept'), '-Accept', 'worker-caller'],
  ['ALLOW', '작업자 세션: verify.ps1 일반 실행은 허용', ps('powershell -NoProfile -ExecutionPolicy Bypass -File C:/agent-kit/verify.ps1 -Id T01'), '', 'worker-caller'],
  ['ALLOW', '작업자 세션: verify.ps1 -CheckAccepted는 허용', ps('powershell -NoProfile -ExecutionPolicy Bypass -File C:/agent-kit/verify.ps1 -Id T01 -CheckAccepted'), '', 'worker-caller'],
  ['BLOCK', '작업자 세션: init.ps1 정책 변경 플래그 차단', ps('powershell -NoProfile -ExecutionPolicy Bypass -File C:/agent-kit/init.ps1 -GitSetup -Submission direct'), '정책을 변경', 'worker-caller'],
  ['BLOCK', '작업자 세션: 설계자/타 터미널에 hc send 차단', bash('hc send named-shell "hi"'), '직계 자식', 'worker-caller'],
  ['BLOCK', '작업자 세션: 설계자/타 터미널에 hc kill 차단', bash('hc kill named-shell'), '직계 자식', 'worker-caller'],
  ['ALLOW', '작업자 세션: 자기가 띄운 직계 자식 검토 터미널에 hc keys 허용', bash('hc keys worker-child enter'), '', 'worker-caller'],
  ['ALLOW', '커밋 메시지에 verify.ps1 -Prepare 언급은 오탐 없음', bash('git commit -m "docs: verify.ps1 -Prepare 설명"'), '', 'worker-caller'],
  ['BLOCK', '작업자 세션: verify.ps1 -A (축약 플래그) 실행 차단', ps('powershell -NoProfile -ExecutionPolicy Bypass -File C:/agent-kit/verify.ps1 -Id T01 -A'), '-Accept', 'worker-caller'],
  ['BLOCK', '작업자 세션: verify.ps1 -Pre (축약 플래그) 실행 차단', ps('powershell -NoProfile -ExecutionPolicy Bypass -File C:/agent-kit/verify.ps1 -Id T01 -Pre'), '-Prepare', 'worker-caller'],
  ['BLOCK', '작업자 세션: init.ps1 -S direct (축약 플래그) 실행 차단', ps('powershell -NoProfile -ExecutionPolicy Bypass -File C:/agent-kit/init.ps1 -GitSetup -S direct'), '정책을 변경', 'worker-caller'],
  ['ALLOW', '검토 하위 세션: rg 검색 패턴 안의 |init.ps1 은 실행으로 오탐하지 않음', codex('Bash', 'rg -n "verify\\.ps1|init\\.ps1" C:/p'), '', 'sub-rev-caller'],
  ['BLOCK', '따옴표 감싼 cmd /c "git push --no-verify" 차단', ps('cmd /c "git push --no-verify origin feat"', R + '/repo-wt')],
  ['BLOCK', '파일 디스크립터 리다이렉션 1> .git/hooks/pre-push 차단', bash('echo exit 0 1> .git/hooks/pre-push', R + '/repo')],
  ['BLOCK', 'Copy-Item -Destination 먼저 쓴 보호 파일 덮어쓰기 차단', ps('Copy-Item -Destination ' + HOMEDIR + '/.claude/settings.json -Path C:/p/a.json')],
  ['BLOCK', 'hc run --env 옵션 뒤의 검토 5회차 상한도 차단', bash('hc run --bg --env FOO=1 --name sub-t01-review-5 --cwd C:/p -- claude "Read handoff/sub-t01-review-5.md and follow it."')],
  ['BLOCK', '수동 인계(HC_TERMINAL_ID 없음, AGENTKIT_ROLE=worker): verify.ps1 -Accept 차단', ps('powershell -NoProfile -ExecutionPolicy Bypass -File C:/agent-kit/verify.ps1 -Id T01 -Accept'), '-Accept', 'manual-worker'],
  ['BLOCK', '수동 인계(HC_TERMINAL_ID 없음, AGENTKIT_ROLE=sub-...): verify.ps1 차단', codex('Bash', 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/agent-kit/verify.ps1 -Id T01'), 'verify.ps1', 'manual-sub'],
];
// Every case runs with a global Git config that says submission=direct, so the repos without a local policy above
// (repo, repo-wt, C:/p) also show that the guard never falls back to global config.
const GLOBAL = join(TMP, 'global.gitconfig');
writeFileSync(GLOBAL, '[agentkit]\n\tsubmission = direct\n\tprotectedBranches = nothing\n');
// Stub only the read-only Herdr lookup. Regression tests never inspect or send to a real terminal.
const mockHc = `data:text/javascript,${encodeURIComponent(`
  import childProcess from 'node:child_process';
  import { syncBuiltinESMExports } from 'node:module';
  const original = childProcess.execFileSync;
  const facts = {
    'agy-by-argv': { argv: ['C:/bin/agy.exe'], status: { state: 'idle' } },
    'agy-by-foreground': { argv: ['powershell.exe'], foreground: { name: 'agy.exe' }, status: { state: 'blocked' } },
    'agy-by-app': { argv: ['powershell.exe'], status: { app: 'antigravity', state: 'working' } },
    'task-t01': { argv: ['claude.exe'], parent: 'test-caller', status: { app: 'claude-code', state: 'idle' } },
    'named-shell': { argv: ['powershell.exe'], parent: 'other-parent', foreground: { name: 'powershell.exe' } },
    'worker-child': { argv: ['claude.exe'], parent: 'worker-caller', status: { app: 'claude-code', state: 'blocked' } },
    'sub-rev-caller': { name: 'sub-demo-t01-review-1', argv: ['codex.exe'], status: { state: 'working' } },
    'worker-caller': { name: 'task-demo-t01', argv: ['claude.exe'], status: { state: 'working' } },
    'invalid-facts': { argv: 'agy.exe', foreground: { name: 42 }, status: { app: {} } },
  };
  childProcess.execFileSync = (file, args, opts) => {
    if (file !== 'hc') return original(file, args, opts);
    if (args.slice(0, -1).join(' ') !== 'get --json --' || opts.env.HC_TERMINAL_ID || opts.timeout !== 2000) {
      throw new Error('unexpected Herdr lookup parameters');
    }
    const target = args.at(-1);
    if (target === 'malformed') return 'broken JSON';
    if (!Object.hasOwn(facts, target)) throw new Error('target not found');
    return JSON.stringify({ address: 't1', state: 'live', ...facts[target] });
  };
  syncBuiltinESMExports();
`)}`;
let bad = 0;
function runGuard(ev, { callerId = 'test-caller', rateFile = 'off', nowMs = '' } = {}) {
  const isManualWorker = callerId === 'manual-worker';
  const isManualSub = callerId === 'manual-sub';
  const hcId = (isManualWorker || isManualSub) ? '' : callerId;
  const roleEnv = isManualWorker ? 'worker' : isManualSub ? 'sub-demo-t01-review-1' : '';
  const env = { ...process.env, AGENT_GUARD_TEST: '1', GIT_CONFIG_GLOBAL: GLOBAL, HC_TERMINAL_ID: hcId, AGENTKIT_ROLE: roleEnv, AGENTKIT_RATE_FILE: rateFile };
  if (nowMs) env.AGENTKIT_NOW_MS = String(nowMs);
  const r = spawnSync('node', ['--import', mockHc, GUARD], { input: JSON.stringify(ev), env });
  const pre = ev.hook_event_name === 'PreToolUse' && !ev.toolCall;
  let got = r.status === 2 ? (pre ? 'EXIT2' : 'BLOCK') : r.status === 0 ? 'ALLOW' : 'ERR' + r.status;
  const out = r.stdout ? r.stdout.toString().trim() : '';
  if (r.status === 0 && out) { try { const j = JSON.parse(out), d = j.decision; got = j.hookSpecificOutput ? (j.hookSpecificOutput.permissionDecision === 'deny' && j.hookSpecificOutput.hookEventName === 'PreToolUse' && /\[guard\] 차단/.test(j.hookSpecificOutput.permissionDecisionReason) ? 'BLOCK' : 'ERR-out') : d === 'deny' ? 'DENY' : d === 'allow' ? 'AUTO' : 'ERR-out'; } catch { got = 'ERR-out'; } }
  return { got, out, err: r.stderr?.toString() || '' };
}
for (const [want, name, ev, reason, callerId] of cases) {
  const { got, out, err } = runGuard(ev, { callerId: callerId || 'test-caller', rateFile: 'off' });
  const finalGot = (reason && ![out, err].some((m) => m?.includes(reason))) ? 'ERR-reason' : got;
  if (finalGot !== want) bad++;
  console.log(`${finalGot === want ? 'PASS' : 'FAIL'}  ${finalGot.padEnd(5)} ${name}`);
}

// ---- Rate-limit & anti-infinite-loop guardrails ----
function checkRate(name, want, ev, opts, reason = '') {
  const { got, out, err } = runGuard(ev, opts);
  const finalGot = (reason && ![out, err].some((m) => m?.includes(reason))) ? 'ERR-reason' : got;
  if (finalGot !== want) bad++;
  console.log(`${finalGot === want ? 'PASS' : 'FAIL'}  ${finalGot.padEnd(5)} ${name}`);
}
const T0 = 1_800_000_000_000;
const agyLaunch = (stem) => bash(`hc run --bg --name ${stem} --cwd C:/p -- agy.exe --model m --mode plan --sandbox -i "Read C:/p/handoff/${stem}.md and follow it."`);
// 1) AGY 30초 연속 실행 간격 + 정적 차단 시 예산 미소모
{
  const rf = join(TMP, 'rate-cooldown.json');
  checkRate('속도 제한: 정적 차단(plan 누락)은 실행 예산을 소모하지 않음', 'BLOCK', bash(AGYRUN + ' --sandbox -i "Read C:/p/handoff/sub-t01-review-1.md and follow it."'), { rateFile: rf, nowMs: T0 });
  checkRate('속도 제한: 첫 AGY 실행 허용', 'ALLOW', agyLaunch('sub-p-t01-review-1'), { rateFile: rf, nowMs: T0 + 1000 });
  checkRate('속도 제한: 10초 뒤 연속 AGY 실행은 30초 간격으로 차단', 'BLOCK', agyLaunch('sub-p-t02-review-1'), { rateFile: rf, nowMs: T0 + 11_000 }, '최소 30초');
  checkRate('속도 제한: 31초 뒤 다음 AGY 실행은 허용', 'ALLOW', agyLaunch('sub-p-t02-review-1'), { rateFile: rf, nowMs: T0 + 32_000 });
  checkRate('속도 제한: 한 명령에 AGY 실행 2개 연달아 적으면 차단', 'BLOCK', bash(`hc run --bg --name sub-p-t03-review-1 --cwd C:/p -- agy.exe --mode plan -i "Read handoff/sub-p-t03-review-1.md and follow it." && hc run --bg --name sub-p-t04-review-1 --cwd C:/p -- agy.exe --mode plan -i "Read handoff/sub-p-t04-review-1.md and follow it."`), { rateFile: rf, nowMs: T0 + 90_000 }, '최소 30초');
}
// 2) AGY 10분 6회 상한
{
  const rf = join(TMP, 'rate-10m.json');
  for (let i = 1; i <= 6; i++) {
    checkRate(`속도 제한: AGY 10분 내 ${i}회차 허용`, 'ALLOW', agyLaunch(`sub-p-t0${i}-research-1`), { rateFile: rf, nowMs: T0 + i * 35_000 });
  }
  checkRate('속도 제한: AGY 10분 내 7회차 차단', 'BLOCK', agyLaunch('sub-p-t07-research-1'), { rateFile: rf, nowMs: T0 + 7 * 35_000 }, '10분 내 6회');
}
// 3) 동일 이름 hc run 재시도 루프 (10분 3회 초과 차단) + 전체 hc run 10분 12회 초과 차단
{
  const rf = join(TMP, 'rate-runloop.json');
  for (let i = 1; i <= 3; i++) {
    checkRate(`루프 방지: 동일 이름 hc run ${i}회차 허용`, 'ALLOW', bash('hc run --bg --name task-p-t01 --cwd C:/p -- claude --permission-mode auto "Read handoff/T01.md"'), { rateFile: rf, nowMs: T0 + i * 5_000 });
  }
  checkRate('루프 방지: 동일 이름 hc run 4회차 차단', 'BLOCK', bash('hc run --bg --name task-p-t01 --cwd C:/p -- claude --permission-mode auto "Read handoff/T01.md"'), { rateFile: rf, nowMs: T0 + 20_000 }, '같은 이름');
  for (let i = 2; i <= 10; i++) {
    runGuard(bash(`hc run --bg --name task-p-t${i} --cwd C:/p -- claude --permission-mode auto "Read handoff/T${i}.md"`), { rateFile: rf, nowMs: T0 + 25_000 + i * 1000 });
  }
  checkRate('루프 방지: 전체 hc run 10분 12회 초과(13회차) 차단', 'BLOCK', bash('hc run --bg --name task-p-t99 --cwd C:/p -- claude --permission-mode auto "Read handoff/T99.md"'), { rateFile: rf, nowMs: T0 + 40_000 }, '10분 내 12회');
}
// 4) hc send 동일 메시지 무한 루프 + 단기 폭주 + 직후 hc keys 허용 + hc keys 연타 루프 차단
{
  const rf = join(TMP, 'rate-sendkeys.json');
  checkRate('루프 방지: hc send 1회차 허용', 'ALLOW', bash('hc send task-t01 "Please finish report"'), { rateFile: rf, nowMs: T0 });
  checkRate('루프 방지: hc send 직후 hc keys enter 허용', 'ALLOW', bash('hc keys task-t01 enter'), { rateFile: rf, nowMs: T0 + 1000 });
  checkRate('루프 방지: 동일 hc send 1회 재요청(2회차) 허용', 'ALLOW', bash('hc send task-t01 "Please finish report"'), { rateFile: rf, nowMs: T0 + 5000 });
  checkRate('루프 방지: 동일 hc send 3회차 차단', 'BLOCK', bash('hc send task-t01 "Please finish report"'), { rateFile: rf, nowMs: T0 + 10_000 }, '동일한 hc send');
  checkRate('루프 방지: 다른 메시지 hc send 3회차(1분 내) 허용', 'ALLOW', bash('hc send task-t01 "Different follow-up"'), { rateFile: rf, nowMs: T0 + 15_000 });
  checkRate('루프 방지: 같은 대상 1분 내 4번째 hc send 차단', 'BLOCK', bash('hc send task-t01 "Fourth in one minute"'), { rateFile: rf, nowMs: T0 + 20_000 }, '1분 내 3회');
  for (let i = 2; i <= 10; i++) {
    runGuard(bash('hc keys task-t01 enter'), { rateFile: rf, nowMs: T0 + 20_000 + i * 1000 });
  }
  checkRate('루프 방지: 같은 대상 2분 내 11번째 hc keys 차단', 'BLOCK', bash('hc keys task-t01 enter'), { rateFile: rf, nowMs: T0 + 35_000 }, '2분 내 10회');
}
console.log(bad ? `${bad} FAIL` : 'ALL PASS'); process.exit(bad ? 1 : 0);
