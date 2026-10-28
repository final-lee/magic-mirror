import { LOGIN_NAME_INVALID, LOGIN_NAME_TOO_LONG, loginNameError } from "./loginName";

// 백엔드 check_login_name(src-tauri/src/pg/connect.rs)과 같은 규칙이다. 사례는 connect/tests.rs에서 가져왔다.

// 눈에 보이지 않는 문자는 코드 포인트로 쓴다
const ch = (codePoint: number) => String.fromCodePoint(codePoint);
const IDEOGRAPHIC_SPACE = ch(0x3000);
const NUL = ch(0x00);
const NEL = ch(0x85); // 공백이면서 제어 문자이기도 하다
const DEL = ch(0x7f);
const C1_CONTROL = ch(0x9b);
const BOM = ch(0xfeff); // 자바스크립트의 \s에는 걸리고, Rust의 is_whitespace·is_control에는 걸리지 않는다

const hangul = (chars: number) => "가".repeat(chars);

test("the two messages are the backend's, word for word", () => {
  expect(LOGIN_NAME_INVALID).toBe('DB 사용자 이름이 올바르지 않아요. 공백이나 " < > # & % + 같은 문자는 쓸 수 없어요');
  expect(LOGIN_NAME_TOO_LONG).toBe("DB 사용자 이름은 63바이트까지 쓸 수 있어요");
});

test.each(["iam_admin", "관리자", "IAM-Admin.01", "user@corp", "a_b"])("an ordinary name passes: %s", (name) => {
  expect(loginNameError(name)).toBeNull();
});

// UNSAFE_LOGINS 가운데 가장자리 공백을 걷어낸 뒤에도 남는 것(앞뒤 공백·줄 바꿈·탭·공백만은 프롬프트가 trim으로 걷어낸다)
test.each([
  ["inner space", "iam admin"],
  ["ideographic space (U+3000)", `iam${IDEOGRAPHIC_SPACE}admin`],
  ["NUL", `iam${NUL}admin`],
  ["DEL", `iam${DEL}admin`],
  ["C1 control (U+009B)", `iam${C1_CONTROL}admin`],
  ["double quote", 'a"b'],
  ["less-than", "a<b"],
  ["greater-than", "a>b"],
  ["number sign", "a#b"],
  ["ampersand", "a&b"],
  ["percent", "a%b"],
  ["plus", "a+b"],
])("a name with %s is refused with the invalid-name message", (_case, name) => {
  expect(loginNameError(name)).toBe(LOGIN_NAME_INVALID);
});

test("the whitespace and control rules are Unicode's, as Rust's char methods are, not JavaScript's \\s", () => {
  // NEL(U+0085)은 공백이면서 제어 문자다. 두 쪽 모두 거절한다
  expect(loginNameError(`a${NEL}b`)).toBe(LOGIN_NAME_INVALID);
  // BOM(U+FEFF)은 자바스크립트의 \s에는 걸리지만 Rust에는 걸리지 않는다. 백엔드가 받는 이름은 여기서도 받는다
  expect(loginNameError(`a${BOM}b`)).toBeNull();
  // 줄 바꿈과 탭도 가운데에 있으면 공백이다
  expect(loginNameError("a\nb")).toBe(LOGIN_NAME_INVALID);
  expect(loginNameError("a\tb")).toBe(LOGIN_NAME_INVALID);
});

test("an empty name has no message of its own: the prompt only keeps its button off", () => {
  expect(loginNameError("")).toBeNull();
});

test.each([
  ["21 Korean letters", hangul(21)],
  ["20 Korean letters and abc", `${hangul(20)}abc`],
  ["63 ASCII letters", "a".repeat(63)],
  ["10 Korean letters and 33 ASCII letters", `${hangul(10)}${"a".repeat(33)}`],
])("a name of exactly 63 bytes passes: %s", (_case, name) => {
  expect(new TextEncoder().encode(name).length).toBe(63);
  expect(loginNameError(name)).toBeNull();
});

test.each([
  ["21 Korean letters and one more ASCII letter", `${hangul(21)}a`],
  ["64 ASCII letters", "a".repeat(64)],
  ["22 Korean letters", hangul(22)],
  ["10 Korean letters and 34 ASCII letters", `${hangul(10)}${"a".repeat(34)}`],
])("a name over 63 bytes is refused with the length message: %s", (_case, name) => {
  expect(new TextEncoder().encode(name).length).toBeGreaterThanOrEqual(64);
  expect(loginNameError(name)).toBe(LOGIN_NAME_TOO_LONG);
});

test("the length counts bytes, not letters: a name of 22 letters can already be too long", () => {
  const name = `${hangul(21)}a`;
  expect([...name].length).toBe(22);
  expect(loginNameError(name)).toBe(LOGIN_NAME_TOO_LONG);
});

test("the length is checked before the characters, as in the backend", () => {
  expect(loginNameError(`${"a".repeat(40)} ${"b".repeat(40)}`)).toBe(LOGIN_NAME_TOO_LONG);
  expect(loginNameError("a b")).toBe(LOGIN_NAME_INVALID);
});
