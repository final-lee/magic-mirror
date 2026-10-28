//! RDS PostgreSQL 사용자 관리(1단계, 읽기): 대상 확인, IAM 인증으로 접속, 연결 보관, 카탈로그 읽기.
//! 앱은 VPN으로 엔드포인트에 직접 연결하고 IAM 데이터베이스 인증으로만 로그인한다. TLS는 항상 켜져 있고 앱에 넣은 RDS 전역 CA로 검증한다.
//! 1단계는 데이터베이스에 아무것도 쓰지 않는다. 모든 질의는 읽기 전용 트랜잭션 안에서 돈다.
//!
//! - `target`: RDS API로 클러스터·인스턴스의 엔드포인트와 IAM 인증 여부를 읽는다. DB에는 연결하지 않는다.
//! - `connect`: IAM 인증 토큰, TLS, `tokio-postgres` 연결, 접속 오류를 사용자 문구로 바꾸기
//! - `pool`: (대상, DB 사용자, 데이터베이스)마다 연결 하나를 보관하고 10분 동안 안 쓰면 닫는다
//! - `model`: 카탈로그 스냅숏의 레코드(역할, 구성원 관계, 데이터베이스, 스키마, 관계, 함수, 기본 권한, 세션)
//! - `catalog`: 카탈로그를 읽어 스냅숏을 만든다. 질의를 보내고 트랜잭션을 여는 유일한 곳이다.
//! - `eval`: 스냅숏만으로 실효 권한을 계산한다(순수 함수). 역할이 객체에 권한을 어디서 받는지, 실제로 쓸 수 있는지, 스키마별 요약, 누가 할 수 있나.

pub mod catalog;
pub mod connect;
pub mod eval;
pub mod model;
pub mod pool;
pub mod target;

#[cfg(test)]
mod fake_server;
#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod live_tests;
