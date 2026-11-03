import { describe, expect, it } from "vitest";
import { scheduleText } from "./cronText";

describe("scheduleText", () => {
  it.each([
    ["* * * * *", "매분"],
    ["*/5 * * * *", "5분마다"],
    ["0 * * * *", "매시 정각"],
    ["15 * * * *", "매시 15분"],
    ["0 */6 * * *", "6시간마다 정각"],
    ["30 */2 * * *", "2시간마다 30분"],
    ["30 19 * * *", "매일 19:30"],
    ["5 9 * * *", "매일 09:05"],
    ["0 9 * * 1-5", "평일 09:00"],
    ["0 9 * * MON-FRI", "평일 09:00"],
    ["0 10 * * 0,6", "주말 10:00"],
    ["0 10 * * 7,6", "주말 10:00"],
    ["0 8 * * 1,3,5", "매주 월·수·금 08:00"],
    ["0 8 * * 1", "매주 월요일 08:00"],
    ["0 8 * * 0-6", "매일 08:00"],
    ["0 3 1 * *", "매월 1일 03:00"],
    ["0 3 1,15 * *", "매월 1·15일 03:00"],
    ["0 3 ? * 2", "매주 화요일 03:00"],
    ["@hourly", "매시 정각"],
    ["@daily", "매일 00:00"],
    ["@weekly", "매주 일요일 00:00"],
    ["@monthly", "매월 1일 00:00"],
    ["@yearly", "매년 1월 1일 00:00"],
    ["@every 10m", "10분마다"],
    ["@every 2h", "2시간마다"],
  ])("%s → %s", (schedule, text) => {
    expect(scheduleText(schedule, null)).toBe(text);
  });

  it("시간대를 괄호로 붙인다", () => {
    expect(scheduleText("30 19 * * *", "Asia/Seoul")).toBe("매일 19:30 (Asia/Seoul)");
  });

  it("CRON_TZ 접두사의 시간대를 쓰고, timezone이 있으면 그것이 우선한다", () => {
    expect(scheduleText("CRON_TZ=Asia/Seoul 30 19 * * *", null)).toBe("매일 19:30 (Asia/Seoul)");
    expect(scheduleText("TZ=UTC 0 9 * * *", "Asia/Seoul")).toBe("매일 09:00 (Asia/Seoul)");
  });

  it.each([
    "0 9 * 1 *", // 월 지정
    "0 9 1 * 1", // 일과 요일을 함께
    "0 9,18 * * *", // 시 목록
    "*/70 * * * *", // 범위 밖
    "61 9 * * *",
    "0 25 * * *",
    "0 9 32 * *",
    "0 9 * * 8",
    "0 9 * * 5-1",
    "0 0 L * *",
    "0 9 * * *  *", // 칸 수가 다름
    "@every 0m",
    "@reboot",
    "아무 말",
    "",
  ])("모르는 모양 %j은 원문 그대로", (schedule) => {
    expect(scheduleText(schedule, "Asia/Seoul")).toBe(schedule);
  });
});
