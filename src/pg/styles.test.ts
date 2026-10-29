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

  test.each([".pg-brushes", ".pg-brush-sep", ".pg-cell.pg-solo", ".pg-idle .pg-mark", ".pg-grid .pg-table .pg-row .pg-live", ".pg-cell.pg-add", ".pg-marks.pg-add", ".pg-cell.pg-del", ".pg-marks.pg-del", ".pg-mark.pg-add", ".pg-mark.pg-del"])(
    "has a rule for %s",
    (sel) => {
      expect(hasRule(sel)).toBe(true);
    },
  );

  const at = (selector: string) => css.split("\n").findIndex((line) => line.includes("{") && line.split("{")[0].split(",").some((part) => part.trim() === selector));

  test("the tint of the live database column is as specific as the row stripe and comes after it, so it shows on every row", () => {
    expect(at(".pg-grid .pg-table .pg-row .pg-live")).toBeGreaterThan(at(".pg-grid .pg-table .pg-even .pg-td"));
  });

  test("the live tint also wins on a hovered row: a rule for it comes after the row hover rule", () => {
    expect(hasRule(".pg-grid .pg-table .pg-row:hover .pg-live")).toBe(true);
    expect(at(".pg-grid .pg-table .pg-row:hover .pg-live")).toBeGreaterThan(at(".pg-grid .pg-table .pg-row:hover .pg-td"));
  });

  test("an idle cell that is also dimmed stays at the idle opacity: the idle rule comes after the dimmed one", () => {
    expect(at(".pg-idle .pg-mark")).toBeGreaterThan(at(".pg-dimmed .pg-mark"));
  });

  test.each([".pg-revoke.on", ".pg-priv-edit", ".sheet.pg-form", ".pg-form-checks", ".pg-attr-form", ".pg-schema-privs"])("has a rule for %s", (sel) => {
    expect(hasRule(sel)).toBe(true);
  });
});
export {};
