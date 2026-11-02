import "@testing-library/jest-dom/vitest";

// jsdom has no PointerEvent; without it pointer events lose clientX/buttons/button.
if (typeof window !== "undefined" && !("PointerEvent" in window)) {
  class PointerEventPolyfill extends MouseEvent {}
  (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = PointerEventPolyfill;
}

// Tauri 플러그인/앱 API는 테스트 환경에 없으므로 기본 목을 둔다(개별 테스트에서 덮어쓸 수 있다).
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.1.0") }));

// jsdom에는 Range의 위치 계산이 없다. CodeMirror가 화면 크기를 잴 때 부르므로 빈 값을 돌려주는 것으로 대신한다.
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  const none = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getClientRects = none;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}
