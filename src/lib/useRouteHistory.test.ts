import { act, renderHook } from "@testing-library/react";
import { useRouteHistory } from "./useRouteHistory";

interface Route {
  screen: string;
  id?: string;
  tab?: string;
}

// 같은 화면은 screen과 id가 같은 것. tab은 그 화면에서 보던 상태다.
const byScreenAndId = (a: Route, b: Route) => a.screen === b.screen && a.id === b.id;
// 더 엄격한 기준: tab까지 같아야 같은 화면
const byEverything = (a: Route, b: Route) => byScreenAndId(a, b) && a.tab === b.tab;

const home: Route = { screen: "home" };
const item: Route = { screen: "list", id: "a" };

function setup(same = byScreenAndId) {
  return renderHook(() => useRouteHistory(home, same));
}

test("starts at the initial route with nothing to go back or forward to", () => {
  const { result } = setup();
  expect(result.current.route).toEqual(home);
  expect(result.current.canBack).toBe(false);
  expect(result.current.canForward).toBe(false);
});

test("navigate pushes entries; back and forward walk through them", () => {
  const { result } = setup();
  act(() => result.current.navigate(item));
  act(() => result.current.navigate({ screen: "list", id: "b" }));
  act(() => result.current.back());
  expect(result.current.route).toEqual(item);
  expect(result.current.canForward).toBe(true);
  act(() => result.current.forward());
  expect(result.current.route).toEqual({ screen: "list", id: "b" });
});

test("the identity function given by the caller decides which navigations add an entry", () => {
  const loose = setup(byScreenAndId);
  act(() => loose.result.current.navigate(item));
  act(() => loose.result.current.navigate({ ...item, tab: "keys" })); // 같은 화면: 쌓지 않는다
  act(() => loose.result.current.back());
  expect(loose.result.current.route).toEqual(home);

  const strict = setup(byEverything);
  act(() => strict.result.current.navigate(item));
  act(() => strict.result.current.navigate({ ...item, tab: "keys" })); // 다른 화면: 쌓는다
  act(() => strict.result.current.back());
  expect(strict.result.current.route).toEqual(item);
});

test("back at the first entry and forward at the last entry stay where they are", () => {
  const { result } = setup();
  act(() => result.current.back());
  expect(result.current.route).toEqual(home);
  expect(result.current.canBack).toBe(false);
  act(() => result.current.navigate(item));
  act(() => result.current.forward());
  expect(result.current.route).toEqual(item);
  expect(result.current.canForward).toBe(false);
  // 끝에서 더 눌러도 처음과 끝 사이를 벗어나지 않는다
  act(() => result.current.back());
  act(() => result.current.back());
  act(() => result.current.back());
  expect(result.current.route).toEqual(home);
  act(() => result.current.forward());
  expect(result.current.route).toEqual(item);
});

test("navigating after going back drops the forward entries", () => {
  const { result } = setup();
  act(() => result.current.navigate(item));
  act(() => result.current.back());
  act(() => result.current.navigate({ screen: "other" }));
  expect(result.current.canForward).toBe(false);
});

test("replace updates the current entry without adding history", () => {
  const { result } = setup();
  act(() => result.current.navigate(item));
  act(() => result.current.replace((r) => ({ ...r, tab: "policies" })));
  expect(result.current.route).toEqual({ ...item, tab: "policies" });
  act(() => result.current.back());
  expect(result.current.route).toEqual(home);
  act(() => result.current.forward());
  expect(result.current.route).toEqual({ ...item, tab: "policies" });
});

test("navigate, back, forward and replace keep their identity between renders", () => {
  const { result, rerender } = setup();
  const first = result.current;
  act(() => result.current.navigate(item));
  rerender();
  expect(result.current.navigate).toBe(first.navigate);
  expect(result.current.back).toBe(first.back);
  expect(result.current.forward).toBe(first.forward);
  expect(result.current.replace).toBe(first.replace);
});

test("history length is capped at 100 entries, dropping the oldest", () => {
  const { result } = setup();
  for (let i = 0; i < 150; i++) act(() => result.current.navigate({ screen: "list", id: `n${i}` }));
  let steps = 0;
  while (result.current.canBack) {
    act(() => result.current.back());
    steps++;
  }
  expect(steps).toBe(99);
  expect(result.current.route).toEqual({ screen: "list", id: "n50" });
});
