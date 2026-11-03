/**
 * cron 식을 사람 말로: "30 19 * * *" + "Asia/Seoul" → "매일 19:30 (Asia/Seoul)".
 * 흔한 모양(매분·n분마다·매시·n시간마다·매일·평일·주말·요일·매월 n일, @hourly 등)만 바꾸고, 그 밖은 원문을 그대로 돌려준다.
 * 틀리게 읽어 주느니 원문을 보이는 편이 낫기 때문이다(범위를 벗어난 값, 월 지정, 일과 요일을 함께 지정한 식도 원문).
 */

const DOW_TEXT = ["일", "월", "화", "수", "목", "금", "토"];
// 사용자가 쓴 글로 찾는 표라 Map이다(객체는 "constructor" 같은 글이 prototype에서 맞는다)
const DOW_NAMES = new Map([
  ["sun", 0],
  ["mon", 1],
  ["tue", 2],
  ["wed", 3],
  ["thu", 4],
  ["fri", 5],
  ["sat", 6],
]);

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

/** 숫자 하나(요일은 영어 줄임말도). 범위를 벗어나면 null */
function value(s: string, min: number, max: number, names?: Map<string, number>): number | null {
  const n = names?.get(s.toLowerCase()) ?? (/^\d+$/.test(s) ? Number(s) : null);
  return n !== null && n >= min && n <= max ? n : null;
}

/** `a`, `a,b`, `a-b`, 그 조합을 오름차순 값 목록으로. 모르는 모양이면 null */
function list(field: string, min: number, max: number, names?: Map<string, number>): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const ends = part.split("-");
    if (ends.length > 2) return null;
    const lo = value(ends[0], min, max, names);
    const hi = ends.length === 2 ? value(ends[1], min, max, names) : lo;
    if (lo === null || hi === null || lo > hi) return null;
    for (let i = lo; i <= hi; i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/** 정확히 한 숫자인 필드(분·시) */
const single = (field: string, min: number, max: number) => (/^\d+$/.test(field) ? value(field, min, max) : null);

/** 별표-슬래시-n 꼴 필드의 n(1 이상 max 이하) */
const step = (field: string, max: number) => {
  const m = /^\*\/(\d+)$/.exec(field);
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= max ? n : null;
};

const MACROS = new Map([
  ["@hourly", "매시 정각"],
  ["@daily", "매일 00:00"],
  ["@midnight", "매일 00:00"],
  ["@weekly", "매주 일요일 00:00"],
  ["@monthly", "매월 1일 00:00"],
  ["@yearly", "매년 1월 1일 00:00"],
  ["@annually", "매년 1월 1일 00:00"],
]);
const EVERY_UNIT = new Map([
  ["s", "초"],
  ["m", "분"],
  ["h", "시간"],
]);

function weekdays(dows: number[]): string {
  const set = [...new Set(dows.map((d) => d % 7))].sort((a, b) => a - b);
  if (set.length === 7) return "매일";
  if (set.join() === "1,2,3,4,5") return "평일";
  if (set.join() === "0,6") return "주말";
  return set.length === 1 ? `매주 ${DOW_TEXT[set[0]]}요일` : `매주 ${set.map((d) => DOW_TEXT[d]).join("·")}`;
}

/** 시간대를 뺀 식의 사람 말. 모르는 모양이면 null */
function describe(expr: string): string | null {
  const lower = expr.toLowerCase();
  const macro = MACROS.get(lower);
  if (macro) return macro;
  const every = /^@every\s+(\d+)([smh])$/.exec(lower);
  if (every) return Number(every[1]) > 0 ? `${Number(every[1])}${EVERY_UNIT.get(every[2])}마다` : null;

  const f = expr.split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour] = f;
  // ?는 *와 같다(robfig/cron)
  const dom = f[2] === "?" ? "*" : f[2];
  const dow = f[4] === "?" ? "*" : f[4];
  if (f[3] !== "*") return null;

  const m = single(min, 0, 59);
  const h = single(hour, 0, 23);
  if (dom === "*" && dow === "*") {
    if (min === "*" && hour === "*") return "매분";
    const everyMin = step(min, 59);
    if (everyMin !== null && hour === "*") return `${everyMin}분마다`;
    if (m !== null && hour === "*") return m === 0 ? "매시 정각" : `매시 ${m}분`;
    const everyHour = step(hour, 23);
    if (m !== null && everyHour !== null) return `${everyHour}시간마다 ${m === 0 ? "정각" : `${m}분`}`;
    if (m !== null && h !== null) return `매일 ${clock(h, m)}`;
    return null;
  }
  if (m === null || h === null) return null;
  if (dom === "*") {
    const days = list(dow, 0, 7, DOW_NAMES);
    return days ? `${weekdays(days)} ${clock(h, m)}` : null;
  }
  if (dow === "*") {
    const days = list(dom, 1, 31);
    return days ? `매월 ${days.join("·")}일 ${clock(h, m)}` : null;
  }
  return null;
}

/** 스케줄의 사람 말. `CRON_TZ=`·`TZ=` 접두사가 있고 timezone이 없으면 접두사의 시간대를 쓴다. 모르는 모양이면 원문 */
export function scheduleText(schedule: string, timezone: string | null): string {
  const prefixed = /^\s*(?:CRON_TZ|TZ)=(\S+)\s+(.*)$/.exec(schedule);
  const zone = timezone || prefixed?.[1] || null;
  const text = describe((prefixed ? prefixed[2] : schedule).trim());
  if (text === null) return schedule;
  return zone ? `${text} (${zone})` : text;
}
