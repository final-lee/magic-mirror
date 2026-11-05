//! ElastiCache 키 탐색(Valkey·Redis OSS, 읽기 전용): 대상 확인, 로그인(없음·AUTH 토큰·사용자·IAM), 연결 보관, 키·값·서버 상태 읽기, 🐂 Bull 큐 화면.
//! 앱은 VPN 같은 네트워크 경로로 엔드포인트에 직접 연결한다. TLS는 캐시가 켰으면 쓰고 시스템 루트로 검증한다.
//! 서버에 보내는 명령은 모두 허용 목록 관문(`command`) 하나를 거친다. 쓰기 명령은 보낼 수 없다.
//!
//! - `model`: 화면으로 나가는 계약(프런트엔드의 `src/kv/types.ts`와 필드마다 맞는다)
//! - `target`: ElastiCache API로 대상을 읽는다. 캐시에는 연결하지 않는다.
//! - `iam`: IAM 인증 토큰(SigV4)과 fred의 `CredentialProvider`
//! - `command`: 허용 목록 관문. fred의 `custom`을 부르는 유일한 곳이다.
//! - `connect`: TLS, fred 클라이언트, 토폴로지, 연결 하나(`Connected`)
//! - `failure`: 접속·명령 오류를 사용자 문구로
//! - `pool`: 대상(탭)마다 연결 하나를 보관하고 10분 동안 안 쓰면 닫는다
//! - `password`: 비밀번호·AUTH 토큰의 키체인 저장
//! - `value`, `info`, `topology`, `cursor`: 서버 답을 읽는 순수 함수와 불투명 커서
//! - `overview`, `scan`, `key`, `slowlog`, `clients`, `bigkeys`: 화면별 읽기
//! - `bull`: Bull·BullMQ 큐 읽기
//!
//! 명령(Tauri)과 세션의 보관은 `kv_commands`에 있다. 허용 목록 밖의 명령이 없다는 약속은 시험 `hygiene`이 지킨다.

pub mod bigkeys;
pub mod bull;
pub mod clients;
pub mod command;
pub mod connect;
pub mod cursor;
pub mod failure;
pub mod iam;
pub mod info;
pub mod key;
pub mod model;
pub mod overview;
pub mod password;
pub mod pool;
pub mod scan;
pub mod slowlog;
pub mod login;
pub mod target;
pub mod topology;
pub mod value;

#[cfg(test)]
pub(crate) mod fake_server;
#[cfg(test)]
mod hygiene;
#[cfg(test)]
mod live_tests;
