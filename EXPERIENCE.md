# 경험 기록 (EXPERIENCE) — 온디맨드 회고·유지보수 전용 (평소 프로젝트 세션은 읽지 않는다)

프로젝트 실사용에서 겪은 반복 실패 패턴과 재발 여부를 추적하는 **온디맨드 기록**이다. Always-on 컨텍스트를 늘리지 않기 위해 일반 작업 세션은 평소 읽지 않으며, 사용자가 `"하네스 회고해"`를 요청했을 때 설계자가 2절만 읽고, `agent-kit` 유지보수 세션이 3절 표를 참조·갱신한다.

## 1. 범용(Invariant) vs 프로젝트 특화(Domain) 분리 기준
프로젝트 회고에서 나온 후보를 섞지 않고 둘로 가른다.
- **`[범용 / Invariant]`**: 언어·프레임워크·도메인과 무관하게 반복되는 하네스 실패(검증 캐시 오판, 훅 오탐·누락, 역할 경계 이탈, 불필요한 승인 창, 지침 모호성·과밀) → `agent-kit` 수정 후보.
- **`[프로젝트 특화 / Domain]`**: 특정 저장소·외부 API 계약·특정 빌드/배포 환경에만 해당하는 규칙 → 해당 프로젝트의 `SPEC.md`·`AGENTS.md`에만 남기고 `agent-kit`에는 넣지 않는다.

## 2. 온디맨드 회고 절차 (Reflector)
사용자가 `"하네스 회고해"`를 요청했을 때만 설계자가 실행한다(프로젝트 완료 시 자동 실행하지 않는다).
1. `SESSION_HANDOFF.md`, `handoff/*-report.md`, `handoff/<ID>/verify/runs/*/summary.txt`에서 **실제 겪은 실패·재시도·승인 마찰·놓친 결함**만 뽑는다(추측·일반론 금지).
2. 항목마다 근거(작업 ID·증상·영향)를 붙여 `[범용 / Invariant]`와 `[프로젝트 특화 / Domain]`으로 나눠 **5~10줄 이내**로 프로젝트의 `handoff/retro.md`(Git 제외 경로)에 저장하고 사용자에게 요약 보고한다.
3. 일반 프로젝트 세션은 `agent-kit` 파일을 직접 수정하지 않는다(`hooks/guard.mjs`도 차단). 사용자가 채택한 `[범용 / Invariant]` 항목만 `agent-kit` 폴더 세션에 `handoff/retro.md` 경로를 넘겨 반영하고(원칙 13), 아래 표에 패턴·검증 테스트·상태를 기록한다.

## 3. 누적 교훈 인덱스 (반복 패턴·시험 도입 추적)
| 날짜 | 출처 | 분류 | 실패 패턴 또는 시험 도입 항목 | 검증 회귀 테스트 | 상태 |
|---|---|---|---|---|---|
| 2026-11-17 | `probes/worker-task` 실측 1~3차 | 범용 | 맨 `--` 승인 창 증가, 터미널 이름 충돌, 작은 작업 예외 기본값 누락 | `guard.test.mjs`, `DESIGNER.md` 고정 착수 블록 | 반영 |
| 2026-11-19 | 실사용 웹 프로젝트 T01~T05 | 범용 | Gradle `UP-TO-DATE`·`SKIPPED` 캐시 재생 PASS 오판 | `verify.test.mjs` (`GRADLE*`, `GOCACHED`) | 반영 |
| 2026-11-19 | 실사용 웹 프로젝트 T01~T05 | 범용 | 수락 기록과 검토 보고·수동 증거 시점 단절 및 정리 시 보고 소실 | `verify.test.mjs` (`META`), `cleanup.test.mjs` | 반영 |
| 2026-11-19 | 실사용 웹 프로젝트 T04~T05 + 3사 검토 | 범용 | Codex 전역 `hc`·`verify.ps1`·`init.ps1` 허용의 하위 세션·전역 설정 노출 | `guard.test.mjs` (`sub-rev-caller`, `worker-caller`) | 반영 |
| 2026-11-19 | 실사용 웹 프로젝트 T05 | 범용 | 실제 대상(VM·운영 DB) vs 대체(로컬·모의) 환경 완료 기준 미구분 | `DESIGNER.md`, `WORKER.md` 환경 표기 | 반영 |
| 2026-11-19 | `agent-kit` 실사용 | 범용 | PC 전체 AGY 단일 턴 강제 직렬화가 정상 병행 AGY 작업까지 차단 (`WORKER.md` 잔재 포함 제거) | `guard.test.mjs` (`rate-cooldown`), `WORKER.md` | 반영 |
| 2026-11-20 | Harness² 외부 아이디어(원칙 13) | 재평가 | Always-on 지침에 들어간 선제적 하네스 조립 문구는 덜어내고, 반복 실패 시 On-demand `RUNBOOK 15절` 진단·수정과 온디맨드 회고만 유지 | `RUNBOOK.md` 15절, `DESIGNER.md` | 축소 유지 |
| 2026-11-24 | `agent-kit` 5개 독립 세션 감사 | 범용 | AGY `GEMINI.md`+스텁 스킬 이중 읽기, `-Accept` 중복 테스트·상태 덮어쓰기, `direct` 수동 검증 push 데드락, Rust `cargo test` 오탐, `guard.mjs` `.codex/*`·`hc exec`·`..` 구멍과 커밋 화살표 오탐, `hc keys` 대리 승인 위험, 비Windows 백슬래시·심볼릭 링크 파손 | 회귀 테스트 6종 전수 보강 | 반영 |
