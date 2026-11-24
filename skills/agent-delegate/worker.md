# 작업자 띄우기 — 설계자가 인계 하나를 맡길 때 이 파일만 읽는다

`<agent-kit>`은 이 키트 저장소의 슬래시(`/`) 절대 경로다.

## 1. 준비와 실행
- 도구와 모델은 프로젝트 `AGENTS.md` 역할 배정 표의 작업자 칸을 따른다(표에 없는 도구는 사용자에게 알린다, RUNBOOK 12절).
- 위임자 익명화: 프롬프트와 인계에는 일, 역할, 근거, 보고 파일 경로만 적고 요청·배정·실행한 사람, 모델, 세션 ID, 별칭은 적지 않는다.
- **병렬 `worktree` 작업 선행 준비**: 인계 머리말에 `worktree:`가 있으면 작업자를 띄우기 전에 저장소 루트에서 `git worktree add .worktrees/<소문자 id> -b <브랜치>`로 worktree를 먼저 만들고, 아래 실행의 `--cwd`(수동 인계는 실행 폴더)를 해당 worktree 경로로 지정해 메인 루트 오염을 원천 차단한다.
- **수동 인계(`agentkit.crossAgentMode=manual` 또는 `SPEC.md` 수동 인계)**:
  - 인계 작성과 `verify.ps1 -Id <ID> -Prepare`를 완료한 뒤 사용자에게 실행 폴더, 환경변수(`$env:AGENTKIT_ROLE='worker'`), 도구 실행 명령과 첫 문장을 안내한다. 결과는 `handoff/<ID>-report.md`로 받는다.
- **자동 인계(`hc run`) 공통 형식** (`<p>`는 `AGENTS.md`의 `hc 이름 약칭`, 작업 ID에 `.` 금지):
  `hc run --bg --env AGENTKIT_ROLE=worker --name task-<p>-<소문자 id> --label herdr.space=<ID> --label herdr.tab=<ID> --cwd <실행 폴더> '--' <도구 명령>`
  - **Claude**: `claude --model <모델> --permission-mode auto --allowedTools "Bash(git *),Bash(powershell *verify.ps1*),Bash(pwsh *verify.ps1*)" '--' "Read <프로젝트 폴더>/handoff/<ID>.md and follow it."`
  - **Antigravity**: `agy --model <모델> --mode auto --sandbox --log-file "<프로젝트 폴더>/handoff/task-<p>-<소문자 id>.log" -i "Read <프로젝트 폴더>/handoff/<ID>.md and follow it."` (연속 AGY 실행 시 최소 30초 간격 준수)
  - **Codex**: `codex --no-daemon [-m <모델>] "Read <프로젝트 폴더>/handoff/<ID>.md and follow it."`
- 실행 직후 반환된 `parent`가 `$env:HC_TERMINAL_ID`와 다르거나 `first_message.sent`가 `false`이면 즉시 멈추고 원인을 확인해 사용자에게 알린다.

## 2. 대기와 차단 처리 (대리 클릭 금지)
- `hc wait --children any --timeout 600`으로 기다린다. timeout이면 진행 상태를 확인하고 계속 작업 중이면 다시 wait한다(연속 3회[30분] 동안 화면 변화가 없거나 `error`·한도 소진·인증 오류가 보이면 즉시 멈추고 사용자에게 알린다).
- **대리 승인(`hc keys enter`) 금지**: 작업자가 `blocked`(폴더 신뢰 확인, 샌드박스 밖 실행, 외부 네트워크/푸시 권한 확인 등)로 멈췄을 때 `hc read task-<p>-<소문자 id> --lines 0`으로 원인을 파악하되, **설계자 AI가 `hc keys enter`로 승인 창을 대신 누르지 않는다.** 인계 범위를 벗어난 잘못된 요청이면 `hc keys task-<p>-<소문자 id> esc`로 거부한 뒤 지시를 보내고, 정당한 권한 확대·외부 작업 승인이면 사용자에게 해당 터미널 이름을 알려 직접 승인받는다.
- 작업자 질문 응답: `handoff/<ID>-report.md`에 질문이 올라오면 `hc send --wait task-<p>-<소문자 id> "<답>"`으로 답하고 같은 호출에서 턴 종료까지 기다린다(답 때문에 인계를 수정했으면 `-Prepare`를 다시 실행하고 `"handoff updated, read it again"`을 함께 보낸다).

## 3. 수락 뒤 제출 지시
- 설계자가 `verify.ps1 -Id <ID> -Accept`(수동 검증 Git 작업은 `-Accept -Manual`) 통과를 확인한 뒤 `hc send --wait task-<p>-<소문자 id> "accepted <commit 또는 산출물 해시>, submit per SPEC"`을 보낸다(사용자가 직접 PR을 merge하는 방식이면 제출 직전 `-CheckAccepted` 대조까지만 지시).
- `handoff/<ID>-report.md`에서 제출 완료 보고(`<ID> submitted ...`)를 확인한 뒤 `SESSION_HANDOFF.md`를 `done`으로 갱신한다. 끝난 작업자 터미널은 사용자가 `"하위 세션 정리해"`라고 요청할 때 정리한다.
