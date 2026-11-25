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
| 2026-11-20 | Harness² 외부 아이디어(원칙 13) | 재평가 | 별도 파일 없는 인계 내 조건부 선제 조립(큰·`critical`·테스트 부재 작업의 고유 함정·저장소 내 전용 검증 연결) + 반복 실패 시 `RUNBOOK 15절` 1회 수정·온디맨드 회고로 정제 유지 | `DESIGNER.md`, `_TEMPLATE.md`, `RUNBOOK.md` 15절 | 정제 유지 |
| 2026-11-24 | `agent-kit` 5개 독립 세션 감사 + 재평가 | 범용 | AGY `GEMINI.md`+스텁 스킬 이중 읽기, `-Accept` 중복 테스트·상태 덮어쓰기, `direct` 수동 검증 push 데드락 및 완료 작업 이후 일반 push 영구 차단, Rust `cargo test` 오탐, 헤드리스 검토 전환 시 `guard.mjs` `-review-5`·`--mode plan`·`AGENTKIT_ROLE` 누락 및 일반 편집 시 `hc get` 지연, `.codex/*`·`hc exec`·`cmd /d /c`·`..` 구멍과 커밋 화살표 오탐, 비Windows 백슬래시·심볼릭 링크 파손 | `node test.mjs` (회귀 테스트 6종) | 반영 |
| 2026-11-25 | 독립 검토의 임시 저장소·가상 훅 이벤트 재현 | 범용 | `-TrackSpec`에서 미추적·수정된 지침 파일로 검증·수락 실패, `direct`에서 접은 작업의 승인이 남아 기준 브랜치 push 차단, 중복 `-Accept` 거부 사유가 worker PASS 부재로 읽힘, Claude `--restricted`가 전역 가드 훅을 건너뜀, 작업자 `-Prepar` 축약 누락 | `verify.test.mjs` (TrackSpec·`-Cancel` 픽스처), `pre-push.test.mjs` (`-Cancel`), `guard.test.mjs` (`--restricted`·`-Cancel`) | 반영 |
| 2026-11-25 | `probes/` 검토자 시험 실제 실행 | 범용 | 헤드리스 검토 명령이 문서대로는 실행되지 않음: `agy -p` 바로 뒤에 옵션을 두면 그 옵션이 프롬프트로 읽혀 즉시 실패, Codex 명령은 Windows PowerShell 5.1이 큰따옴표를 지워 설정 파싱 실패, Claude `Write(경로)` 허용 규칙은 적용되지 않음(경고) | `guard.test.mjs` (`-p "<프롬프트>"` 형식), `probes/results.md` 2026-11-25 | 반영(Antigravity·Codex 끝까지 실행은 한도 소진으로 미확인) |
| 2026-11-26 | 다섯 관점 독립 검토(`handoff/sub-agentk-*-review-1-report.md`)와 실행 대조 | 범용 | worktree·상위 `CLAUDE.md` 때문에 `AGENTS.md`와 역할 파일이 로드되지 않음, 검토 명령의 맨 `Read` 허용이 PC 전체 읽기를 엶, 하위 세션에 도구 자동 메모리가 들어옴, 작업자가 검토 보고서·지침 파일을 직접 씀, 같은 명령 안의 `cd` 뒤 보호 파일 쓰기와 `curl -o` 저장이 가드를 지나침, 대리 승인이 문장으로만 금지됨, 검토자 심각도 기준 부재 | `guard.test.mjs`(역할별 쓰기·`cd`·대리 승인·push 범위), `pre-push.test.mjs`(`AGENTS-LOAD`), `probes/results.md` 2026-11-26(결함·대조 사례) | 반영 |
| 2026-11-26 | 사용자 결정 | 범용 | 작은 일반 작업은 설계자가 직접 구현(`impl: designer`, 수락에 맥락 없는 검토 보고 필수), Claude는 플러그인 배포(Codex·Antigravity 플러그인은 훅 실행 미확인), push 규칙은 키트 저장소에만 적용 | `verify.test.mjs`(`SELF`), `install.test.mjs`(매니페스트·`-Tools`), `guard.test.mjs`(일반 저장소 push) | 반영(설계자 직접 구현 흐름의 행동 시험은 미실시) |
