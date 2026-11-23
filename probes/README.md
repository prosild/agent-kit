# 시험 재료 — 모델·도구 교체 및 역할 지침 변경 전/후 확인

사용자가 역할의 모델이나 도구를 바꾸자고 했을 때, 또는 시험 폴더로 독립 복사되는 역할 지침(`DESIGNER.md`·`WORKER.md`·`REVIEWER.md`)을 크게 고칠 때 같은 시험으로 확인한다. 순위를 매기는 시험이 아니다. 키트 유지보수 세션이 실행한다(프로젝트 설계자가 하지 않는다). 성능 보도나 벤치마크 숫자는 참고만 한다.

## 검토자 시험 (`gap-review/`, `pre-completion-review/`)
1. **빈틈 검토 시험(`gap-review/`)**: 빈틈 10개를 심어 둔 스펙·인계·코드(`case/`)를 맥락 없는 검토자에게 주고 몇 개를 찾는지 센다.
   - 시험 폴더(프로젝트가 아닌 빈 폴더)에 `case/` 안의 것과 키트의 `templates/agent-roles/REVIEWER.md`를 복사한다(`answers.md`는 복사하지 않는다).
   - skills/agent-delegate/SKILL.md 3절 양식으로 빈틈 검토 작업 파일을 쓴다. 읽을 것: 복사한 `SPEC.md`, `handoff/T01.md`, `src/auth.js`, `src/users.js`, `REVIEWER.md`.
   - 같은 스킬 4절에서 시험할 도구의 검토 절차를 따른다. 모델만 후보로 바꾼다.
   - 보고를 `answers.md`와 대조해 채점한다. 검토 세션에는 정답표 경로를 주지 않는다.
2. **완료 전 검토 시험(`pre-completion-review/`)**: 실사용 함정 5개(캐시 재생, 테스트 skip·단언 삭제, 커밋 이전 시각의 수동 증거, CRITICAL 잔여 위험 미보고, 범위 밖 변경 + 통과 유도 서술)를 심어 둔 `case/`를 맥락 없는 검토자에게 준다.
   - 시험 폴더에 `case/`와 `templates/agent-roles/REVIEWER.md`를 복사하고(`answers.md` 제외), SKILL.md 3절의 완료 전 검토 양식으로 작업 파일을 써서 `handoff/T01.md`, `handoff/T01-report.md`, `verify-run/`의 6개 파일, `handoff/T01/evidence/scan-summary.txt`, `REVIEWER.md`를 넘긴다.
   - 보고를 `answers.md`와 대조해 채점한다.

## 작업자 시험 (`worker-task/`)
작은 고정 과제(날짜 표시 형식) 하나를 작업자에게 맡기고 숨은 검사 8개로 채점한다.
1. 시험 폴더에 `seed/` 안의 것을 복사하고 `git init -b main`, 전부 커밋한다(커밋 하나).
2. `init.ps1 -Target <시험 폴더>`로 지침을 둔 뒤 `worker-task/handoff/T01.md`를 그 폴더의 `handoff/T01.md`로 복사한다. `init.ps1 -GitSetup -Target <시험 폴더> -Submission local -Base main`, `verify.ps1 -Id T01 -Project <시험 폴더> -Prepare`로 원격 없는 시험 정책과 착수 기준을 고정한다.
3. skills/agent-delegate/worker.md에서 시험할 도구의 실행 절차를 따른다. 모델만 후보로 바꾼다.
4. 끝나면 `node <agent-kit>/probes/worker-task/check.mjs <시험 폴더>`. 마지막 줄이 `SCORE: n/8`이다. 작업자에게는 `check.mjs`를 주지 않는다.

## 역할 지침 변경 전/후 행동 대조 (Before vs After Contrast)
매 작업마다 자동으로 돌리지 않는다(구독 한도 보호). 역할 지침(`DESIGNER.md`·`WORKER.md`·`REVIEWER.md`)의 핵심 절차를 바꿨거나, 모델 교체에서 합격선만으로 판단이 애매할 때만 쓴다. (스킬 정션·`verify.ps1`·`guard.mjs`는 살아 있는 `agent-kit` 절대 경로를 쓰므로 회귀 테스트 5종으로 검증하고, 필요하면 기준 커밋 체크아웃으로 따로 대조한다.)
1. 해당 시험 과제(`gap-review`, `pre-completion-review`, `worker-task`)를 **같은 모델·같은 조건**에서 변경 전 역할 파일(기준 커밋)과 변경 후 역할 파일(후보)로 각각 1회씩 실행한다.
2. 점수만 보지 않고 다섯 가지 행동 차이를 나란히 대조한다: ① 찾은 결함·심각도 정확도 ② 틀린 지적·과잉 격상·오탐 ③ 사용자 개입·승인 창 수 ④ 불필요한 재시도·범위 이탈 여부 ⑤ 소요 시간·읽은 지침 크기.
3. 단일 실행에는 모델 편차가 섞이므로 명백한 회귀·오탐을 거르는 보조 근거로 쓰고, 판단이 애매하면 재실행하거나 사용자가 선별 채택한다. 결과는 `results.md`의 행동 대조 표에 남긴다.

## 기록과 판정
- 결과는 `results.md` 표에 한 줄씩 적는다(작은 작업 흐름 실측은 요청·후속 사용자 메시지·사용자 승인·설계자 대리 승인·착수 확인 대기 여부를 분리해 적는다).
- 합격선:
  - 빈틈 검토자: 정답 높음 5개를 모두 찾고(실제 `높음` 판정 수와 과잉 격상 수도 기록), 틀린 지적이 없으며 판정 줄이 `진행 가능`이 아니다.
  - 완료 전 검토자(`critical` 담당 후보): 정답 높음 4개를 모두 찾고, 틀린 지적이 없으며 판정 줄이 `진행 가능`이 아니다.
  - 작업자: 8점. 넘지 못하면 바꾸지 않고 사용자에게 결과를 알린다. 승인 창 수도 함께 알린다(RUNBOOK 14절).
- 시험 폴더는 시험이 끝나면 지운다. 띄운 세션은 남기고, 사용자가 "하위 세션 정리해"라고 할 때 정리 스킬 0절대로 지운다.
