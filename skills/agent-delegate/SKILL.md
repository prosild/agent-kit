---
name: agent-delegate
description: "설계자나 작업자가 다른 세션에 일을 맡길 때 쓴다 — 빈틈 검토(스펙·인계 파일), 완료 전 검토(review-critical), 조사(대량 읽기·브라우저), 작업자 실행. 작업자 실행만 하면 같은 폴더의 worker.md만 읽는다. 스킬 기능이 없는 에이전트는 <agent-kit>/skills/agent-delegate/SKILL.md 를 직접 읽고 따른다."
---

# 다른 세션에 일 맡기기

`<agent-kit>`은 이 키트 저장소의 슬래시(`/`) 절대 경로다.

## 1. 무엇을 누구에게
| 일 | 맡기는 쪽 | 실행 방식 · 받는 쪽 (`AGENTS.md` 역할 배정 표 기준) |
|---|---|---|
| 빈틈 검토 (스펙·인계 파일) | 설계자 (무거운 프로젝트 설계 전체, 모든 `critical` 작업 인계) | **비대화형(헤드리스)** · 검토자(`critical` 포함 시 중요 모델, 아니면 일반 모델) |
| 완료 전 검토 | 작업자 (`review: critical` 작업), 설계자 (직접 구현한 `impl: designer` 작업) | **비대화형(헤드리스)** · `critical`은 검토자 중요 모델, 직접 구현 작업은 일반 모델 |
| 조사 (대량 읽기·긴 로그 요약) | 설계자·작업자 (현재 컨텍스트로 충분하면 맡기지 않음) | 자기 도구의 내장 읽기 전용 서브에이전트 우선. 없으면 **비대화형(헤드리스)** · 조사 일반 모델 |
| 조사 (브라우저 조작·캡처) | 설계자·작업자 | 대화형 `hc run` · Antigravity 조사 일반 모델 |
| 구현·검증·제출 (큰 작업·`critical`·병렬 작업) | 설계자 | 대화형 작업자 (`<agent-kit>/skills/agent-delegate/worker.md`) |

## 2. 이름과 상한 규칙
- 실행 이름(`stem`): `sub-<p>-<소문자 id>-<review|research>-<n>` (`<p>`는 `AGENTS.md`의 `hc 이름 약칭`; 소문자 영문·숫자·`-`·`_`만 사용하며 점 `.`은 쓰지 않는다).
  - 설계 전체 검토는 `<소문자 id>` 자리에 `design`(대규모 재설계 라운드는 `design-r2`)을 쓴다.
  - 같은 종류의 이전 실행 파일이 이미 있으면 `<n+1>`을 쓴다.
- **검토 횟수 상한(`-4`)과 작업 ID 계보 유지**:
  - 작업 하나당 검토는 빈틈 검토(최대 2회) + 완료 전 검토(최대 2회) 합계 `-review-4`까지다(`-review-5` 이상은 `guard.mjs`가 차단).
  - 상한에 닿으면 먼저 상위 세션이나 사용자에게 보고한다. 사용자가 추가 검토를 승인하면 **작업 ID(`T01`)와 작업 브랜치·의존성은 절대 바꾸지 말고**, 설계자가 인계를 보완해 `-Prepare`를 다시 실행한 뒤 검토 스템만 새 라운드 접미사(`sub-<p>-t01-r2-review-1`)로 시작한다.
- 산출물 위치: 작업 파일 `handoff/<stem>.md`, 보고서 `handoff/<stem>-report.md`(Codex 검토는 `handoff/<stem>/<stem>-report.md`), 부속 설정·임시 파일 `handoff/<stem>/`.
- 위임자 익명화: 프롬프트와 작업 파일에는 일, 역할, 근거, 보고 파일 경로만 적고 요청·배정·실행한 사람, 모델, 세션 ID, 별칭은 적지 않는다.

## 3. 작업 파일 `handoff/<stem>.md` 양식
~~~markdown
# <ID> <빈틈 검토|완료 전 검토|조사>
- 목적:
- 역할 지침(아직 읽지 않았으면 먼저 읽는다): <프로젝트 폴더>/agent-roles/REVIEWER.md
- 읽을 것(절대경로, 우선순위 순):
- (빈틈 검토) 사용자 요구 원문: / 스펙이 가리키는 코드 파일:
- (완료 전 검토) 인계 파일: / 작업자 보고 파일(handoff/<ID>-report.md): / 자동 검증이면 summary.txt의 OUT 폴더 내 summary.txt·output.txt·changed.txt·test-changes.txt·diff.patch 경로와 전체 commit(worktree 작업이면 `.worktrees/<소문자 id>/` 아래 소스 경로): / 수동 검증이면 대상 HEAD 40자 해시(`git rev-parse HEAD`), 확인 방법, `handoff/<ID>/evidence/` 경로:
- (조사) 알고 싶은 것: / 허용하는 명령·사이트:
- 금지: 지정 보고 파일과 handoff/<stem>/ 밖 쓰기, 상태를 바꾸는 명령
- 보고 파일: <절대경로>
~~~
- 작업 파일에는 경로와 사실만 주고 검토 질문, 통과 서술(`PASS`·`문제없음`), 기대 판정을 쓰지 않는다.

## 4. 실행 명령 (단발성 헤드리스 기본)
단발성 검토와 읽기 조사는 대화형 터미널 폴링(`hc`) 없이 **비대화형(헤드리스) 명령**으로 직접 실행해 보고 파일을 바로 받는다(`CrossAgentMode=manual` 저장소에서도 사용자가 검토 터미널을 수동 실행할 필요가 없다). 하위 세션 보호 규칙이 정확히 작동하도록 환경변수 `AGENTKIT_ROLE=<stem>`을 반드시 함께 지정한다. 아래 명령의 앞머리(`$env:이름='값'; `)는 PowerShell 형식이다. `sh`·`bash`(Linux, Windows의 Git Bash·Bash 도구)에서는 앞머리만 `이름=값 `으로 바꿔 명령 바로 앞에 붙인다(그대로 넣으면 변수 없이 실행된다).

- **검토 · Claude (헤드리스)**: 프로젝트 폴더에서 실행한다.
  `$env:AGENTKIT_ROLE='<stem>'; $env:CLAUDE_CODE_DISABLE_AUTO_MEMORY='1'; claude -p --model <모델> --permission-mode dontAsk --permission-prompts none --strict-mcp-config --no-session-persistence --tools "Read,Glob,Grep,Write,Edit" --allowedTools "Edit(handoff/<stem>-report.md),Edit(*handoff/<stem>-report.md)" '--' "Read handoff/<stem>.md and follow it."`
  - `sh`·`bash` 앞머리: `AGENTKIT_ROLE=<stem> CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude -p ...`(뒤 인자는 같다).
  - `--allowedTools`에 `Read`·`Glob`·`Grep`을 넣지 않는다. 넣지 않아도 실행 폴더 안은 읽히고, 넣으면 PC 전체 읽기가 열린다. 프로젝트 폴더 밖 저장소를 읽혀야 하면 `--add-dir <경로>`를 더한다.
  - `Edit(경로)` 규칙이 Write 도구까지 덮는다. `CLAUDE_CODE_DISABLE_AUTO_MEMORY`는 도구의 자동 메모리가 검토 세션에 들어오지 않게 한다.
- **읽기 조사 · Claude (헤드리스)**:
  위 검토 명령의 `--tools`에 `WebSearch`를, `--allowedTools`에 `WebSearch`를 더한다(`WebFetch`는 로컬 읽기 권한과 함께 무승인으로 열지 않는다).
- **검토 · Antigravity (헤드리스)**:
  1. 먼저 `handoff/<stem>/settings.json`을 UTF-8(BOM 없음)로 쓴다(전역 `read_file(*)` 금지 — 프로젝트와 역할 지침 경로만 허용):
     `{"permissions":{"allow":["read_file(<프로젝트 폴더>)","read_file(<agent-kit>/templates/agent-roles)","write_file(<프로젝트 폴더>/handoff/<stem>-report.md)"],"deny":["command(*)","mcp(*)","read_url(*)","execute_url(*)"]}}`
  2. 실행(연속 AGY 실행 시 최소 30초 간격 준수; `-p`는 바로 뒤 인자를 프롬프트로 받으므로 맨 끝에 둔다):
     `$env:AGENTKIT_ROLE='<stem>'; agy --model <모델> --mode plan --sandbox --disable-slash-commands --settings "<프로젝트 폴더>/handoff/<stem>/settings.json" -p "Read <프로젝트 폴더>/handoff/<stem>.md and follow it."` (`sh`·`bash` 앞머리: `AGENTKIT_ROLE=<stem> agy ...`)
- **검토 · Codex (헤드리스)**:
  `handoff/<stem>/` 폴더를 먼저 만들고 보고 경로를 `handoff/<stem>/<stem>-report.md`로 지정한 뒤 실행한다(비터미널 파이프에서 `codex exec`가 표준 입력 EOF를 기다리며 멈추지 않게 하고, 공백 포함 경로에서도 설정 인자가 깨지지 않도록 아래 형식을 지킨다):
  - Windows PowerShell(5.1은 인자 안의 큰따옴표를 지우므로 TOML 작은따옴표를 쓴다): `$env:AGENTKIT_ROLE='<stem>'; $null | codex exec --ephemeral [-m <모델>] -c default_permissions=cell_review -c "permissions.cell_review.filesystem={':root'='read','<프로젝트 폴더>/handoff/<stem>'='write'}" -c permissions.cell_review.network.enabled=false -c web_search=disabled "Read handoff/<stem>.md and follow it."`
  - Linux (`sh`/`bash`): `AGENTKIT_ROLE=<stem> codex exec --ephemeral [-m <모델>] -c default_permissions=cell_review -c 'permissions.cell_review.filesystem={":root"="read","<프로젝트 폴더>/handoff/<stem>"="write"}' -c permissions.cell_review.network.enabled=false -c web_search=disabled "Read handoff/<stem>.md and follow it." < /dev/null`
- **브라우저 대화형 조사 · Antigravity (`hc run` 전용)**:
  외부 웹 브라우저 조작·캡처가 꼭 필요할 때만 `handoff/<stem>/settings.json`(프로젝트·`<stem>` 폴더 읽기/쓰기 및 필요한 브라우저 MCP만 명시 허용)을 준비하고 `hc run --bg --no-notify --name <stem> --cwd <프로젝트 폴더> '--' agy --model <모델> --mode plan --sandbox --settings "<프로젝트 폴더>/handoff/<stem>/settings.json" --log-file "<프로젝트 폴더>/handoff/<stem>.log" -i "Read <프로젝트 폴더>/handoff/<stem>.md and follow it."`로 실행한다(`--name`과 시작 문장으로 하위 세션 범위가 자동 고정되므로 `hc run`에 없는 `--env`나 `env` 래퍼는 쓰지 않는다; `manual` 모드면 사용자에게 실행 요청).

## 5. 결과 확인과 사후 처리
- 헤드리스 실행이 종료되면 지정한 보고 파일 생성 여부와 `git status`(범위 밖 변경 유무)를 확인한다. 보고 파일이 비어 있거나 누락됐으면 출력 오류(한도·인증·정책 거부)를 확인해 한도/인증 오류면 재시도하지 않고 보고한다.
- 브라우저 대화형 조사(`hc run`)만 `hc wait <stem> --timeout 600`으로 기다리고, 끝나면 즉시 `hc kill <stem>` · `hc rm <stem>`으로 터미널을 닫는다. **권한 승인 창(`blocked`)이 뜨면 상위 AI가 화면을 읽어 `hc keys enter`를 대신 누르지 않고**, 사전 `settings.json` 범위를 벗어난 요청이므로 거부하거나 사용자에게 알린다.
- **지적 대조**: 검토 지적은 실제 파일과 대조해 `수용` / `반박` / `절충`으로 나눈다. 수용한 `높음`은 수정 후 새 번호(`<n+1>`)로 1회 재검토한다. 미해결·반박한 `높음`과 절충은 설계자가 판정하고, 설계자도 판정 못한 `높음`과 사용자 결정 사안만 사용자에게 올린다.

## 6. 작업자 위임 및 하위 세션 정리
- 작업자 실행: `<agent-kit>/skills/agent-delegate/worker.md`
- 하위 세션 정리 요청 시: `<agent-kit>/skills/agent-session-cleanup/SKILL.md` 0절
