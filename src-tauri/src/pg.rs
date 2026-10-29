//! RDS PostgreSQL 사용자 관리(1단계, 읽기): 대상 확인, IAM 인증으로 접속, 연결 보관, 카탈로그 읽기.
//! 앱은 VPN으로 엔드포인트에 직접 연결하고 IAM 데이터베이스 인증으로만 로그인한다. TLS는 항상 켜져 있고 앱에 넣은 RDS 전역 CA로 검증한다.
//! 읽기(1단계)의 모든 질의는 읽기 전용 트랜잭션 안에서 돈다(`catalog`). 변경(2단계)의 문장은 `exec`가 트랜잭션 하나로 보낸다.
//!
//! - `target`: RDS API로 클러스터·인스턴스의 엔드포인트와 IAM 인증 여부를 읽는다. DB에는 연결하지 않는다.
//! - `connect`: IAM 인증 토큰, TLS, `tokio-postgres` 연결, 접속 오류를 사용자 문구로 바꾸기
//! - `pool`: (대상, DB 사용자, 데이터베이스)마다 연결 하나를 보관하고 10분 동안 안 쓰면 닫는다
//! - `model`: 카탈로그 스냅숏의 레코드(역할, 구성원 관계, 데이터베이스, 스키마, 관계, 함수, 기본 권한, 세션)
//! - `catalog`: 카탈로그를 읽어 스냅숏을 만든다. 읽기 질의를 보내고 읽기 전용 트랜잭션을 여는 유일한 곳이다.
//! - `exec`: 변경 문장을 보내고 쓰기 트랜잭션을 여는 유일한 곳이다. `commit`이 관문을 지난 문장만 넘긴다.
//! - `eval`: 스냅숏만으로 실효 권한을 계산한다(순수 함수). 역할이 객체에 권한을 어디서 받는지, 실제로 쓸 수 있는지, 스키마별 요약, 누가 할 수 있나.
//! - `view`: 화면으로 나가는 계약(명령이 돌려주는 값의 모양). 프런트엔드의 `src/pg/types.ts`와 필드마다 맞는다.
//! - `summary`: 스냅숏과 `eval`로 계약의 값을 만든다(순수 함수). 역할 요약·개요, 권한 표, 칸 상세, 객체 검색, 역할 상세, 누가 할 수 있나, 세션.
//! - `checks`: 스냅숏을 보고 보안 점검 열 가지를 찾는다(순수 함수).
//!
//! 2단계(변경)의 순수한 부품들:
//! - `sql`: 문장에 이름과 값을 넣는 유일한 길(`ident`, `literal`, `grantee`)
//! - `password`: 새 비밀번호를 만들고 SCRAM-SHA-256 검증값으로 바꾼다. 평문도 검증값도 `Debug`에 찍히지 않는다.
//! - `change`: 변경의 모양(`model`), 문장 만들기(`sql_text`), 화면 문구(`text`)
//!
//! - `preset`: 새 역할의 프리셋 제안(같은 권한을 가진 그룹, 새 그룹의 이름, 기본 권한을 줄 만드는 역할)
//! - `drop`: 역할 안전하게 삭제하기. 데이터베이스마다 소유권을 넘기고 권한을 거두는 계획과, 첫 실패에서 멈추는 실행
//!
//! 명령(Tauri)과 읽어 둔 값의 보관은 `pg_commands`에 있다. 질의를 보내거나 트랜잭션을 여는 곳이 `catalog` 하나뿐이라는 약속은 시험 `hygiene`이 지킨다.

pub mod catalog;
pub mod checks;
pub mod connect;
pub mod eval;
pub mod exec;
pub mod model;
pub mod pool;
pub mod summary;
pub mod target;
pub mod view;

pub mod change;
pub mod commit;
pub mod drop;
pub mod log;
pub mod password;
pub mod preset;
pub mod sql;

#[cfg(test)]
pub(crate) mod fake_server;
#[cfg(test)]
pub(crate) mod fixtures;
#[cfg(test)]
mod hygiene;
#[cfg(test)]
mod live_tests;
