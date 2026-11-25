# 작업자 지침 — 인계 하나를 맡아 끝낸다

## 시작
- 인계 파일(`handoff/<ID>.md`)의 목표·인수 조건·가정(기본값)·하지 않을 것·`review`·`verify`와 가리키는 `SPEC.md` 절을 읽는다. 인계 범위 밖 파일 수정이나 불필요한 리팩터링은 하지 않는다.
- `deps`가 있으면 `SESSION_HANDOFF.md`에서 선행 작업이 `done`이고 제출 commit이 base에 포함되어 있는지(`git merge-base --is-ancestor <선행 commit> <base>`) 확인한다.
- 재개: 이미 `handoff/<ID>-report.md`나 작업 브랜치가 있으면 이전 상태부터 잇는다. 이미 설계자 수락(`accepted …`)을 받은 상태면 기본 `verify.ps1`을 다시 돌리지 말고(기본 실행은 수락을 지운다) 9단계(`-CheckAccepted`)부터 진행한다.
- 저장소에 제출 정책(`git config --local agentkit.submission`)이 비어 있으면 `init.ps1 -GitSetup -Target <저장소 루트>`를 한 번 실행해보고, 정책 미설정이면 스스로 정하지 말고 설계자에게 보고한다. 지침 파일(`AGENTS.md`·`SPEC.md`·`SESSION_HANDOFF.md`·`agent-roles/`)과 `handoff/`는 인계가 지시하지 않는 한 `git add`하지 않는다.
- 인계가 모호하거나 그대로 구현하면 안 되는 결함을 찾으면 추측하지 말고 `handoff/<ID>-report.md`에 질문을 적고 턴을 끝낸다.

## 수행 순서 (해당하는 단계만)
1. 관련 코드 읽기.
2. 구현과 단위/통합 테스트 작성(버그 수정과 핵심 로직은 실패 테스트 확인 후 구현).
3. 정적 검사(Lint·타입)·자동 테스트 실행.
4. 작업 브랜치(`task/<소문자 id>`)에 논리 단위로 커밋(기준 커밋은 `handoff/<ID>/approved.json`의 `baseCommit`).
5. 고정 검증 실행: `powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/verify.ps1 -Id <ID>` (macOS·Linux는 `pwsh -NoProfile -File ...`; worktree/하위 저장소는 `-Project <프로젝트 폴더> -Repo <저장소·worktree>` 추가).
   - 자동 명령이 있으면 `RESULT: PASS`가 나올 때까지 고쳐 커밋하고 다시 돌린다. 단, **원인이 같은 실패가 2회 연속 나거나 `max verify failures`에 도달하면 즉시 멈추고** 코드 문제인지 인계·환경 문제인지 관찰 근거를 보고한다(RUNBOOK 15절).
   - 작업자는 인계·`approved.json`·`accepted.json`을 수정하거나 `-Prepare`·`-Accept`를 실행하지 않는다.
   - 수동 검증 조건과 `verify: -` 작업은 확인 방법·증거를 `handoff/<ID>/evidence/`에 남긴다(실제 대상 vs 모의 환경 명시).
6. `pr` 제출 방식이면 작업 브랜치 push 후 PR 생성(`direct`·`local`·비Git의 최종 제출은 설계자 수락 뒤에 수행).
7. `handoff/<ID>-report.md`에 인수 조건별 결과·증거·구현하며 정한 것·**남긴 위험**(미해결 취약점·끈 검사·미실행 시험)을 먼저 작성한다.
8. `review: critical`이면 방금 작성한 `handoff/<ID>-report.md`와 검증 산출물(`OUT`) 경로를 넣어 `<agent-kit>/skills/agent-delegate/SKILL.md` 4절의 헤드리스 명령으로 완료 전 검토를 실행하고, 검토가 끝나면 보고에 최종 검토 보고 경로와 조치 내역을 덧붙인다(수동 검토 정책일 때만 작업 파일·증거 경로를 남기고 대기). `normal` 작업은 7번 작성으로 바로 턴을 끝낸다.
   - 수용한 `높음` 지적은 수정·커밋 후 5~7번(재검증 → `pr`이면 작업 브랜치 push 갱신 → 보고의 commit·OUT 갱신)을 다시 거쳐 새 번호로 1회 재검토받는다. 재검토 뒤에도 남은 `높음`·반박·절충은 설계자에게 올린다.
9. 설계자 수락(`accepted <commit>`) 수신 후 제출 직전 대조:
   - `verify.ps1 -Id <ID> -CheckAccepted`로 현재 커밋·인계·클린 트리 일치를 확인한다.
   - `pr`: 원격 PR head가 수락 commit과 일치하는지 확인하고, 병합까지 지시받았으면 반드시 `gh pr merge --match-head-commit <수락 전체 해시>`로 병합한다.
   - `direct`: 대상 브랜치로 `--ff-only` 통합 후 수락 commit 일치 확인 뒤 push한다.
   - `local`: 합의대로 작업 브랜치 인계 또는 `--ff-only` 로컬 통합(push 금지).
   - worktree는 통합 확인 뒤 메인 저장소에서 `git worktree remove .worktrees/<소문자 id>`로 정리하고, 보고에 `<ID> submitted <commit or artifact>`를 남긴다.

## 보고 (`handoff/<ID>-report.md`, 정상 완료 시 12줄 이내)
- 상태(`review` / `blocked` / `failed`) · 인수 조건별 PASS/FAIL과 증거 경로(검증 환경: 실제 대상 / 모의 환경)
- `verify`의 RESULT · OUT 경로 · commit 해시 · `TEST-CHANGES` / `EVIDENCE` 신호 사유
- (`critical`) 최종 검토 보고 경로와 `높음` 지적 처리 내역
- 구현하며 정한 것(`SPEC.md` 환류 대상, 3줄 이내, 없으면 `없음`)
- 남긴 위험(남은 취약점·끈 검사·미실행 시험) · 설계자 결정 필요 사항 · 보고 파일 경로
- `SESSION_HANDOFF.md`와 `SPEC.md`는 설계자만 수정한다.

## 해당할 때만 읽는 것
- 완료 전 검토·조사 위임 → `<agent-kit>/skills/agent-delegate/SKILL.md`
- 병렬 `worktree` 세부 규칙 → `<agent-kit>/RUNBOOK.md` 5절
- 테스트 계정·쿠키·브라우저 → `<agent-kit>/RUNBOOK.md` 13절
- 반복 실패(2회 연속)·`max verify failures` → `<agent-kit>/RUNBOOK.md` 15절
