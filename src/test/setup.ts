import "@testing-library/jest-dom/vitest";

// jsdom has no PointerEvent; without it pointer events lose clientX/buttons/button.
if (typeof window !== "undefined" && !("PointerEvent" in window)) {
  class PointerEventPolyfill extends MouseEvent {}
  (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = PointerEventPolyfill;
}
