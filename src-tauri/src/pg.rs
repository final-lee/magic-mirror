//! RDS PostgreSQL 사용자 관리(1단계, 읽기): 대상 확인, IAM 인증으로 접속, 연결 보관.
//! 앱은 VPN으로 엔드포인트에 직접 연결하고 IAM 데이터베이스 인증으로만 로그인한다. TLS는 항상 켜져 있고 앱에 넣은 RDS 전역 CA로 검증한다.
//!
//! - `target`: RDS API로 클러스터·인스턴스의 엔드포인트와 IAM 인증 여부를 읽는다. DB에는 연결하지 않는다.
//! - `connect`: IAM 인증 토큰, TLS, `tokio-postgres` 연결, 접속 오류를 사용자 문구로 바꾸기
//! - `pool`: (대상, DB 사용자, 데이터베이스)마다 연결 하나를 보관하고 10분 동안 안 쓰면 닫는다

pub mod connect;
pub mod pool;
pub mod target;

#[cfg(test)]
mod fake_server;
