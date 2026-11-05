//! 🐂 Bull 큐 화면: Node.js 작업 큐 BullMQ와 옛 Bull(v3)의 큐 상태를 Redis 키에서 읽어 그림으로 보인다. 읽기만 한다.
//! 작업을 다시 시도하거나 지우지 않는다. 쓰기 명령은 `kv::command`의 허용 목록 관문이 막는다.
//!
//! - `model`: 화면으로 나가는 계약(프런트엔드의 `src/kv/types.ts`와 필드마다 맞는다)
//! - `keys`: 키 이름 만들기·읽기, 워커 연결 이름 알아보기(순수 함수)
//! - `stats`: 백분위·분포·분 단위 구간·지연 점수·실패 이유 묶기(순수 함수)
//! - `io`: 키를 읽는 얇은 도구들
//! - `queue`: 큐 찾기(SCAN), 큐 요약, 큐 상세
//! - `jobs`: 작업 표와 작업 상세

pub mod io;
pub mod jobs;
pub mod keys;
pub mod model;
pub mod queue;
pub mod stats;
