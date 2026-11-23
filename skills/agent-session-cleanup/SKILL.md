---
name: agent-session-cleanup
description: 사용자가 세션·대화 기록·캐시·디스크 용량·끝난(죽은) 터미널을 정리하자고 할 때 쓴다("세션 정리해줘", "오래된 대화 지워줘", "용량 정리", "에이전트 캐시 청소", "clean up sessions" 등, 스크립트 이름을 말하지 않아도). 또 "하위 세션 정리해", "네가 띄운 세션 지워"처럼 이 세션이 띄운 하위 세션(검토·조사·작업자 등, 에이전트 종류 무관)만 지우라고 할 때도 쓴다(옛 표현 "네가 띄운 Antigravity 지워"도 같다). 스킬 기능이 없는 에이전트는 이 파일(<agent-kit>/skills/agent-session-cleanup/SKILL.md)을 직접 읽고 따른다.
---

# 에이전트 세션 정리

스크립트: `<agent-kit>/cleanup.ps1` (출력은 영어, 보고는 한국어로 정리; `<agent-kit>`은 이 키트 저장소의 슬래시(`/`) 절대 경로로, 정션 `~/.agents/skills/…`·`~/.claude/skills/…`에서 읽었으면 정션 원본 대상 기준, 기본 `C:/Users/<사용자>/agent-kit`)

## 0. 이 세션의 하위 세션만 지우기 ("하위 세션 정리해", "네가 띄운 세션 지워" 등)
역할·에이전트와 상관없이, 이 세션이 hc로 띄운 자식(검토·조사·작업자 등)을 정리한다. 요청 자체가 승인이다. 아래 확인 상황이 아니면 되묻지 않고 지운 뒤 무엇을 지웠는지 보고한다.
1. 목록: `powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/cleanup.ps1 -Parent $env:HC_TERMINAL_ID` (PowerShell 기준. Bash면 `"$HC_TERMINAL_ID"`)
   - 실행 전에 그 값이 비어 있지 않은지 먼저 확인한다. 출력에 `Scanned ... from hc children of <ID>` 줄이 없으면(전체 정리 목록이 나오면) 삭제로 넘어가지 않는다. 빈 값이면 스크립트가 `ERROR`로 멈춘다.
   - 나오는 것(다른 세션 것은 나오지 않는다):
     - hc: 끝났거나 일을 마치고 대기 중(`LIVE status=done` 등)인 자식 터미널. 지금 작업 중(working)이거나 승인 대기(blocked)인 터미널은 에이전트 종류와 상관없이 그 아래까지 `KEEP  terminal …`으로 빠진다(삭제 직전에도 다시 확인). blocked로 멈춰 있는 세션을 지우려면 사용자가 먼저 그 화면에서 처리하거나 종료한 뒤 다시 정리한다.
     - agy: Antigravity 자식의 대화(로그의 `Created conversation <id>`).
     - claude: Claude 자식의 대화 기록(그 자식을 띄운 프롬프트와 첫 메시지가 같은 `~/.claude/projects/...jsonl`과 같은 이름 폴더). 같은 첫 메시지의 대화가 둘 이상이면 어느 것인지 알 수 없어 목록에 넣지 않는다(경고만 나온다).
     - Codex 자식의 대화 기록은 아직 자동으로 찾지 않는다(`NOTE  codex conversation …`). 사용자에게 그대로 전한다.
     - files: 실행 폴더 안에서 이름 규칙(`sub-<p>-<id>-<review|research>-<n>`, 옛 `sub-<id>-…`·`agy-<id>-<flash|review>-<n>`)과 정확히 맞는 임시 파일만. git에 커밋된 파일·인계 파일(`handoff/<ID>.md`)·`accepted.json`의 `reviewReport`가 가리키는 최종 검토 보고서는 KEEP.
   - `HC_TERMINAL_ID`가 비어 있거나 자식 터미널 기록이 사라졌으면(hc 코어 재시작 등) 직접 띄운 agy 로그 경로를 `-Logs "<경로>,<경로>"`로 넘긴다. 로그도 없으면 찾을 수 없다고 보고하고 전체 정리(1절)를 안내한다.
   - 확인 상황(이것만 사용자에게 묻는다): (a) 담당 작업이 SESSION_HANDOFF.md 현황 표에서 아직 done(설계자 수락과 제출 완료)이 아니다 — 그 작업자는 수락 뒤 merge를 해야 하고 보고서·verify 산출물은 수락 근거이므로 "수락·merge가 끝날 때까지 그 작업의 터미널·대화·파일을 모두 남길지" 묻는다(남기기로 하면 `-Groups`를 쓰지 말고 그 항목 번호를 뺀 나머지 번호만 `-Ids`로 지운다). (b) KEEP으로 빠진 작업 중(working·blocked) 세션이 있다 — 그것은 남기고 나머지만 지웠다고 보고하면 되므로 묻지 않아도 되지만, 사용자가 '전부' 지우라고 했다면 남긴 이유를 알린다.
2. 삭제: 남길 항목이 없으면 같은 명령에 `-Apply -Groups "agy,claude,files,hc"`를 붙인다(남길 항목이 있으면 `-Groups` 없이 `-Apply -Ids "<지울 번호들>"`만 쓴다; `-Groups`와 `-Ids`를 함께 주면 그룹 전체가 선택된다). 스크립트가 터미널 → 대화 → 임시 파일(로그는 마지막) 순서로 처리하고 파일은 휴지통으로 보낸다.
3. 보고: 지운 터미널, 대화(에이전트별 수·크기), 임시 파일 수, KEEP·NOTE·FAIL과 이유. 검토 지적의 채택/미채택 판단은 정리 전에 SPEC.md의 결정 또는 handoff/<ID>-report.md에 남긴다. 이 파일들은 하위 세션 임시 파일 정리 대상이 아니다.

이 아래(1~3절)는 PC 전체를 기간 기준으로 정리하는 절차다.

## 1. 목록 (지우지 않음)
```
powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/cleanup.ps1 [-Days 30]
```
- 사용자가 기간을 말하면 `-Days`에 넣는다. 말하지 않으면 30일이다.
- 출력의 GROUP SUMMARY를 표로 보고한다(그룹·개수·크기·최근 수정일 범위·번호 범위). 개별 항목은 크기가 큰 것 위주로 몇 개만 보여 주고, 사용자가 원하면 전체를 보여 준다.
- 그룹 뜻: claude=Claude 대화 기록, codex=Codex 대화 기록, agy=Antigravity 대화+산출물, agy-temp=Antigravity 캐시·로그·임시 파일, hc=끝난 hc 터미널(이 그룹만 기간과 상관없이 끝난 것 전부다. 사용자가 기간을 말했으면 이 점을 알린다).
- 같이 알린다: 지우면 해당 대화를 이어 갈 수 없다. Antigravity는 목록 화면에 빈 항목이 보이지 않는다(확인됨). Codex는 확인하지 않았으므로 처음에는 한 건만 지워 보길 권한다. 기본은 휴지통 이동이라 되돌릴 수 있다.
- 후보가 없으면 그렇게 보고하고 끝낸다.

## 2. 승인
- 지울 그룹을 고르게 하고, 개별 번호도 고를 수 있게 한다(Claude는 AskUserQuestion multiSelect에 "번호 직접 입력"을 둔다. 그런 도구가 없는 에이전트는 그룹 요약과 번호 범위를 보여 주고 지울 그룹·번호를 답해 달라고 묻는다).
- 사용자가 고르지 않은 것은 지우지 않는다. 승인은 방금 보여 준 목록에만 해당한다. 다음 정리 때는 다시 묻는다.

## 3. 삭제 (승인한 것만)
```
powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/cleanup.ps1 -Apply -Groups "codex,hc" -Ids "1-5,9"
```
- 방금 만든 목록 파일(24시간 이내)만 쓴다. `-Groups`와 `-Ids`를 함께 주면 합집합이다(그룹 전체 + 그 번호). 목록을 다시 만들었다면 번호가 바뀌었을 수 있으니 다시 보여 주고 승인을 받는다.
- `-Permanent`(휴지통을 거치지 않고 바로 삭제)는 사용자가 명시적으로 요청할 때만 쓴다.
- 결과(OK/SKIP/FAIL 개수, 확보한 용량, 휴지통 여부)를 보고한다. FAIL은 이유를 그대로 전한다. 스크립트를 고치거나 다른 명령으로 우회해서 지우지 않는다.
