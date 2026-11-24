---
name: agent-session-cleanup
description: "사용자가 세션·대화 기록·캐시·디스크 용량·끝난 터미널을 정리하자고 할 때 쓴다('세션 정리해줘', '오래된 대화 지워줘', '용량 정리', '에이전트 캐시 청소', 'clean up sessions'). 또 '하위 세션 정리해', '네가 띄운 세션 지워'처럼 이 세션이 띄운 하위 세션만 지우라고 할 때도 쓴다."
---

# 에이전트 세션 정리

스크립트: `<agent-kit>/cleanup.ps1` (Windows는 `powershell -NoProfile -ExecutionPolicy Bypass -File`, macOS·Linux는 `pwsh -NoProfile -File`; 출력은 영어, 보고는 한국어)

## 0. 이 세션의 하위 세션만 지우기 ("하위 세션 정리해", "네가 띄운 세션 지워")
이 세션이 `hc`로 띄운 자식(작업자·대화형 조사 등)의 끝난 터미널·대화 기록·임시/로그 파일을 정리한다. 요청 자체가 승인이다.
1. 목록 확인:
   - PowerShell: `powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/cleanup.ps1 -Parent $env:HC_TERMINAL_ID`
   - POSIX/pwsh: `pwsh -NoProfile -File <agent-kit>/cleanup.ps1 -Parent "$HC_TERMINAL_ID"`
   - 출력에 `Scanned ... from hc children of <ID>` 줄이 있는지 확인한다. 작업 중(`working`)이거나 승인 대기(`blocked`)인 자식은 자동으로 `KEEP` 제외된다.
   - 확인이 필요한 예외(이때만 사용자에게 묻는다): 담당 작업이 `SESSION_HANDOFF.md`에서 아직 `done`(수락·제출 완료)이 아닌 작업자 세션이 포함된 경우, 남길지 여부를 묻는다.
2. 삭제 적용:
   - 전체 적용: 같은 명령에 `-Apply -Groups "agy,claude,files,hc"` 추가(`accepted.json`이 참조하는 최종 검토 보고서와 Git 추적 파일은 자동 보존됨).
   - 일부 제외 시: `-Groups` 없이 `-Apply -Ids "<지울 번호들>"`만 지정.
3. 보고: 지운 터미널, 대화 수·크기, 임시/로그 파일(`sub-*`, `task-*.log`), `KEEP`·`NOTE`·`FAIL` 사유를 요약 보고한다.

---

## 1. PC 전체 기간 기준 목록 조회 (삭제하지 않음)
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/cleanup.ps1 [-Days 30]
```
- `GROUP SUMMARY`를 표(그룹·개수·크기·수정일 범위·번호 범위)로 보고한다.
- 그룹: `claude`(Claude 대화 기록), `codex`(Codex 세션 기록), `agy`(Antigravity CLI·App·IDE 대화+산출물), `agy-temp`(캐시·로그·임시 파일), `hc`(끝난 `hc` 터미널 — 기간 무관).
- 지우면 해당 대화를 재개할 수 없으며, 기본 동작은 휴지통(Windows Recycle Bin / macOS·Linux Trash) 이동임을 함께 안내한다.

## 2. 사용자 승인
- 지울 그룹이나 번호 범위를 사용자에게 물어 명시적으로 선택한 항목만 다음 단계로 넘긴다.

## 3. 승인 항목 삭제
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/cleanup.ps1 -Apply -Groups "<그룹>" -Ids "<번호>"
```
- 방금 만든 목록(24시간 이내)만 유효하며, `-Permanent`(영구 삭제)는 사용자가 명시적으로 요청할 때만 붙인다.
- 완료 후 `OK`/`SKIP`/`FAIL` 개수와 확보 용량을 그대로 보고한다.
