---
name: agent-kit-start
description: "새 프로젝트에서 agent-kit을 처음 적용할 때 쓴다('agent-kit으로 시작하자', '키트로 새 프로젝트 시작'). 초기화 후 설계자와 요구사항 대화를 시작한다. 키트 자체 수정·검토, 기존 프로젝트 재개, 작업자·검토자 인계에는 쓰지 않는다."
---

# agent-kit으로 새 프로젝트 시작

새 프로젝트를 초기화하는 설계자가 한 번 사용한다. `<agent-kit>`은 이 키트 저장소의 슬래시(`/`) 절대 경로다(기본 `C:/Users/<사용자>/agent-kit` 또는 `~/agent-kit`). 한국어로 대화·기록하고, 코드 식별자·명령은 원문을 유지한다.

## 시작 조건
- 사용자가 작업할 프로젝트 폴더에서 실행한다. 폴더가 불명확하면 먼저 확인한다. 키트 폴더 자체에서는 초기화하지 않는다.
- 대화형 작업자 자동 실행을 위해 `$env:HC_TERMINAL_ID`(Linux는 `$HC_TERMINAL_ID`)를 확인한다. 비어 있으면 파일을 만들기 전에 사용자에게 묻는다:
  1. Herdr/`hc` 터미널에서 설계자를 다시 시작할지(권장, Codex는 `codex --no-daemon`)
  2. 일반 터미널에서 **수동 작업자 인계 모드(`-CrossAgentMode manual`)**로 진행할지(단발성 검토·조사는 수동 모드에서도 헤드리스 CLI로 자동 실행되며 작업자만 파일로 인계한다).
- 역할 배정은 사용자의 명시 지정을 우선하고, 없으면 `<agent-kit>/local-defaults.json`(있을 때)의 `designer`·`worker`·`reviewer`를 확인한다.
- 프로젝트에 `AGENTS.md`·`SPEC.md`·`SESSION_HANDOFF.md`·`agent-roles/`가 이미 있으면 새로 초기화하지 않고 알린다(경로 갱신이나 템플릿 병합은 `<agent-kit>/RUNBOOK.md` 11절 안내).

## 초기화와 설계 시작
1. `powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/init.ps1 -Target <프로젝트 폴더>`(Linux는 `pwsh -NoProfile -File ...`, 비Git 요청 시 `-NoGit`, 팀·멀티 PC 공유용 스펙 Git 추적 요청 시 `-TrackSpec`)를 실행한다. 종료 코드가 0이 아니거나 `SKIPPED`가 있으면 기존 파일을 보존하고 출력의 원인과 `NEXT`를 보고한 뒤 멈춘다.
2. 생성된 `agent-roles/DESIGNER.md`를 읽고 '1. 대화'대로 요구사항을 정리해 고정 착수 확인 항목(목표·완료 기준, 제출·Git 추적 방식, 예외·빈 값 기본값, 프로젝트 무게)을 합의한다.
3. 합의대로 `AGENTS.md`(프로젝트명·목표·무게·역할 배정)와 `SPEC.md`를 채운다. Git 저장소면 합의한 정책으로 `init.ps1 -GitSetup -Target <저장소 루트> -Submission <direct|pr|local> [-ProtectedBranches <CSV>] [-Base <비교 ref>] [-CrossAgentMode manual] [-TrackSpec]`을 실행한다(하위 폴더가 Git 저장소면 `-ProjectRoot <프로젝트 폴더>` 추가).
4. 만든 파일, `GIT`·`GIT-EXCLUDE`·`POLICY`·`PRE-PUSH` 결과, `TOOLS: CHANGED` 여부, 역할 배정을 보고하고 설계를 이어간다.
