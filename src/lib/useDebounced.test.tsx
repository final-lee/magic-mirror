import { act, renderHook } from "@testing-library/react";
import { useDebounced } from "./useDebounced";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const setup = (initial: string, delay = 250) => renderHook(({ value }) => useDebounced(value, delay), { initialProps: { value: initial } });

test("starts with the value it is given, with no wait", () => {
  const { result } = setup("first");
  expect(result.current).toBe("first");
});

test("a new value arrives after the delay, and not before", () => {
  const { result, rerender } = setup("");
  rerender({ value: "ord" });
  act(() => void vi.advanceTimersByTime(249));
  expect(result.current).toBe("");
  act(() => void vi.advanceTimersByTime(1));
  expect(result.current).toBe("ord");
});

test("every change within the delay starts the wait again, so only the last value arrives", () => {
  const { result, rerender } = setup("");
  const seen: string[] = [];
  const watch = () => seen.push(result.current);
  rerender({ value: "o" });
  act(() => void vi.advanceTimersByTime(200));
  rerender({ value: "or" });
  act(() => void vi.advanceTimersByTime(200));
  watch();
  rerender({ value: "ord" });
  act(() => void vi.advanceTimersByTime(249));
  watch();
  act(() => void vi.advanceTimersByTime(1));
  watch();
  expect(seen).toEqual(["", "", "ord"]);
});

test("a value that comes back to the one shown changes nothing", () => {
  const { result, rerender } = setup("a");
  rerender({ value: "b" });
  rerender({ value: "a" });
  act(() => void vi.advanceTimersByTime(250));
  expect(result.current).toBe("a");
});

test("leaves no timer behind when it goes away", () => {
  const { rerender, unmount } = setup("");
  rerender({ value: "x" });
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
