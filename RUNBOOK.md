# 실행 가이드 (RUNBOOK) — 막혔을 때 해당 절만 읽는다
도구 사용 요령과 로컬 환경 구성을 둔다(`<agent-kit>`은 이 저장소 루트 경로). 지금 유효한 사실만 적고, 절 번호는 다른 파일이 가리키므로 유지한다(8절은 없다).

## 1. 도구 경로·모델·검증
- hc: `hc`(Windows 기본 `$env:LOCALAPPDATA/Programs/herdr-core/hc.exe`; 에이전트용 공식 안내 확인은 `hc --skill`) / agy: `agy`(기본 `$env:LOCALAPPDATA/agy/bin/agy.exe`; 모델 조회 `agy models`)
- 템플릿 원본: `<agent-kit>/templates/` (`init.ps1`이 프로젝트에 복사하며 `<agent-kit>`·`<hc-prefix>`·`<default-*>`를 치환하고, 키트 경로 이동 시 옛 경로도 갱신한다). Git 제외 블록 원본: `git-exclude.txt`(팀·다중 PC에서 스펙·지침을 Git으로 공유할 때는 `init.ps1 -TrackSpec`).
- 고정 검증: `powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/verify.ps1 -Id <ID>` (macOS·Linux는 `pwsh -NoProfile -File ...`). worktree/하위 저장소는 모든 모드에 `-Project <handoff가 있는 폴더> -Repo <저장소·worktree>`를 함께 준다. 작업 ID는 영문·숫자·`-`·`_`만 쓴다(`hc --name`이 `.`을 거부하므로 `.`은 쓰지 않는다).
  - **설계자 착수 전 `-Prepare`**: 인계·명령·`review` 등급·`SPEC.md` 해시·비교 commit을 고정하고 로컬 Git 설정에 `agentkit.projectRoot`를 기록한다(`verify: -` 수동 Git 작업도 기준 고정을 위해 `-Prepare`를 실행할 수 있다). Base 우선순위는 `-Base` → 인계 `base:` → Repo의 로컬 `agentkit.base` → `origin/HEAD` → `main`/`master`.
  - **작업자 기본 실행 → 설계자 `-Accept` → 작업자 제출 직전 `-CheckAccepted`**:
    - 작업자 실행이 `handoff/<ID>/verify/runs/<실행>/`에 불변 증거(`run.json`, `summary.txt`, `output.txt`, `diff.patch`, `changed.txt`, `test-changes.txt`, `evidence.json`)를 남긴다.
    - **설계자의 `-Accept`는 기본적으로 검사 명령을 중복 재실행하지 않는다.** 동일 `approval`·동일 `HEAD` 커밋에서 가장 최근 작업자 실행이 `PASS`이고 워킹트리가 깨끗한지 즉시 대조해 `accepted.json`을 기록한다(명령까지 강제 재실행하려면 `-Rerun` 추가).
    - `critical` 수락은 검토 보고의 `-ReviewedCommit <전체 해시>`와 `-ReviewReport <경로>`가 모두 필수이며, 보고서 안의 `판정: 진행 가능 | 높음 0`·`검토 commit`(HEAD 일치)·`검증 경로`(수락할 작업자 실행의 `OUT` 또는 수동 증거 경로 일치)를 기계적으로 검증한다. `-Accept`가 실패해도 작업자의 기존 `PASS` 기록은 보존되므로 수정 후 바로 다시 `-Accept`할 수 있다.
    - `verify: -` 수동 검증 Git 작업은 작업자 실행 시 `RESULT: NONE`(exit 3)이 나오며, 설계자가 수동 증거를 직접 확인한 뒤 `verify.ps1 -Id <ID> -Accept -Manual`을 실행하면 현재 `HEAD` 커밋과 증거 해시를 `accepted.json`에 기록해 `direct` 모드 `pre-push` 검증을 통과시킨다.
  - **캐시·0건 테스트 차단**: 바뀌지 않은 일을 건너뛰거나 테스트가 실행되지 않은 출력(Gradle `UP-TO-DATE`·`FROM-CACHE`·`SKIPPED`·`NO-SOURCE` 및 실행 태스크 0개 요약, Go 전체 `(cached)` 또는 전체 `[no test files]`, Cargo 전체 `running 0 tests`[단 다른 타겟에서 1개 이상 실행됐으면 통과], Node `# tests 0`/`# pass 0`, Maven `Tests run: 0,`, `.NET` `Total tests: 0`, Pytest/Vitest 전원 skipped, Turborepo `FULL TURBO`, Nx 캐시 리플레이)은 실행 근거가 아니라 실패다.
  - 검증 전후 미커밋·미추적 소스/skip-worktree 숨긴 변경·Git 오류·검사 중 HEAD/추적 파일 변경은 실패다(`sparse-checkout`의 정상 `S` 표시는 허용). Git direct/local 통합은 `--ff-only`, 추가 commit이 필요하면 검증·수락을 다시 한다.
- 훅: `hooks/guard.mjs`(Claude `~/.claude/settings.json` PreToolUse `matcher: ".*"`, Codex `~/.codex/hooks.json`, Antigravity `~/.gemini/config/hooks.json`; `install.ps1`로 일괄 설치), `hooks/pre-push`(`init.ps1`이 `.git/hooks/pre-push`로 설치). 9절.
- 스킬 원본: `<agent-kit>/skills/` (`install.ps1`로 일괄 등록). Claude(`~/.claude/skills/<이름>`)·Codex(`~/.agents/skills/<이름>`)는 정션(Windows `mklink /J`) 또는 심볼릭 링크(macOS·Linux `ln -sfn`)로 연결하고, Antigravity는 `~/.gemini/config/skills.json`의 `entries`에 `<agent-kit>/skills`를 네이티브로 등록한다. Windows 정션은 `cmd /c rmdir <정션 경로>`로만 지운다.
- 회귀 테스트 일괄 실행: `node test.mjs` (개별 실행: `node hooks/guard.test.mjs`, `node hooks/pre-push.test.mjs`, `node install.test.mjs`, `node verify.test.mjs`, `node cleanup.test.mjs`, `node update-tools.test.mjs`).

## 2. hc 대기·읽기 (대화형 작업자·브라우저 조사 전용)
- 단발성 무맥락 검토·읽기 조사는 비대화형(헤드리스 `-p` / `exec`)으로 실행하므로 `hc` 대기 루프를 쓰지 않는다.
- 대화형 작업자(`task-<p>-<id>`)에 대한 `hc wait`의 timeout(기본 180초, 위임 시 `--timeout 600`)은 실패가 아니다. 같은 대상을 동시에 wait하거나 `hc ls`를 반복 폴링하지 않는다.
- 작업자를 띄운 직후 응답이 없거나 이상하면 `hc get <이름> --json`에서 `first_message.sent`를 확인한다(`false`면 초기 프롬프트가 전달되지 않은 것이므로 원인을 확인한다).
- 화면은 정체 근거(blocked·error, done인데 보고 없음, 명시적 오류)가 있을 때와 timeout 확인 때만 `hc read <터미널 이름·주소> --lines 0`으로 한 번 읽는다. **상위 AI가 화면을 읽고 `hc keys <대상> enter`로 승인 창을 대리 클릭하지 않는다**(권한 확대 승인 창은 사용자에게 알린다).

## 3. hc 보고·전송·이름 규칙
- `hc run --name`은 소문자 영문·숫자·`-`·`_` 1~32자만 받는다(점 `.`과 대문자는 거부된다). 이름은 PC 전체에서 유일해야 하므로 프로젝트 약칭 `<p>`와 소문자 작업 ID를 넣는다: 작업자 `task-<p>-<id>`, 대화형 조사 `sub-<p>-<id>-research-<n>`. `<p>`는 `AGENTS.md`의 `hc 이름 약칭`이다(`init.ps1`이 자동 생성).
- 대화형 작업자에 후속 지시를 보낼 때는 `hc send --wait <대상> "<내용>"`을 써서 전송과 해당 턴 종료 대기를 한 번에 처리한다(`hc send`는 자동으로 Enter를 입력하므로 확인 없이 `hc keys enter`를 추가로 누르지 않는다).
- 프롬프트·작업 인계·자료 발췌에서 요청·배정·실행한 사람, 모델, 세션 ID, 별칭을 생략한다. 실행 인자·이름은 ASCII로 쓰고 한글 지시는 파일에 적어 경로를 넘긴다.
- Claude의 `--add-dir`는 가변 인자이므로 프롬프트 앞에 `'--'`를 둔다. 실행 명령의 `--`는 작은따옴표 `'--'`로 감싼다(Codex PowerShell 파서 호환).

## 4. Antigravity 실행
- 단발성 검토·읽기 조사는 `agy -p --model <모델> --mode plan --sandbox --disable-slash-commands --settings "<프로젝트 폴더>/handoff/<stem>/settings.json" "Read <프로젝트 폴더>/handoff/<stem>.md and follow it."`으로 비대화형 실행한다.
- 브라우저 조작이 필요한 대화형 조사만 `hc run --bg ... agy --mode plan --sandbox -i ...`로 띄우고, 작업자(`task-<p>-<id>`)만 `--mode auto`를 쓴다(그 밖의 `auto` 실행은 `guard.mjs`가 차단).
- `plan` 세션의 허용·거부는 `--settings <파일>`(UTF-8, BOM 없음)로 그 세션에만 준다. **`read_file(*)` 같은 전역 와일드카드는 쓰지 않고** `read_file(<프로젝트 폴더>)`, `read_file(<agent-kit>/templates/agent-roles)`처럼 필요한 폴더 경로만 명시한다.
- 호출 간격·무한 루프 방지(`guard.mjs` 기록 파일: Windows `%LOCALAPPDATA%/agent-kit/hc-rate.json`, macOS·Linux `~/.cache/agent-kit/hc-rate.json`, 최근 60분 보관):
  - AGY 실행 후 최소 30초 간격, 최근 10분 6회·60분 20회 상한.
  - 같은 이름 `hc run` 10분 3회 초과·전체 `hc run` 10분 12회 초과, 같은 대상 동일 `hc send` 10분 3회째·단기 `hc send` 1분 3회/10분 8회 초과, 같은 대상 `hc keys` 2분 10회 초과 차단.

## 5. 병렬 Git 작업 (worktree)
- 병렬 작업은 저장소 루트의 `.worktrees/<소문자 id>`로 격리한다.
- **기동 전 선행 생성**: 작업자가 메인 루트 파일을 실수로 건드리지 않도록, 작업자를 띄우기 전에 저장소 루트에서 `git worktree add .worktrees/<소문자 id> -b <브랜치>`로 worktree를 먼저 만들고 작업자를 처음부터 `--cwd <worktree 경로>`에서 시작한다(또는 도구의 네이티브 `--worktree` 격리와 맞춘다).
- `-TrackSpec`이 아닌 저장소에서는 지침·인계·보고·`handoff/<ID>/`·`SPEC.md`·`SESSION_HANDOFF.md`가 메인 프로젝트 폴더에 있으므로, 검증·대조에는 `-Project <프로젝트 폴더> -Repo <worktree 폴더>`를 함께 쓴다. 통합(merge) 확인 뒤 `git worktree remove .worktrees/<소문자 id>`로 정리한다.

## 6. Herdr
- 패널에는 설계자와 대화형 작업자만 띄운다. 사용자의 스페이스·탭·세션을 닫지 않고, 사용자 터미널에 명령을 보내지 않는다.

## 7. 확인된 제약
- Codex를 `hc run`으로 대화형 기동할 때는 `--no-daemon`이 필요하다(없으면 공유 데몬에서 실행되어 `hc` 자식 추적이 끊긴다; 단발성 검토는 `codex exec` 사용 가능).
- Antigravity는 전역 `~/.gemini/config/hooks.json`·`skills.json` 및 프로젝트 `.agents/` 설정을 읽으며, 규칙 파일로 `AGENTS.md`와 `GEMINI.md`를 모두 자동 발견한다(`AGENTS.md` 단일 파일만 두어 중복 로드를 피한다).

## 9. 훅
- 훅은 실수를 막는 장치이지 보안 경계가 아니다. 실제 강제는 브랜치 보호, 토큰 범위, CLI 네이티브 샌드박스·권한 프로필로 한다.
- `guard.mjs`가 막는 것:
  - 비밀 파일 열람·편집(`.env` 계열[`.env.example`·`.env.test`·`.env.ci` 제외], 개인키·인증서·키스토어, SSH 키, 클라우드 ADC, 셸 히스토리, `.pypirc`, `.tfstate`, 인라인 Node/Python/PowerShell/`.NET` 스크립트 및 브라우저 `file://` 포함)
  - 테스트 계정·쿠키(`*test-accounts*.json`·`*cookies.txt`·`*.cookies`·`*storage-state*.json`) 열람·복사·기존 파일 덮어쓰기 및 `curl -v`/`-i`/`--trace` 헤더 평문 덤프
  - 저장소 정책이 막는 `git push`와 `pre-push` 우회(`--no-verify`, `core.hooksPath`, `GIT_CONFIG_*`, `send-pack`), `git config agentkit.*` 직접 변조, 작업자의 `--match-head-commit` 없는 `gh pr merge`
  - 권한·훅 우회 플래그(`--dangerously-*`, `bypassPermissions`, `--bare`, `--safe-mode`, user 없는 `--setting-sources`, `-a never`, `danger-full-access` 등)
  - `.git/hooks`·`.git/config`·`.git` 삭제, `handoff/<ID>/`의 승인·수락·검증 증거(상위 폴더 삭제 포함) 직접 변경, 일반 세션의 `agent-kit/**` 및 전역·로컬 에이전트 설정(`.claude/`·`.mcp.json`·`.codex/`·`.gemini/`·`.agents/`·`.agent/`·`_agents/`·`hc-rate.json`) 변경, 훅 비활성화(`"enabled": false`, `"disableAllHooks": true`)
  - 하위 세션(`sub-*` 및 AGY `conversationId` 유지 스코프)의 `hc` 제어(`hc exec` 포함)·서브에이전트/워크플로 증식·`verify.ps1`·`init.ps1` 실행, 작업자 세션의 타 작업자 실행·`-Prepare`/`-Accept`(중첩 `powershell -Command` 포함)·정책 변경·직계 자식 외 터미널 제어.
- 제출·호출 정책 설정: `init.ps1 -GitSetup -Target <저장소 루트> -Submission <pr|direct|local> [-ProtectedBranches <CSV>] [-Base <ref>] [-CrossAgentMode <auto|manual>] [-MaxVerifyFailures <int>] [-ProjectRoot <상위 폴더>] [-TrackSpec]`.

## 10. 세션·저장소 관리
- 작업자는 인계 하나에 세션 하나다. 설계자가 새 세션으로 바뀔 때는 `SPEC.md`·`SESSION_HANDOFF.md`·`handoff/<ID>-report.md`를 읽고 이어간다.
- 정리는 사용자가 요청할 때만 `skills/agent-session-cleanup/SKILL.md`와 `cleanup.ps1`로 수행한다(단발성 헤드리스 검토를 쓰면 상주 터미널과 Claude 세션 파일이 처음부터 남지 않는다).

## 11. 기존 프로젝트에 템플릿 병합
`init.ps1` 출력에 `SKIPPED`가 있으면 이미 지침 파일이 있는 프로젝트다(`init.ps1 -Target <프로젝트 폴더>`만 실행해도 미치환 토큰과 옮겨진 `agent-kit` 경로·옛 스킬 경로는 자동 갱신된다). 템플릿 본문까지 병합할 때는 `handoff/T00.md`(`review: normal`, `verify: -`)로 작업자에게 맡긴다. 기존 저장소에 프로젝트 고유 `CLAUDE.md`가 이미 있으면 상단에 `@AGENTS.md` 한 줄을 넣어 `AGENTS.md`가 함께 읽히게 하고, 과거에 복사된 래퍼 전용 `GEMINI.md`·`CLAUDE.md`는 제거해 이중 읽기를 없앤다.

## 12. 에이전트 카탈로그·역할 교체
3사 모두 프로젝트 루트(및 모노레포·대형 저장소의 하위 모듈 폴더) `AGENTS.md`를 계층적으로 자동 로드한다(기존 `CLAUDE.md`가 따로 없을 때). 프로젝트 루트 `AGENTS.md` 역할 배정 표만 고치면 역할을 바꿀 수 있다.

| 에이전트 | 자동으로 읽는 파일 | 설계자 | 작업자 | 검토자·조사 | guard 훅 | 스킬 등록 |
|---|---|---|---|---|---|---|
| Codex | `AGENTS.md` | 확인(`codex --no-daemon`) | 확인(대화형 `--no-daemon`) | 확인(`codex exec` 비대화형 `cell_review` 읽기 전용 + `handoff/<stem>` 쓰기 허용) | `~/.codex/hooks.json` | `~/.agents/skills` 링크 |
| Claude | `AGENTS.md` (또는 기존 `CLAUDE.md`의 `@AGENTS.md`) | 확인(`claude`) | 확인(`claude --permission-mode auto` + 로컬 검증/Git `--allowedTools`) | 확인(`claude -p --permission-mode dontAsk --permission-prompts none --strict-mcp-config --no-session-persistence`) | `~/.claude/settings.json` (`matcher: ".*"`) | `~/.claude/skills` 링크 |
| Antigravity | `AGENTS.md` | 확인(`agy`) | 확인(`agy --mode auto --sandbox`) | 확인(단발성 `agy -p --mode plan --sandbox --settings ...`, 브라우저 조사만 대화형 `-i`) | `~/.gemini/config/hooks.json` | `~/.gemini/config/skills.json` |

## 13. 테스트 자격증명·브라우저
- 테스트 계정·쿠키·저장 상태 파일은 `handoff/<ID>/` 안에 새로 만들고 테스트 도구의 인자로만 넘긴다(열람·복사·기존 파일 덮어쓰기 및 `curl -v`/`-i`/`--trace` 헤더 출력은 `guard.mjs`가 차단한다).
- 작업 수락·제출이 끝나면 테스트 계정·임시 컨테이너·브라우저 저장 상태를 폐기한다. 운영 사이트는 읽기 전용으로만 확인한다.

## 14. 도구가 업데이트됐을 때
`check-tools.ps1`이 `tool-versions.txt`와 설치된 버전을 비교하고 훅 설정 무결성을 함께 점검한다. 사용자가 `"도구 업데이트 반영해"`라고 할 때만 아래 순서로 확인한다:
1. 바뀐 도구의 변경 내역과 `agy --help`·`claude --help`·`codex --help`·`hc --help`(`hc --skill`)를 직접 확인한다(원칙 12).
2. 키트가 쓰는 옵션·권한·훅 동작과 회귀 테스트 6종을 점검하고, 도구가 새로 네이티브 지원하는 기능으로 키트의 수동 우회를 덜어낼 수 있으면 사용자에게 제안한다(원칙 2).
3. 끝나면 로컬 머신 기준만 갱신할 때는 `check-tools.ps1 -Accept`(Git 제외 파일 `tool-versions.local.txt` 기록)를 실행하고, 키트 배포판 기준 버전을 올릴 때는 `tool-versions.txt`를 수정해 커밋한다.

## 15. 작업별 맞춤 제약·검증과 반복 실패 시 수정
- **불변 경계**: 전역 `agent-kit` 원본, `hooks/guard.mjs`, `hooks/pre-push`, 에이전트 권한/훅 설정은 작업 중 절대 수정하지 않는다.
- **착수 전 조건부 선제 조립**(큰·`critical`·기존 테스트 부재 작업 전용): 도메인 고유 금지 함정은 별도 규칙 파일을 만들지 않고 `handoff/<ID>.md` 본문에 직접 적어 `-Prepare` 해시에 고정한다. 전용 검증 테스트·스크립트·픽스처가 필요할 때는 `handoff/<ID>/`(Git 제외 경로)에 두지 말고 **작업자가 저장소 추적 경로에 작성·커밋해 `verify`에 연결**하게 한다(`diff.patch`·`test-changes.txt`로 감시).
- **반복 실패 시 1회 수정**(원인이 같은 `verify` 실패 2회 연속, `MaxVerifyFailures` 도달, 또는 재검토 뒤에도 같은 `높음` 잔존 시):
  1. 설계자가 `handoff/<ID>/verify/runs/` 실패 출력과 `handoff/<ID>-report.md`를 읽고 코드 실수인지 인계·검증 결함(모호한 제약, 빠진 검증 픽스처, 과도한 범위, 잘못된 `verify` 명령)인지 먼저 가른다.
  2. 인계 결함이면 `handoff/<ID>.md`를 보완한다(완료 기준·인수 조건의 의미나 작업 분할이 달라지면 먼저 사용자 확인을 받고, `critical`이면 빈틈 재검토 수행). 이어서 `verify.ps1 -Id <ID> -Prepare -Base <원래 baseCommit>`으로 기준을 유지한 채 재고정하고 작업자에게 `"handoff updated, read it again"`을 전한다.
  3. **절대 상한**: 작업당 인계 수정 재고정은 **1회**까지만 한다. 이후에도 실패하면 멈추고 원인과 대안을 사용자에게 보고한다.
