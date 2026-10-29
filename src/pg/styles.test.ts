// vitest leaves stylesheets empty, so the file is read as text (vitest runs from the repo root). The project has no node types: the module name is kept in a variable.
const fsModule = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync: (path: string, encoding: string) => string };
const css = readFileSync("src/styles.css", "utf8");

/** 선택자 목록에 이 선택자가 낱낱으로 들어 있는 규칙이 있는지 */
const hasRule = (selector: string) =>
  css.split("\n").some((line) => {
    const head = line.split("{")[0];
    return line.includes("{") && head.split(",").some((part) => part.trim() === selector);
  });

describe("styles of the 바꾸기 mode", () => {
  test.each([".asg-tray", ".asg-tray-list", ".asg-tray-list li", ".asg-tray-list .icon", ".asg-tray-bar", ".asg-tray-toggle", ".asg-notice", ".asg-notice .icon"])(
    "the tray and notice rule %s reaches the PostgreSQL tab (.pg) and still reaches IAM (.iam-asg)",
    (sel) => {
      expect(hasRule(`.pg ${sel}`)).toBe(true);
      expect(hasRule(`.iam-asg ${sel}`)).toBe(true);
    },
  );

  test.each([".pg-brushes", ".pg-brush-sep", ".pg-cell.pg-solo", ".pg-idle .pg-mark", ".pg-live", ".pg-cell.pg-add", ".pg-marks.pg-add", ".pg-cell.pg-del", ".pg-marks.pg-del", ".pg-mark.pg-add", ".pg-mark.pg-del"])(
    "has a rule for %s",
    (sel) => {
      expect(hasRule(sel)).toBe(true);
    },
  );
});
export {};
