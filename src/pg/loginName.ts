/**
 * DB 사용자 이름 검사. 백엔드의 `check_login_name`(src-tauri/src/pg/connect.rs)과 같은 규칙, 같은 순서, 같은 문구다.
 * 백엔드는 토큰을 서명하기 전에 이런 이름을 거절한다. 그 전에 입력창에서 막아, 거절될 이름이 설정 파일에 남지 않게 한다.
 * 규칙을 바꿀 때는 두 쪽을 함께 고친다. 호출하는 쪽은 앞뒤 공백을 걷어낸 이름을 넘긴다.
 */

export const LOGIN_NAME_INVALID = 'DB 사용자 이름이 올바르지 않아요. 공백이나 " < > # & % + 같은 문자는 쓸 수 없어요';
export const LOGIN_NAME_TOO_LONG = "DB 사용자 이름은 63바이트까지 쓸 수 있어요";

/** PostgreSQL의 식별자 한도(`NAMEDATALEN - 1`). 글자 수가 아니라 UTF-8 바이트 수다 */
const MAX_LOGIN_NAME_BYTES = 63;

/**
 * 공백, 제어 문자, 그리고 `" < > # & % +`. Rust의 `char::is_whitespace`는 유니코드 White_Space 속성이고 `char::is_control`은 범주 Cc라서
 * 아래 두 속성이 백엔드와 정확히 같다. 자바스크립트의 `\s`는 U+FEFF도 잡아서 맞지 않는다.
 */
const UNSAFE_CHAR = /[\p{White_Space}\p{Cc}"<>#&%+]/u;

const encoder = new TextEncoder();

/**
 * 백엔드가 거절할 이름이면 그 문구를, 아니면 null. 먼저 길이를 보고(서버는 63바이트를 넘는 이름을 잘라 읽는다) 그다음 문자를 본다.
 * 빈 이름은 백엔드에서는 거절 대상이지만 여기서는 문구 없이 null이다: 입력 전에 오류를 보일 까닭이 없고, 프롬프트가 [연결]만 막는다.
 */
export function loginNameError(name: string): string | null {
  if (encoder.encode(name).length > MAX_LOGIN_NAME_BYTES) return LOGIN_NAME_TOO_LONG;
  return UNSAFE_CHAR.test(name) ? LOGIN_NAME_INVALID : null;
}
