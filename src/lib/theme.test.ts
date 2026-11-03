import { applyTheme } from "./theme";

test("시스템 설정을 따르며 변경을 반영하고 명시한 테마는 유지한다", () => {
  let dark = false;
  const listeners = new Set<() => void>();
  const media = {
    get matches() { return dark; },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  const cleanup = applyTheme("system");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(document.documentElement.style.colorScheme).toBe("light");
  dark = true;
  listeners.forEach((listener) => listener());
  expect(document.documentElement.dataset.theme).toBe("dark");
  cleanup();
  const cleanupLight = applyTheme("light");
  expect(document.documentElement.dataset.theme).toBe("light");
  dark = false;
  listeners.forEach((listener) => listener());
  expect(document.documentElement.dataset.theme).toBe("light");
  cleanupLight();
  const cleanupDark = applyTheme("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  cleanupDark();
  vi.unstubAllGlobals();
});
