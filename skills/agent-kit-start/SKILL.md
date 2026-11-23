---
name: agent-kit-start
description: 새 프로젝트에서 agent-kit을 처음 적용할 때 쓴다("agent-kit으로 시작하자", "키트로 새 프로젝트 시작"). 초기화 후 설계자와 요구사항 대화를 시작한다. 키트 자체 수정·검토, 기존 프로젝트 재개, 작업자·검토자 인계에는 쓰지 않는다.
---

# agent-kit으로 새 프로젝트 시작

새 프로젝트를 초기화하는 설계자가 한 번 사용한다. `<agent-kit>`은 이 키트 저장소의 슬래시(`/`) 절대 경로다(정션 `~/.agents/skills/…`·`~/.claude/skills/…`에서 읽었으면 정션 원본 대상 기준, 기본 `C:/Users/<사용자>/agent-kit`; Codex 허용 규칙과 맞도록 명령에는 항상 슬래시 절대 경로를 그대로 쓴다). 한국어로 대화·기록하고, 코드 식별자·명령은 원문을 유지한다.

## 시작 조건
- 사용자가 작업할 프로젝트 폴더에서 실행한다. 폴더가 불명확하면 먼저 확인한다. 키트 폴더 자체에서는 초기화하지 않는다.
- Herdr/hc 터미널인지 `$env:HC_TERMINAL_ID`로 확인한다. 비어 있으면 자동 위임(`hc run`)이 동작하지 않으므로 파일을 만들기 전에 사용자에게 묻는다: ① Herdr/hc 터미널에서 설계자를 다시 시작할지(권장, Codex는 `codex --no-daemon`), ② Herdr 없이 일반 터미널에서 **수동 인계 모드(`-CrossAgentMode manual`)**로 진행할지. 사용자가 수동 인계를 고른 경우에만 계속 진행한다.
- 기본 역할 배정은 사용자의 명시 배정이 우선이며, 명시하지 않았으면 초기화 전에 `<agent-kit>/local-defaults.json`(있을 때)의 `designer`·`worker`·`reviewer`를 먼저 확인한다(`local-defaults.json`이 없으면 현재 설계자 에이전트와 로컬에 설치된 도구를 기준으로 착수 확인에서 제안·합의한다). 현재 에이전트가 선택된 설계자가 아니면 초기화 전에 그 설계자로 시작하도록 안내한다.
- 프로젝트에 AGENTS.md·CLAUDE.md·GEMINI.md·SPEC.md·SESSION_HANDOFF.md·agent-roles/가 이미 있으면 새로 초기화하지 않고 그 사실을 알린다(기존 지침의 `<agent-kit>`·옛 스킬 경로만 갱신하거나 키트 템플릿과 병합하려면 `<agent-kit>/RUNBOOK.md` 11절을 안내한다). 이 스킬은 병합·이전을 하지 않는다. 이미 키트를 적용한 프로젝트는 프로젝트 지침으로 이어간다.

## 초기화와 설계 시작
1. `powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/init.ps1 -Target <프로젝트 폴더>`를 실행한다(사용자가 처음부터 비Git 작업을 요청했을 때만 `-NoGit`을 붙인다). 없는 지침 파일만 만들고 템플릿의 `<agent-kit>` 경로와 로컬 기본 역할 배정(`local-defaults.json`)을 채운다. Git 폴더가 아니면 `git init -b main`을, 커밋이 없으면 빈 기준 커밋(`chore: initial baseline`)을 먼저 만들고 지침을 로컬 제외한다. 종료 코드가 0이 아니거나 SKIPPED가 있거나, Git 작업인데 `GIT-EXCLUDE: skipped`가 나오면(저장소 하위 폴더 등) 기존 파일을 보존하고 출력의 원인과 NEXT를 보고한 뒤 여기서 멈춘다(SKIPPED면 RUNBOOK 11절 병합 절차를 안내한다).
2. 생성된 `agent-roles/DESIGNER.md`를 읽고 '1. 대화'대로 프로젝트를 이야기한다. 이미 들은 것은 다시 묻지 않는다. 프로젝트 무게(가벼움/무거움)를 이유와 함께 제안해 사용자가 정하도록 한다(예: 합의된 경계 안의 되돌리기 쉬운 작업이면 `가벼움`, 여러 작업을 묶는 외부 계약이나 보안 설계를 먼저 합의해야 하면 `무거움`). 제출 방식은 DESIGNER.md 2절대로 골라 착수 전 확인에서 함께 합의한다.
3. AGENTS.md의 프로젝트명·목표·무게·역할 배정과 SPEC.md(제약 절에 제출 방식과 수동 인계 시 `수동 인계 모드(hc 미사용)` 포함)를 합의대로 채운다. 미정은 SPEC의 '열린 질문·가정'에 둔다. 기본과 다른 역할 배정은 RUNBOOK 12절의 확인된 조합을 따른다. Git이면 합의한 제출 방식으로 `powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/init.ps1 -GitSetup -Target <저장소 루트> -Submission <direct|pr|local> [-ProtectedBranches <CSV>] [-Base <비교 ref>]`를 실행한다(1단계의 GIT 줄이 `-Base`를 안내했으면 그 브랜치를 주고, Herdr 없이 수동 인계를 합의했으면 `-CrossAgentMode manual`을 덧붙인다). 비Git은 복구 수단과 수동 확인 방법을 정한다.
4. 만든 파일, GIT·GIT-EXCLUDE·POLICY(제출 방식과 이유)·PRE-PUSH 결과, TOOLS가 CHANGED면 그 내용, 역할 배정을 보고하고 설계를 이어간다.

이후 세션은 프로젝트의 AGENTS.md와 자기 역할 파일을 따른다. 시작 스킬을 반복 실행하지 않는다. 운영 설명은 `<agent-kit>/RUNBOOK.md`의 필요한 절만 읽는다.
