/**
 * 퍼지 검색: 검색어의 글자가 순서대로 들어 있으면 맞다(fzf 방식). 점수는 단어 첫 글자, 이어진 글자에 더 주고 건너뛴 글자에 깎는다.
 * 그래서 `poa`는 `prod-orders-api` 위로, 글자가 여기저기 흩어져서만 맞는 문자열은 아예 거른다.
 * 검색어는 공백으로 나눈 토큰들이고 모든 토큰이 어느 필드에든 맞아야 한다(AND). 대소문자는 무시하고 한글은 NFC로 맞춘다.
 */

export interface TokenMatch {
  score: number;
  /** text(NFC) 안에서 맞은 글자 위치(오름차순) */
  indices: number[];
}

const SCORE_MATCH = 16;
const GAP_START = -3;
const GAP_EXTENSION = -1;
const BONUS_BOUNDARY = 8;
const BONUS_CAMEL = 7;
const BONUS_CONSECUTIVE = -(GAP_START + GAP_EXTENSION);
/** 토큰의 첫 글자는 그 자리의 보너스를 두 배로 받는다 */
const FIRST_CHAR_MULTIPLIER = 2;
/** 글자당 평균이 이보다 낮은 맞음(흩어진 글자)은 버린다 */
const MIN_SCORE_PER_CHAR = 14;
/** 필드 전체가 토큰과 같으면 더 준다(`web`을 찾을 때 `web`이 `web-api`보다 위) */
const BONUS_EXACT = 8;
/** 필드 맨 앞부터 맞으면 조금 더 준다(`wb`를 찾을 때 `web-1`이 `staging-web`보다 위) */
const BONUS_PREFIX = 4;
/** 뒤쪽 필드일수록 조금씩 깎는다(이름이 ID나 태그보다 앞선다) */
const FIELD_PENALTY = 1;
/** 아주 긴 문자열(긴 ARN, 경로)은 앞부분만 본다: 점수표가 토큰 × 길이만큼 커진다 */
const MAX_TEXT = 512;
const NONE = -1_000_000;

const NON_ASCII = /[^\x00-\x7f]/;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** 한글은 macOS 파일 이름처럼 NFD로 올 수 있다. 화면과 검색어는 NFC라 둘 다 NFC로 맞춘다. */
export function normalize(text: string): string {
  return NON_ASCII.test(text) ? text.normalize("NFC") : text;
}

/** 검색어를 토큰으로 나눈다(소문자, NFC). 공백뿐이면 빈 배열 */
export function tokenize(query: string): string[] {
  return normalize(query).toLowerCase().split(/\s+/).filter(Boolean);
}

type CharClass = 0 | 1 | 2 | 3; // 0 구분자, 1 소문자, 2 대문자, 3 숫자·그 밖의 글자

function classOf(code: number, ch: string): CharClass {
  if (code >= 97 && code <= 122) return 1;
  if (code >= 65 && code <= 90) return 2;
  if (code >= 48 && code <= 57) return 3;
  if (code < 128) return 0;
  return WORD_CHAR.test(ch) ? 3 : 0;
}

/** 각 글자에서 시작하는 맞음이 받을 보너스: 문자열 처음·구분자 뒤는 단어 경계, 소문자→대문자·글자→숫자는 camelCase 경계 */
function bonusAt(prev: CharClass, cur: CharClass): number {
  if (cur === 0) return 0;
  if (prev === 0) return BONUS_BOUNDARY;
  if ((prev === 1 && cur === 2) || (prev !== 3 && cur === 3)) return BONUS_CAMEL;
  return 0;
}

/** 한 글자를 소문자 코드로: 길이가 바뀌는 글자(İ 등)가 있어도 위치가 원문과 어긋나지 않게 첫 코드만 쓴다 */
function lowerAt(text: string, i: number): number {
  const code = text.charCodeAt(i);
  if (code >= 65 && code <= 90) return code + 32;
  if (code < 128) return code;
  return text[i].toLowerCase().charCodeAt(0);
}

/** 토큰(소문자, NFC) 하나가 text에 맞는지. 맞지 않거나 흩어져서만 맞으면 null */
export function matchToken(token: string, text: string): TokenMatch | null {
  const m = token.length;
  if (m === 0 || m > text.length) return null;
  const source = normalize(text);
  const n = Math.min(source.length, MAX_TEXT);
  if (m > n) return null;

  // 순서대로 들어 있는지 먼저 본다. 대부분의 필드가 여기서 걸러지므로 아무것도 만들지 않는다.
  for (let i = 0, j = 0; i < m; j++) {
    if (j >= n) return null;
    if (lowerAt(source, j) === token.charCodeAt(i)) i++;
  }
  const t = new Uint16Array(n);
  for (let j = 0; j < n; j++) t[j] = lowerAt(source, j);
  const q = new Uint16Array(m);
  for (let i = 0; i < m; i++) q[i] = token.charCodeAt(i);

  const bonus = new Int8Array(n);
  let prev: CharClass = 0;
  for (let j = 0; j < n; j++) {
    const cur = classOf(source.charCodeAt(j), source[j]);
    bonus[j] = bonusAt(prev, cur);
    prev = cur;
  }

  // score[i*n+j]: 토큰의 i번째 글자를 text의 j번째에 맞췄을 때의 최고 점수. firstBonus는 그 글자가 속한 연속 구간 첫 글자의 보너스,
  // from은 i-1번째 글자를 맞춘 자리(되짚어 강조 위치를 얻는다).
  const score = new Int32Array(m * n).fill(NONE);
  const firstBonus = new Int8Array(m * n);
  const from = new Int32Array(m * n).fill(-1);
  for (let j = 0; j < n; j++) {
    if (t[j] !== q[0]) continue;
    score[j] = SCORE_MATCH + bonus[j] * FIRST_CHAR_MULTIPLIER;
    firstBonus[j] = bonus[j];
  }
  for (let i = 1; i < m; i++) {
    const row = i * n;
    const up = row - n;
    // 한 칸 이상 건너뛴 자리(k ≤ j-2)에서 오는 최고값. 건너뛴 칸이 g면 GAP_START + (g-1)·GAP_EXTENSION = k - j - 1을 더한다.
    let bestGap = NONE;
    let bestK = -1;
    for (let j = i; j < n; j++) {
      const k = j - 2;
      if (k >= 0 && score[up + k] > NONE && score[up + k] + k > bestGap) {
        bestGap = score[up + k] + k;
        bestK = k;
      }
      if (t[j] !== q[i]) continue;
      let best = NONE;
      if (score[up + j - 1] > NONE) {
        let fb = firstBonus[up + j - 1];
        if (bonus[j] >= BONUS_BOUNDARY && bonus[j] > fb) fb = bonus[j];
        best = score[up + j - 1] + SCORE_MATCH + Math.max(bonus[j], fb, BONUS_CONSECUTIVE);
        score[row + j] = best;
        firstBonus[row + j] = fb;
        from[row + j] = j - 1;
      }
      if (bestGap > NONE) {
        const gapped = bestGap - j - 1 + SCORE_MATCH + bonus[j];
        if (gapped > best) {
          score[row + j] = gapped;
          firstBonus[row + j] = bonus[j];
          from[row + j] = bestK;
        }
      }
    }
  }

  const last = (m - 1) * n;
  let end = -1;
  for (let j = m - 1; j < n; j++) if (score[last + j] > NONE && (end < 0 || score[last + j] > score[last + end])) end = j;
  if (end < 0 || score[last + end] < m * MIN_SCORE_PER_CHAR) return null;
  const indices = new Array<number>(m);
  for (let i = m - 1, j = end; i >= 0; i--) {
    indices[i] = j;
    j = from[i * n + j];
  }
  return { score: score[last + end], indices };
}

type Field = string | null | undefined;

/** 모든 토큰이 fields 중 어딘가에 맞으면 점수(높을수록 잘 맞음), 하나라도 안 맞으면 null. fields는 중요한 것부터 준다. */
export function scoreFields(tokens: readonly string[], fields: readonly Field[]): number | null {
  let total = 0;
  for (const token of tokens) {
    let best: number | null = null;
    for (let f = 0; f < fields.length; f++) {
      const text = fields[f];
      if (!text) continue;
      const hit = matchToken(token, text);
      if (!hit) continue;
      const s = hit.score + (normalize(text).toLowerCase() === token ? BONUS_EXACT : 0) + (hit.indices[0] === 0 ? BONUS_PREFIX : 0) - f * FIELD_PENALTY;
      if (best === null || s > best) best = s;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

/** 맞는 항목과 점수. 검색어가 비면 모두 점수 0으로 원래 순서 그대로 */
export function fuzzyRank<T>(items: readonly T[], query: string, fields: (item: T) => readonly Field[]): { item: T; score: number }[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return items.map((item) => ({ item, score: 0 }));
  const ranked: { item: T; score: number; at: number }[] = [];
  items.forEach((item, at) => {
    const score = scoreFields(tokens, fields(item));
    if (score !== null) ranked.push({ item, score, at });
  });
  ranked.sort((a, b) => b.score - a.score || a.at - b.at);
  return ranked.map(({ item, score }) => ({ item, score }));
}

/** 맞는 항목만 점수 높은 순으로(같으면 원래 순서). 검색어가 비면 items 그대로 */
export function fuzzyFilter<T>(items: readonly T[], query: string, fields: (item: T) => readonly Field[]): T[] {
  return fuzzyRank(items, query, fields).map((r) => r.item);
}

/** 맞는 항목만 원래 순서대로. 화면이 정한 순서(묶음, 종류별 정렬)를 지켜야 할 때 쓴다 */
export function fuzzyKeep<T>(items: readonly T[], query: string, fields: (item: T) => readonly Field[]): T[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [...items];
  return items.filter((item) => scoreFields(tokens, fields(item)) !== null);
}

/** 강조할 글자 위치(normalize(text) 기준, 오름차순). 이 text에 맞는 토큰들의 위치를 합친다 */
export function highlightIndices(tokens: readonly string[], text: string): number[] {
  const at = new Set<number>();
  for (const token of tokens) for (const i of matchToken(token, text)?.indices ?? []) at.add(i);
  return [...at].sort((a, b) => a - b);
}
