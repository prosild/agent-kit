# 실행 가이드 (RUNBOOK) — 막혔을 때 해당 절만 읽는다
도구 사용 요령과 로컬 환경 구성을 둔다(`<agent-kit>`은 이 저장소 루트 경로). 지금 유효한 사실만 적고, 바뀐 이유는 커밋 메시지에 둔다(`git -C <agent-kit> log`). 절 번호는 다른 파일이 가리키므로 바꾸지 않는다(8절은 없다).

## 1. 도구 경로·모델
- hc: `hc`(기본 설치 `C:/Users/<사용자>/AppData/Local/Programs/herdr-core/hc.exe`, PowerShell `$env:LOCALAPPDATA`) / herdr-app: `$env:LOCALAPPDATA/Programs/herdr-app/herdr-app.exe` / agy: `agy`(기본 설치 `C:/Users/<사용자>/AppData/Local/agy/bin/agy.exe`; 사용자 터미널에서 모델 목록 조회는 `agy models`)
- 템플릿 원본: `<agent-kit>/templates/` (`init.ps1`이 프로젝트에 복사하며 `<agent-kit>`·`<hc-prefix>`·`<default-*>`를 실제 경로와 `local-defaults.json` 값으로 치환). Git 제외 블록 원본: `git-exclude.txt`.
- 고정 검증: `powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/verify.ps1 -Id <ID>`. worktree/하위 저장소는 모든 모드에 `-Project <handoff가 있는 폴더> -Repo <저장소·worktree>`를 함께 준다.
  - 설계자 착수 전 `-Prepare`: 인계·명령·review와 비교 commit을 고정한다. Base 우선순위는 `-Base` → 인계 `base:` → Repo의 로컬 `agentkit.base` → origin/HEAD → main/master 후보. 진행 중 기존 작업도 합의한 인계와 실제 착수 기준으로 한 번 준비한다. 커밋 없는 저장소의 기준 커밋은 init.ps1(전체 실행)이 만든다.
  - 작업자 기본 실행 → 설계자 `-Accept` 재실행 → 작업자 제출 직전 `-CheckAccepted`. critical 수락은 검토 보고의 `-ReviewedCommit <전체 해시>`(필요 시 `-ReviewReport <경로>`로 검토 판정·경로를 `accepted.json`에 보존)도 준다. 최신 worker PASS(`kind: verify`)·검토·수락·제출 tip이 같아야 한다. 기본/Accept 재실행은 기존 수락을 무효화하므로 재수락한다. 인계·base를 바꾸면 설계자가 재검토 후 -Prepare하고 검증·필요한 검토부터 다시 한다.
  - 각 실행 증거는 `handoff/<ID>/verify/runs/<실행>/`에 보존한다. `verify/`는 최신 보기라 검토에는 summary의 OUT 경로를 준다. `-Prepare`는 `SPEC.md` 해시도 기록해 변경 시 `SPEC-CHANGED`로 알리고, `handoff/<ID>/evidence/` 파일의 해시·시각은 `evidence.json`·`run.json`에 남긴다(`HEAD` 커밋보다 오래된 증거는 `WARN`). `test-changes.txt`는 기존 테스트 수정·삭제, skip(`@Disabled`·`test.skip` 등), 단언 삭제 신호를 세고 신규 테스트 파일 추가는 별도로 표기한다(의미상 단언 약화를 모두 탐지하지는 않는다). 설계자는 수락 때 신호가 있으면 해당 diff와 변경 이유를 본다.
  - 마지막 RESULT는 PASS/FAIL/NONE, 코드 0/1/3(사용 오류 2, 실행한 검사 명령 실패는 그 코드). Prepare PASS는 기준 저장, CheckAccepted PASS는 로컬 tip 대조이며 테스트 성공이 아니다. PR 원격 head는 별도 대조한다. Prepare/CheckAccepted 출력은 작업 보고에 남긴다.
  - 바뀌지 않은 일을 건너뛰거나 테스트가 실행되지 않은 출력(Gradle `UP-TO-DATE`·`FROM-CACHE`·`SKIPPED`·`NO-SOURCE` 및 실행 태스크 0개 요약, Go 전체 `(cached)`, `Tests are skipped`/`No tests found`/`collected 0 items`)은 실행 근거가 아니라 실패다. 검사 명령이 다시 실행하게 쓴다(예: `--rerun-tasks`).
  - 검증 전후 미커밋·미추적 소스/숨긴 추적 파일·Git 오류·검사 중 HEAD/추적 파일 변경은 실패다. 생성물은 .gitignore 또는 로컬 info/exclude에 구체적으로 지정한다. 모든 미추적 파일을 무시하지 않는다. 현재 작업 폴더를 검사하므로 ignored 파일/환경 영향은 남는다.
  - `verify: -`와 비Git은 자동 PASS로 받지 않는다. 설계자가 조건별 방법·증거를 직접 확인하고 수락 기록(`handoff/<ID>-report.md` 또는 제출 지시 메시지)에 Git이면 전체 commit, 비Git이면 산출물 경로·해시와 복구 위치를 적는다. 작업자는 제출 직전 그 식별자를 다시 대조한다. Git direct/local 통합은 --ff-only, 추가 commit이 필요하면 검증·수락을 다시 한다.
- 훅: hooks/guard.mjs(Claude `~/.claude/settings.json` PreToolUse, Codex `~/.codex/hooks.json`, Antigravity `~/.gemini/config/hooks.json`에 등록; `install.ps1`로 일괄 치환·병합 가능), hooks/pre-push(init.ps1이 저장소마다 `.git/hooks/pre-push`로 설치). 9절.
- 스킬 원본: `<agent-kit>/skills/` (`install.ps1`로 3사 글로벌 스킬 일괄 연결·갱신 가능). `~/.claude/skills/<이름>`과 `~/.agents/skills/<이름>`(Codex)은 이 폴더를 가리키는 디렉터리 정션(Windows `cmd /c mklink /J`) 또는 심볼릭 링크(macOS·Linux `ln -s`)다. Windows 정션은 `cmd /c rmdir <정션 경로>`로만 지운다(`rm -rf`·`Remove-Item -Recurse`는 원본까지 지운다). `~/.claude/skills/synced`는 건드리지 않는다. Antigravity는 정션을 따라가지 않으므로 `~/.gemini/config/skills/<이름>/SKILL.md`에 설명과 "원본을 읽고 따르라" 한 줄만 둔 실제 파일을 둔다(스킬의 description을 고치면 `install.ps1`을 다시 실행하거나 이 파일의 description도 고친다).
- 회귀 테스트: `node hooks/guard.test.mjs`, `node hooks/pre-push.test.mjs`, `node verify.test.mjs`, `node cleanup.test.mjs`, `node update-tools.test.mjs`, `node install.test.mjs`. 훅·init.ps1·install.ps1·verify.ps1·cleanup.ps1·update-tools.ps1을 고치면 돌린다.
- agent-kit은 git 저장소다. 고칠 때 사본 백업을 만들지 말고 커밋한다.
- 도움말에 없는 옵션은 쓰지 않는다.

## 2. hc 대기·읽기
- `hc wait`의 timeout(기본 180초)은 실패가 아니다. 대기와 멈추는 조건은 위임 스킬 5절·worker.md 2절에 있다.
- 같은 대상을 동시에 wait하지 않는다. `hc ls`를 반복해 상태를 보지 않는다.
- 화면은 정체 근거(blocked·error, done인데 보고 없음, 명시적 오류)가 있을 때와 띄운 쪽 파일이 정한 timeout 확인 때만 `hc read <터미널 이름·주소> --lines 0`으로 한 번 읽는다. `hc read`에는 증분 기능이 없다(`--lines N`은 화면 위 이력 N줄).

## 3. hc 보고·전송
- 대상은 터미널 주소(`t2j`)나 이름(`task-shop-t01`)이다. 작업 ID(`T01`)를 그대로 쓰지 않는다.
- `hc run --name`은 소문자·숫자·`-_.` 1~32자만 받는다. 대문자와 터미널 주소 모양(`t01` 단독)은 거부된다. 이름은 PC 전체에서 하나라 다른 프로젝트의 살아 있는 터미널과 겹치면 실행이 실패한다. 그래서 프로젝트 약칭 `<p>`와 소문자 작업 ID를 넣는다: 작업자 `task-<p>-<id>`, 검토·조사 `sub-<p>-<id>-<review|research>-<n>`(예: 폴더 `My_Shop`, T01 → `task-myshop-t01`, `sub-myshop-t01-review-1`). `<p>`는 AGENTS.md의 'hc 이름 약칭'이다. init.ps1이 폴더 이름을 소문자로 바꿔 영문·숫자만 남긴 앞 6자로 정하고, 3자보다 짧으면(한글 이름 등) 경로 해시 글자를 붙인다. 그 줄이 없는 기존 프로젝트는 같은 규칙으로 정해(짧으면 소문자 영문을 더해 6자로) AGENTS.md에 그 줄을 더한다. 32자를 넘지 않게 검토·조사 이름의 id 자리는 10자 이내로 쓴다.
- `hc send <t> "<내용>"` 뒤 입력창에 남으면 `hc keys <t> enter`를 한 번 누른다. `hc send`가 실패해도 이미 도착했을 수 있으니 다시 보내기 전에 `hc read <t> --lines 0`으로 한 번 읽는다. 같은 대상에 동일한 메시지를 반복 보내거나 연타하는 루프는 `guard.mjs`가 차단한다.
- 프롬프트·작업 인계·자료 발췌에서 요청·배정·실행한 사람, 모델, 세션 ID, 별칭을 생략한다. 작업 ID와 프로젝트 약칭은 작업·보고 파일 경로에 쓴다. Herdr의 `parent`와 터미널 이름·주소는 로컬 상태·대기·정리에만 쓴다.
- Herdr는 `hc send`에 자체 발신자 태그를 붙일 수 있다. 사용자가 태그와 자동 알림을 끄려면 `%APPDATA%/herdr-core/config.toml`(Linux는 `~/.config/herdr-core/config.toml`)에 `notes = false`를 둔다. 이 설정과 무관하게 위임 프롬프트 본문에는 발신자를 쓰지 않는다. 질문과 결과는 보고 파일에서 읽고 `hc wait`로 턴 종료를 확인한다.
- 실행 인자·이름은 ASCII로 쓴다(Windows에서 한글 인자는 깨질 수 있다). 한글 지시는 파일에 쓰고 경로를 넘긴다.
- Claude의 `--add-dir`는 가변 인자라 바로 뒤의 프롬프트까지 디렉터리로 먹는다. 프롬프트 앞에 `'--'`를 둔다: `claude … --add-dir <폴더> '--' "Read …"`. 처음 여는 추가 폴더는 `dontAsk`여도 신뢰 확인 창(기본 선택 'No, exit')을 띄우므로, 하위 세션에 다른 프로젝트 자료가 필요하면 사본을 `handoff/<stem>/`에 넣는다.
- 실행 명령의 `--`는 작은따옴표로 감싼 `'--'`로 쓴다. 넘어가는 값은 같지만, Codex는 맨 `--`가 든 PowerShell 명령을 나누지 못해 허용 규칙(`~/.codex/rules`)을 적용하지 않고 샌드박스 안에서 실행하다 실패한 뒤 승인을 묻는다. agy의 `--add-dir`는 값 하나씩 받는다.

## 4. Antigravity 실행
- 실행·입력은 다른 도구와 마찬가지로 `hc run`·`hc send`·`hc keys`·`hc wait`·`hc read`를 직접 쓴다(다른 AGY 세션이 `working` 상태여도 강제 차단하지 않는다).
- 모드별 동작: `plan`은 셸 명령·파일 쓰기·브라우저(MCP)를 모두 묻고 승인하면 실행한다. 모드를 주지 않으면 `auto`로 시작하므로 검토·조사 세션은 반드시 `--mode plan`을 준다. `accept-edits`는 쓰지 않는다. `auto`는 작업자(`task-<id>`)에만 쓴다(그 밖의 `auto` 실행은 `guard.mjs`가 차단한다).
- `plan` 세션의 허용·거부는 `--settings <파일>`(UTF-8, BOM 없음)로 그 세션에만 준다(규칙 `read_file()`·`write_file()`·`command()`·`mcp()`·`read_url()`·`execute_url()`, 거부 > 물음 > 허용). 샌드박스 밖 실행은 기존 절차대로 승인한다.
- 호출 간격·무한 루프 방지(`guard.mjs` 기록 파일 `%LOCALAPPDATA%/agent-kit/hc-rate.json`, 최근 60분 보관):
  - **AGY 실행 간격·상한**: 직전 AGY 실행 후 **최소 30초** 간격을 두고, 최근 10분 내 6회·60분 내 20회를 넘기면 차단한다. 한 번에 맡길 수 있는 일은 작업 파일 하나에 묶어 동시 다발 실행을 피한다.
  - **공통 무한 루프 방지**: 모든 도구 공통으로 같은 이름의 `hc run` 10분 내 3회 초과·전체 `hc run` 10분 내 12회 초과, 같은 대상에 동일한 `hc send` 10분 내 3회째·단기 `hc send`(1분 내 3회 / 10분 내 8회 초과), 같은 대상에 `hc keys` 2분 내 10회 초과는 차단한다.
  - 실제 한도·인증·정책 경고나 전달 불명일 때는 재시도를 반복하지 말고 중단해 사용자에게 보고한다.
- Antigravity와 작업자 세션에는 출력 전용 모드(`-p`)는 쓰지 않는다(승인 창이 없는 Claude·Codex 단발성 검토의 비대화형 실행은 비교 시험 후 도입한다).
- 처음 여는 폴더는 신뢰 확인을 한 번 묻는다. 작업 폴더 밖 파일은 `--add-dir`로 넘기고(홈 폴더처럼 넓은 범위는 넘기지 않는다), 그래도 "outside workspace" 승인을 물을 수 있다.
- 새로 등록한 MCP 서버는 agy를 새로 시작해야 로드된다. Notion은 원격 MCP `notion-remote`(OAuth)를 쓴다. 토큰을 설정 파일·환경 변수에 두지 않는다.

## 5. 병렬 Git 작업 (worktree)
- 같은 폴더에서 두 작업자가 동시에 checkout·commit·빌드하면 브랜치가 바뀌거나 `.git/index.lock` 충돌이 난다. 병렬 작업은 worktree로 나눈다.
- 위치는 저장소 루트의 `.worktrees/<소문자 id>` 하나다. 설계자는 인계 머리말 `worktree`에 폴더·브랜치만 적고 작업자를 프로젝트 폴더(`--cwd`)에서 띄운다.
- 작업자가 시작할 때 저장소 루트에서 `git worktree add .worktrees/<소문자 id> -b <브랜치>`로 만든다(이미 있으면 그대로 쓴다). 프로젝트 폴더가 Git이 아니고 하위 폴더가 저장소면 그 하위 폴더가 저장소 루트다.
- worktree에는 커밋된 파일만 있다. Git 작업은 worktree에서 하고, 지침·인계·보고·`handoff/<ID>/` 산출물·SPEC.md·SESSION_HANDOFF.md는 프로젝트 폴더의 것을 읽고 쓴다.
- 설계자는 생성 전 worktree 경로로 -Prepare할 수 있다(같은 저장소 아래 경로). 작업자는 생성 뒤 검증·제출 대조에도 `-Project <프로젝트 폴더> -Repo <worktree 폴더>`를 함께 쓴다.
- merge(제출)가 확인되면 작업자가 `git worktree remove .worktrees/<소문자 id>`로 지운다.

## 6. Herdr
- 패널에는 설계자와 작업별 작업자만 띄운다. 검토·조사 세션은 패널에 띄우지 않는다(왼쪽 Agents에서 띄운 세션 아래 하위로 보인다).
- 사용자의 스페이스·탭·세션을 닫지 않고, 사용자 터미널에 명령을 보내지 않는다.

## 7. 확인된 제약
- Codex는 `--no-daemon` 없이 띄우면 명령이 hc 밖의 공유 서버에서 실행되어, 띄운 세션이 hc 자식으로 잡히지 않는다(대기·보고가 동작하지 않는다).
- Antigravity는 `agy --help`에 없는 `hooks.json`을 읽는다(전역 `~/.gemini/config/hooks.json`, 프로젝트 `.agents/hooks.json`). 훅 명령은 `cmd /c`로 실행된다. 키트의 훅 명령은 공백 없는 절대 경로를 따옴표 없이 쓴다.
- Antigravity 전역 설정: 터미널 샌드박스 켬, 작업 폴더 밖 파일 접근은 물음.
- Codex의 Windows 샌드박스 방식은 `~/.codex/config.toml`의 `[windows] sandbox`에 있다(지금 `elevated`). 방식은 사용자가 고른다.

## 9. 훅
- 훅은 도구가 동작 직전에 실행하는 프로그램이고 거부하면 그 동작이 취소된다. **실수를 막는 장치이지 강제 수단이 아니다.** 명령 글자를 보므로 모양을 바꾸면 통과한다. 강제가 필요한 것은 권한으로 막는다(서버 쪽 브랜치 보호, merge 권한이 없는 토큰, 도구의 deny 규칙, 비밀을 작업 폴더에 두지 않기).
- guard가 막는 것: 비밀 파일 읽기·편집(`.env` 계열, 키·인증서·키스토어, 자격증명 파일, 인라인 인터프리터 스크립트 포함) / 테스트 계정·쿠키(`*cookies.txt`·`*.cookies`)·브라우저 저장 상태 파일 열람·복사 / 프로젝트 정책이 막는 push와 pre-push 건너뛰기(`--no-verify`, `core.hooksPath`, `GIT_CONFIG_*`, `send-pack`) / 권한 우회 플래그 / 저장소의 `.git/hooks`·`.git/config`·검증 승인 증거(`handoff/<ID>/approved.json`·`accepted.json`·`approvals/`·`verify/`) 직접 변경 / 일반 프로젝트 세션에서의 `agent-kit/**` 및 전역·로컬 에이전트 권한·훅 설정 파일(`.claude/`·`.codex/`·`.gemini/`·`.agents/hooks.json`) 변경 / 전 도구 하위 세션(`sub-*`)의 `hc` 제어·`verify.ps1`·`init.ps1` 실행 / 작업자 세션(`task-*`·`.worktrees/`)의 다른 작업자 실행, `verify.ps1 -Prepare`/`-Accept`, `init.ps1` 정책 변경, 직계 자식 외 터미널 제어 / `--no-daemon` 없는 `hc run ... codex`, 누적 4회를 넘는 검토 실행(`-review-5` 이상), 수동 인계 정책(`agentkit.crossAgentMode=manual`)이 막는 `hc run`/`hc send`/`hc keys`.
- AGY 호출 간격·무한 루프 안전장치: `guard.mjs`는 다른 AGY가 `working` 상태여도 실행을 막지 않되, 직전 AGY 실행 후 30초 미만 연타와 10분 6회·60분 20회 상한, 그리고 `hc run`·`hc send`·`hc keys`의 반복 루프·단기 폭주를 차단한다(4절).
- Antigravity 검토 세션(`Read <작업 파일 경로> and follow it.`으로 지시한 턴; 보고서 경로의 단순 언급은 제외)은 read_file과 자기 보고 파일 쓰기만 통과한다. 조사 세션은 `handoff/` 아래의 다른 인계·보고·verify 파일 쓰기를 막고, 모든 도구의 검토·조사 하위 세션(`sub-*` 터미널 또는 `AGENTKIT_ROLE=sub-…`)은 `hc` 세션 실행·제어(`run`·`send`·`keys`·`interrupt`·`kill`·`rm`)와 `verify.ps1`·`init.ps1` 실행을 막는다.
- 남는 범위: 훅이 적용되지 않는 도구·스크립트·템플릿의 내부 명령, 터미널 이름이 조회 후 바뀌는 경우, Herdr 밖의 사용자 입력(`AGENTKIT_ROLE` 미설정 시 Claude·Codex 수동 세션의 역할 판별 포함)은 이 훅 검사 밖에 있다. 재귀 검색·와일드카드 출력, 복잡한 스크립트·인터프리터 내부 파일 접근, `gh api` 원격 변경에도 기존 한계가 있다.
- 등록 구성: Claude(`~/.claude/settings.json`), Antigravity(`~/.gemini/config/hooks.json`), Codex(`~/.codex/hooks.json`)의 PreToolUse에 `node <agent-kit>/hooks/guard.mjs`를 등록한다(`hooks/agy-hooks.json`·`hooks/codex-hooks.json` 템플릿의 `<agent-kit>`을 실제 슬래시 경로로 반드시 치환해 병합·복사한다; 미치환 `<agent-kit>`을 그대로 넣으면 훅이 실패하거나 `guard.mjs`가 거부한다). Codex에서 승인 창을 줄이려면 `~/.codex/rules/default.rules`에 허용 규칙 세 줄을 둘 수 있다(사용자 승인): `prefix_rule(pattern=["hc"], decision="allow")`, 그리고 `["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "<agent-kit>/init.ps1"]`·같은 형태의 `verify.ps1` 접두사 허용. 이 규칙은 모든 Codex 세션에 걸리지만, `guard.mjs`가 하위 검토·조사(`sub-*`) 및 작업자(`task-*`) 세션의 금지 호출을 차단한다. Codex는 훅을 세션 셸(`powershell -Command`)로 실행해 exit 2가 1로 바뀌고 1은 차단으로 치지 않으므로, guard는 PreToolUse 이벤트를 stdout의 `hookSpecificOutput.permissionDecision="deny"` JSON과 exit 0으로 막는다(Claude도 같은 형식을 따른다). `hooks/agy-hooks.json`·`hooks/codex-hooks.json`을 바꾸면 `<agent-kit>`을 치환해 전역 파일에 다시 반영한다.
- 제출·호출 정책은 합의 후 `init.ps1 -GitSetup -Target <저장소 루트> -Submission <pr|direct|local> [-ProtectedBranches <CSV>] [-Base <ref>] [-CrossAgentMode <auto|manual>] [-MaxVerifyFailures <int>]`로 로컬 Git 설정에 둔다. pr은 보호 브랜치 직접 push 차단, direct는 기본 보호는 없되 승인된 작업(`approved.json`)이 있는 저장소의 기본 브랜치 push에는 `pre-push` 훅이 `accepted.json`의 수락 커밋 일치를 확인한다(명시 보호 가능), local은 모든 push 차단이다. `CrossAgentMode=manual`은 모든 `hc run`/`send`/`keys`를 막고 파일 인계만 쓰게 한다. `MaxVerifyFailures`(기본 5, 0은 무제한)는 동일 승인(`approval`) 기준에서 `verify.ps1` 실패가 누적됐을 때 추가 실행을 멈춘다(설계자가 `-Prepare`를 다시 돌리면 초기화). 옵션을 생략하면 기존 설정을 보존한다. 정책은 init.ps1로만 쓰며 작업자가 임의 변경하지 않는다.
- 병렬 작업자를 처음 띄우게 된 `direct` 저장소는 띄우기 전에 `-Submission pr -ProtectedBranches <지금 보호 목록과 대상 브랜치를 합친 값>`으로 바꾼다(POLICY가 FAILED면 띄우지 않는다). `SPEC.md` '제약'에서 병렬 시 `pr` 자동 전환을 미리 위임했고 제출자가 바뀌지 않으면 적용·문서 갱신 뒤 사용자에게 알리고, 위임하지 않았거나 제출자가 바뀌면 먼저 사용자에게 묻는다.
- guard와 pre-push가 같은 정책을 읽는다. 미선택 새 저장소에는 훅을 설치하지 않고 보고한다. 정책 없는 기존 훅/guard는 main·master 기본을 유지한다. 기존 다른 pre-push나 core.hooksPath는 덮어쓰지 않는다. 기존 프로젝트는 합의한 정책으로 -GitSetup을 다시 실행한다.
- 훅에 막히면 우회하거나 훅을 고치지 말고 보고한다. 오탐 수정은 사용자가 지시한 세션에서 하고 회귀 테스트를 돌린 뒤 커밋한다.

## 10. 세션·저장소 관리
- 작업자는 인계 하나에 세션 하나다. 설계자는 작업 묶음이 끝나면(도구의 자동 컨텍스트 압축이 발동해 스펙 맥락이 흐려지기 전에 `SPEC.md`·`SESSION_HANDOFF.md`를 갱신하고) 새 세션으로 시작해도 된다.
- 설계자 세션이 바뀌면 `handoff/<ID>-report.md`에서 진행 상태를 읽는다. 자동 인계로 시작한 작업자는 `hc ls`에서 `task-<p>-<id>`를 한 번 찾아 `hc wait task-<p>-<id> --timeout 600`으로 기다린다(이전 자식은 새 세션의 `--children`에 잡히지 않는다). 기존 승인된 인계는 그대로 둔다. 예전 인계에 보고 주소가 있어도 새 프롬프트에 옮기지 않는다.
- 작업자·검토 세션이 한도·인증·종료로 멈췄으면 사용자에게 알리고 재개할 시점·세션·도구를 정한다(한도가 풀린 뒤 같은 세션에 이어가기 `hc send` / 같은 인계로 새 작업자 세션 / 역할 표의 다른 도구). 새 작업자는 WORKER.md '시작'의 재개 규칙을 따른다. 원인이 해결됐고 실제 검토 시작 전 실패한 것이 확인되면 같은 작업 파일과 stem을 쓴다.
- 자동 삭제는 쓰지 않는다(Claude `cleanupPeriodDays` 36500. 0은 기록을 즉시 지우므로 쓰지 않는다).
- 정리는 사용자가 요청할 때만 한다. 절차는 skills/agent-session-cleanup/SKILL.md, 스크립트는 cleanup.ps1.
  - "하위 세션 정리해": 요청받은 세션이 자기가 띄운 자식의 터미널·대화 기록·`handoff/sub-…` 임시 파일을 지운다(정리 스킬 0절). 작업 중(working·blocked)인 자식은 남긴다. Codex 자식의 대화 기록은 자동으로 찾지 않는다.
  - "세션 정리해": PC 전체를 기간 기준으로 목록을 만들고 사용자가 승인한 것만 휴지통으로 보낸다(정리 스킬 1~3절). hc 그룹만은 기간과 상관없이 끝난 터미널 전부다.
- 저장 위치: Claude `~/.claude/projects`·`file-history`·`session-env` / Codex `~/.codex/sessions`·`archived_sessions` / Antigravity `~/.gemini/antigravity{,-cli}`의 `conversations`·`brain`·`cache`·`crashes`·`log`·`scratch`.
- 지우지 않는다: Antigravity `bin`·`builtin`·`lib`·`settings.json`·`mcp_oauth_tokens.json`·`installation_id`·`conversation_summaries.db`, Claude `memory/`, Codex `auth.json`·`config.toml`·`*.sqlite`. 경로를 통째로 지우는 정리는 하지 않는다.

## 11. 기존 프로젝트에 템플릿 병합
init.ps1 출력의 `SKIPPED`에 파일이 있으면 이미 지침 파일이 있는 프로젝트다(`init.ps1`을 한 번 실행하면 기존 파일 안의 미치환 `<agent-kit>`·`<default-*>`·`<hc-prefix>`와 옛 `skills/antigravity-delegate/` 경로는 자동으로 갱신되고 `UPDATED:` 줄로 표시된다). 템플릿 본문까지 병합할 때는 설계자가 직접 하지 말고 작업자에게 맡긴다.
1. `handoff/_TEMPLATE.md` 형식으로 `handoff/T00.md`를 쓴다(`id: T00`, `review: normal`, `verify: -`).
   - 목표: "먼저 agent-roles/WORKER.md를 읽는다. <agent-kit>/templates 기준으로 SKIPPED 파일의 충돌·중복·낡은 규칙을 정리하고 프로젝트 고유 규칙은 남긴다. 옛 CODEX.md와 역할별 규칙은 agent-roles/로 옮긴다. DECISION_LOG.md가 있으면 내용을 SPEC.md '결정'으로 옮긴다. AGENTS.md의 프로젝트명·목표·역할 배정 표를 채운다. 병합 뒤 `powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/init.ps1 -Target <프로젝트 폴더>`를 한 번 실행해 `<agent-kit>`·`<hc-prefix>`·`<default-*>`와 옛 스킬 경로가 모두 실제 값으로 치환되었는지 확인한다. Git이 이미 추적 중인 지침 파일(`git ls-files`로 확인)은 직접 고치지 말고 병합 초안을 handoff/T00/에 써서 사용자 결정을 받는다. 루트의 작업 산출물은 옮기거나 지우지 말고 옮길 목록만 보고한다."
   - 사용자에게 들은 프로젝트명·목표·제출과 배포 방식·역할 배정을 본문에 적는다. 옛 양식의 `report_to` 필드가 남아 있으면 빼고 질문·작업·제출 보고는 `handoff/<ID>-report.md`에만 남기도록 맞춘다. Git 정책은 합의 후 9절의 -GitSetup으로 별도 적용한다.
2. 작업자를 띄우고 기다린다(skills/agent-delegate/worker.md. 기존 AGENTS.md에 유효한 역할 표가 없으면 `<agent-kit>/local-defaults.json`의 기본 배정 또는 사용자와 합의한 배정을 쓴다).
3. 결과를 사용자에게 보고하고, 병합된 agent-roles/DESIGNER.md를 읽고 설계를 이어간다.

## 12. 에이전트 카탈로그·역할 교체
역할은 고정이고 에이전트는 바꿀 수 있다. 프로젝트 AGENTS.md 역할 배정 표의 행만 바꾼다(새 프로젝트의 로컬 기본값을 바꾸려면 `<agent-kit>/local-defaults.json`).

역할이 도구에 요구하는 것(어느 도구든 이것을 채우면 그 역할을 맡을 수 있다):
- 설계자: 자식 세션을 띄우고 기다리고 메시지를 주고받을 수 있다(hc, 수동 인계 모드면 파일 인계) / 코드를 읽을 수 있다 / 프로젝트의 지침·스펙·인계 파일을 쓸 수 있다.
- 작업자: 작업 폴더에 쓰고 빌드·테스트·git 명령을 승인 창 없이 실행한다 / 설계자에게 보고를 보내고 검토 세션을 띄울 수 있다(hc, 수동 인계 모드면 파일 보고) / 원격에 push하고 PR을 만들 수 있다 / 그 밖의 위험한 동작은 여전히 묻거나 막힌다.
- 검토자: 띄운 쪽의 대화를 물려받지 않는다 / 읽기와 자기 보고 파일 쓰기만 되고, 그 밖은 지침이 아니라 설정으로 막힌다.

띄우는 명령은 skills/agent-delegate/SKILL.md 4절(작업자는 같은 폴더 worker.md)에 역할·도구 칸별로 있다. 아래는 칸마다 확인된 상태다.

| 에이전트 | 자동으로 읽는 파일 | 설계자 | 작업자 | 검토자·조사 | guard 훅 | 스킬 |
|---|---|---|---|---|---|---|
| Codex | AGENTS.md | 확인(`codex --no-daemon`으로 시작) | 일부 확인(쓰기·테스트는 됨. git 명령과 `hc`마다 승인 창이 떠서 설계자가 처리한다. `git push`·`gh`는 확인하지 않음) | 일부 확인(검토: 승인 창 없이 `handoff/<stem>/`에 보고까지 된다. 쓰기는 그 폴더만 허용되며 `guard.mjs`가 `hc`·`verify.ps1`·`init.ps1`을 차단한다. 샌드박스 안 읽기 셸은 허용. MCP·`apply_patch` 차단은 미시험. 조사: 스킬 4절 미지원) | 있음(9절, `apply_patch` 실세션은 미시험) | `~/.agents/skills` 정션 |
| Claude | CLAUDE.md(`@AGENTS.md`) | 확인(Herdr 패널에서 `claude`로 시작. 자식 실행·대기가 된다) | 확인(네이티브 Windows 호스트 셸, OS 격리 없음·분류기 승인; 외부 의존성·운영 자격증명 중요 작업은 WSL2 등 격리 환경 고려) | 확인(검토는 읽기와 자기 보고 파일 쓰기만, 조사는 `WebSearch` 무승인·`WebFetch` 승인 분리. 셸·브라우저 조작 없음. `--tools`는 MCP를 닫지 않으므로 주의) | 있음 | `~/.claude/skills` 정션 |
| Antigravity | GEMINI.md | 확인(실사용 완료; `hc run`·`send`·`keys` 직접 호출) | auto 모드에서 쓰기·로컬 명령 확인. `git push`·`gh`는 미검증 | 기존 plan 모드와 세션 전용 설정(`read_file(*)` 시스템 읽기 범위 주의). 검토·조사 실행은 4절 | 있음 | `~/.gemini/config/skills`의 연결 파일(1절) |

바꿀 때 확인할 것(걸리는 항목은 사용자에게 알리고 SPEC.md '결정'에 남긴다):
1. 확인하지 않은 칸이면 그 도구의 세션에게 위 요구를 주고 자기 도움말·문서에서 실행 명령과 설정을 찾게 한다(원칙 12). AGY 시험은 4절에 따라 진행한다. 검토자는 자기 보고 파일 밖 쓰기·셸·MCP 쓰기 도구가 막히는지, 작업자는 보고 파일과 검증 근거를 남기는지 확인한 뒤 스킬 4절과 표에 적는다. 도움말에 없는 옵션과 권한 우회 옵션은 쓰지 않는다.
2. guard 훅이 없거나 확인되지 않은 에이전트를 설계자·작업자로 두면 비밀 파일·우회 플래그 차단이 문장 규칙뿐이다. 사용자 확인이 필요하다.
3. 검토자·조사 행에는 검토와 조사에 다른 도구를 적을 수 있다(예: 검토 Claude / 조사 Antigravity). 각 도구는 맡은 역할이 위 표에서 확인돼 있어야 한다. 자동 실행한 작업자는 `hc run` 결과의 parent로 로컬에서 추적한다. 수동 인계는 작업·보고 파일로 추적한다.

## 13. 테스트 자격증명·브라우저
- 테스트 계정·쿠키·브라우저 저장 상태 파일(`test-accounts*.json`·`*-test-accounts*.json`·`*cookies.txt`·`*.cookies`·`*storage-state*.json`)은 `handoff/<ID>/` 안에 만들고 테스트 도구의 인자(curl `-b`·`-c`, node·python 테스트 스크립트)로만 쓴다. 내용을 열어 보거나 복사하거나 보고에 옮겨 적지 않는다(guard가 열람·복사를 막는다).
- HTTP 응답(`curl -i` 등)을 증거 파일에 남길 때는 `Set-Cookie`·`Cookie`·`Authorization` 헤더 값을 마스킹한다. 테스트 계정·임시 컨테이너·브라우저 저장 상태는 작업 수락·제출이 끝나면 폐기한다.
- 권한(인가) 테스트는 격리된 테스트 환경에서 계정 A가 계정 B의 리소스에 접근하지 못하는지 확인한다. 그런 환경이 없으면 실행하지 않았다고 적는다.
- 브라우저 프로필은 `~/.cache/agent-browser/<프로젝트명>/`에 둔다(다른 작업이 쓰고 있어 열리지 않으면 `<프로젝트명>-<소문자 ID>`).
- 운영 사이트는 읽기 전용으로만 확인한다.

## 14. 도구가 업데이트됐을 때
이 키트가 전제로 삼는 도구 동작이 바뀌었는지, 새 기능이 키트의 일부를 대신할 수 있는지를 여기 절차로 확인한다.
- 알아채기: `powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/check-tools.ps1`이 설치된 버전을 `tool-versions.txt`(마지막으로 확인한 버전)와 비교해 `TOOLS: OK` 또는 `TOOLS: CHANGED …` 한 줄을 낸다. init.ps1도 끝에 이 줄을 내므로 프로젝트를 시작하거나 저장소를 준비할 때 드러난다. `CHANGED`를 본 세션은 사용자에게 알리기만 하고 하던 일을 계속한다. 아래 확인은 사용자가 "도구 업데이트 반영해"라고 할 때 한다.
- 1. 무엇이 바뀌었는지 읽는다: 각 도구의 공식 변경 내역과 `agy --help`·`claude --help`·`codex --help`·`hc --help`. 바뀐 버전 구간만 본다.
- 2. 이 키트가 전제로 삼는 도구 동작을 다시 확인한다(바뀐 도구 것만). 자기 도구가 아니면 그 도구의 세션에 확인시킨다(원칙 12).
  - Antigravity: 4절의 순서로 `--mode plan`의 승인·훅과 배정 모델을 확인한다. 실행 명령의 옵션(`--mode`·`--sandbox`·`--settings`·`--log-file`·`--add-dir`·`--model`)은 `agy --help`에서 확인한다.
  - Claude: 실행 명령의 옵션(`--model`·`--permission-mode auto|dontAsk`·`--tools`·`--allowedTools`·`--add-dir`)이 도움말에 있는가 / guard가 막는지(가짜 `.env` 경로를 Read해 본다).
  - Codex: `--no-daemon`·`-m`·`-c`가 도움말에 있는가 / 훅 등록 형식 / `[windows] sandbox` 값 / 검토 칸의 권한 프로필 키(`default_permissions`·`permissions.<이름>.filesystem`).
  - hc: `run`·`wait`·`send`·`keys`·`read`·`ls`·`get`의 옵션과 JSON 출력 형태.
  - 어긋난 것은 RUNBOOK의 해당 절, 스킬의 실행 명령, `local-defaults.json`(및 필요한 경우 `templates/AGENTS.md`)을 고친다. 훅이 걸리면 1절의 전체 회귀 테스트를 돌리고 실제 연결에서 1턴 완료를 짧게 점검한다.
- 3. 새 기능을 본다(PRINCIPLES.md 원칙 2). 새 모델, 내장 서브에이전트·오케스트레이션, 플러그인·스킬 기능이 키트의 무엇을 대신하거나 줄일 수 있는지 한두 줄로 적어 사용자에게 제안한다. 바로 바꾸지 않는다: 사용자가 고르면 한 프로젝트에서 시험한 뒤 반영한다. 판단 기준은 목적(설계자와의 대화, 맥락 없는 빈틈 검토)에 직접 쓰이는가, 지금보다 가벼워지는가, 맥락 없는 별도 세션이라는 격리를 잃지 않는가.
- 승인 범위: 옵션 이름·경로·같은 등급의 후속 모델 ID처럼 판단할 것이 없는 수정은 사용자에게 묻지 않고 고친 뒤 요약만 알린다. 기본 배정(모델·역할의 도구)은 사용자가 정한다. 사용자가 바꾸자고 했거나 지금 모델이 없어졌을 때만 바꾸고, 바꾸기 전에 probes/README.md의 시험이 합격선을 넘는지 확인한다. 사용자 승인을 받는 것은 셋이다: 승인·권한·훅 동작이 바뀌었는데 같은 효과를 내는 명시 옵션이 없을 때 / 검토 방식을 바꿀 때 / 비용이 크게 느는 기능을 쓸 때.
- 4. 끝나면 `check-tools.ps1 -Accept`로 버전을 기록하고 커밋한다. 커밋 메시지에 무엇을 확인했고 무엇을 바꿨는지 적는다.

## 15. 작업별 맞춤 하네스와 실패 시 하네스 수정
작업 하네스(이 작업의 인계 제약·단계·검증 명령·저장소 내 전용 검증 스크립트·픽스처)를 작업 성격에 맞게 조립하고, 실패가 반복될 때는 코드만 무작정 다시 고치지 않고 작업 하네스 결함부터 점검·수정한다.
- **불변 경계**: 전역 `agent-kit` 원본, `hooks/guard.mjs`, `hooks/pre-push`, 전역·프로젝트 에이전트 권한/훅 설정은 작업 중 절대 수정하지 않는다.
- **A. 착수 전 작업별 맞춤 하네스 조립 (조건부 — 큰 작업·`critical` 작업 중 기존 테스트만으로 판정이 어려울 때만)**:
  - 설계자는 코드를 직접 쓰지 않는다(원칙·목적 1). 기존 테스트만으로 인수 조건을 판정하기 어려운 경우(DB 마이그레이션 롤백, API 계약·인가 경계, 배포·E2E 등)에만 인계의 `## 단계` 첫 단계나 별도 선행 작업으로 **작업자가 저장소 안에 전용 검증 스크립트·픽스처를 작성·커밋**하게 지정하고 이를 `verify` 명령이나 수동 검증 절차에 연결한다.
  - 검증 스크립트·픽스처는 `handoff/<ID>/`에 두지 않는다(`/handoff/`는 Git 제외 경로라 `diff.patch`·`test-changes.txt`·해시 고정에서 누락된다).
  - 도메인 특화 주의점·금지 함정·점검 항목은 별도 파일로 빼지 않고 **`handoff/<ID>.md` 본문(`하지 않을 것·제약`·`인수 조건`·`참고`)에 직접 적어** `-Prepare` 해시에 고정하고 작업자가 시작 때 반드시 읽게 한다.
  - 작은 일반 작업에는 별도 스캐폴딩을 만들지 않는다(원칙 1·7).
- **B. 실패 시 작업 하네스 수정 (평소 추가 호출 0, 막혔을 때만 발동)**:
  - 발동 조건: 작업자가 **원인이 같은 `verify` 실패를 2회 연속** 겪거나 `MaxVerifyFailures`에 도달했을 때, 또는 완료 전 검토에서 **재검토 1회 뒤에도 같은 `높음` 지적**이 남았을 때.
  - 1. 설계자가 `handoff/<ID>/verify/runs/` 실패 출력과 `handoff/<ID>-report.md`를 읽고, **코드 실수인지 작업 하네스 결함인지**(모호한 제약, 빠진 검증 스크립트·픽스처, 과도한 작업 범위, 잘못된 `verify` 명령·환경 전제) 먼저 가른다.
  - 2. 하네스 결함이면 무작정 재시도를 시키지 않고 `handoff/<ID>.md`(제약·단계·`verify` 명령·주의점)를 수정한다. **작업 분할·완료 기준·인수 조건의 의미·검증 수준이 달라지면 먼저 사용자 확인**을 받고(DESIGNER 3절·원칙 5), `critical` 인계를 고치면 기존 상한(누적 `-4`) 안에서 빈틈 재검토를 거친다.
  - 3. `verify.ps1 -Id <ID> -Prepare -Base <원래 approved.json의 baseCommit>`으로 원래 비교 기준을 유지한 채 수정된 인계를 다시 고정하고, 작업자에게 `"handoff updated, read it again"`을 보내 재개한다.
  - 4. **절대 상한**: **작업당 하네스 수정 1회**까지만 한다(재-`-Prepare`가 `MaxVerifyFailures` 카운터를 초기화하므로 실패 양상이 바뀌어도 사용자 승인 없이 2회째 수정·재-`-Prepare`를 하지 않는다). 수정 후에도 실패가 이어지면 재시도를 멈추고 원인·대안을 사용자에게 보고한다.
