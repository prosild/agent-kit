# 작업자 지침 — 인계 하나를 맡아 끝낸다

## 시작
- 인계 파일(`handoff/<ID>.md`)의 목표·인수 조건·하지 않을 것·`review`·`verify`를 읽는다. 인계가 가리키는 SPEC.md 절도 읽는다. 인계 범위 밖의 파일은 고치지 않고, 요구하지 않은 기능·리팩터링을 더하지 않는다.
- 인계에 `deps`가 있으면 SESSION_HANDOFF.md 현황 표에서 그 작업이 done이고, 선행 작업 보고(`handoff/<선행 ID>-report.md`)의 제출 commit이 인계의 base(없으면 `git config --local agentkit.base`)에 들어 있는지(`git merge-base --is-ancestor <그 commit> <base>`) 본다. 아니면 시작하지 않고 보고한다.
- 재개: 이미 `handoff/<ID>-report.md`나 작업 브랜치가 있으면 앞 세션을 이어받은 것이다. 보고의 마지막 상태에서 이어가고, 수락(`accepted …`)을 받은 뒤라면 verify 기본 실행 없이 9단계(`-CheckAccepted`)부터 한다(기본 실행은 수락을 지운다).
- 저장소에 제출 정책이 없으면(`git config --local agentkit.submission`이 비어 있으면) `powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/init.ps1 -GitSetup -Target <저장소 루트>`를 한 번 실행한다(지침 제외와 이미 합의된 제출 정책을 적용한다. 정책이 없어 건너뛰면 설계자에게 보고하고 스스로 -Submission을 정하지 않는다. `TOOLS: CHANGED`도 보고한다). 지침 파일과 `handoff/`는 `git add`하지 않는다.
- 인계가 모호하거나 인계대로 하면 안 될 이유를 찾으면 추측하지 말고 `handoff/<ID>-report.md`에 질문을 적고 턴을 끝낸다.

## 순서 (해당하는 단계만)
1. 관련 코드 읽기
2. 구현과 테스트(결함 수정과 핵심 로직은 실패하는 테스트를 먼저 확인한 뒤 구현)
3. 정적 검사(Lint·타입)·자동 테스트
4. 작업 브랜치(`task/<소문자 id>`)에 논리 단위(인계에 `'## 단계'`가 있으면 단계마다)로 커밋한다.
   - 기준 커밋: 자동 검증 작업은 `handoff/<ID>/approved.json`의 `baseCommit`, `verify: -` 작업은 인계의 `base`. 비Git은 인계의 복구 수단·산출물 식별 방법을 따른다.
5. 고정 검증: `powershell -NoProfile -ExecutionPolicy Bypass -File <agent-kit>/verify.ps1 -Id <ID>`(worktree는 `-Project <프로젝트 폴더> -Repo <worktree 폴더>` 추가).
   - 자동 명령이 있으면 마지막 줄이 `RESULT: PASS`가 될 때까지 고쳐 커밋하고 다시 돌린다(원인이 같은 실패가 2회 연속 나거나 `max verify failures`에 닿으면 멈추고 코드 문제 vs 인계·검증 환경 문제 관찰 근거를 보고한다, RUNBOOK 15절).
   - 작업자는 인계·`approved.json`·`accepted.json`을 고치거나 `-Prepare`·`-Accept`를 실행하지 않는다. 기준 변경·rebase 전에도 설계자 재승인을 요청한다.
   - 자동 명령이 덮지 않는 조건과 `verify: -` 작업은 조건별 확인 방법·증거를 `handoff/<ID>/evidence/`에 남긴다(모의 환경인지 실제 대상인지 표시).
6. PR 방식이면 작업 브랜치 push → PR. direct·local·비Git의 최종 제출은 수락 뒤에 한다.
7. `review: critical`이면 완료 전 검토를 받는다(`SKILL.md` 5절대로 대조·처리).
   - 작업자와 검토자가 모두 AGY이거나 수동 검토면 작업 파일·증거 경로를 보고에 남기고 턴을 끝낸 뒤 검토 보고를 받아 이 단계부터 잇는다.
   - 수용한 높음은 고치고 5번부터 다시 한 뒤 한 번 더 검토받는다(검토 뒤 커밋을 추가하면 새 증거로 재검토 필요). 재검토 한 번 뒤에도 변경이 필요하거나 미해결·반박 높음·절충이 있으면 설계자에게 올린다.
8. 보고 파일을 쓰고 턴을 끝낸다.
9. 수락 뒤 제출 직전 대조: 자동 검증 Git 작업은 `verify.ps1 -Id <ID> -CheckAccepted`로 commit·인계 일치를 확인한다(수동·비Git은 RUNBOOK 1절).
   - PR: 원격 head도 수락 commit과 대조하고 지시받은 경우 merge.
   - direct: 대상 브랜치로 `--ff-only` 통합 후 `git rev-parse refs/heads/<대상 브랜치>`가 수락 commit과 같은지 확인하고 push.
   - local: 합의대로 작업 브랜치 인계 또는 `--ff-only` 통합(push 금지). 충돌·다른 tip이면 제출하지 않고 보고.
   - worktree는 통합(merge) 확인 뒤 `git worktree remove .worktrees/<소문자 id>`로 지운다. 보고에 제출 대조 결과와 `<ID> submitted <commit or artifact>`를 남긴다.

## 보고
- 질문·작업 보고·제출 보고는 `handoff/<ID>-report.md`에 남긴다. 정상 완료는 12줄 이내:
  - 상태(`review` / `blocked` / `failed`) · 인수 조건별 PASS·FAIL과 증거 경로(검증 환경: 실제 대상/모의 환경)
  - `verify`의 RESULT·OUT·commit과 TEST-CHANGES·EVIDENCE 사유(미실행이면 그 사실)
  - (`critical`) 최종 검토 보고 경로와 높음 지적 처리 내역
  - 구현하며 정한 것(`SPEC.md`에 합칠 결정, 3줄 이내. 없으면 `없음`)
  - 남긴 위험(남은 취약점·끈 검사·미실행 시험. 있으면 설계자 결정 필요) · 설계자 결정 필요 · 보고 파일 경로.
- SESSION_HANDOFF.md와 SPEC.md는 설계자만 고친다(병렬 작업 시 충돌을 막기 위해 작업자는 자기 보고 파일에만 상태를 적는다).

## 막혔을 때
- 새 가설·관찰 없이 반복하지 말고 보고한다. 회귀는 임시 수정으로 덮지 않는다. 작업 전부터 있던 변경과 다른 사람·세션의 변경을 보존하며 자기 변경만 안전하게 되돌리거나 그대로 두고, 어느 쪽이든 보고한다.
- push·배포·데이터 쓰기는 다시 하기 전에 이미 반영됐는지 확인한다. 권한 거부와 훅 차단은 다시 시도하거나 우회하지 않고 보고한다.

## 해당할 때만 읽는 것
- 조사·검토 세션에 일을 맡긴다 → <agent-kit>/skills/agent-delegate/SKILL.md
- 인계에 `worktree`가 있다(병렬 작업) → <agent-kit>/RUNBOOK.md 5절
- 테스트 계정·쿠키·브라우저를 쓴다 → RUNBOOK 13절
- 운영에 반영한다 → 인계의 지시를 따르고, 반영 뒤 운영 사이트는 읽기 전용으로 확인한다
- hc 명령이 막힌다 → RUNBOOK 2·3절
- 원인이 같은 실패 2회 연속·반복 지적으로 멈췄다 → RUNBOOK 15절
