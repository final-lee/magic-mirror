import { act, renderHook } from "@testing-library/react";
import type { IamRoute } from "./route";
import { useIamHistory } from "./useIamHistory";

const home: IamRoute = { view: "users" };
const alice: IamRoute = { view: "users", id: "alice" };
const role: IamRoute = { view: "roles", id: "r1" };

function setup() {
  return renderHook(() => useIamHistory(home));
}

test("starts at the initial route with nothing to go back or forward to", () => {
  const { result } = setup();
  expect(result.current.route).toEqual(home);
  expect(result.current.canBack).toBe(false);
  expect(result.current.canForward).toBe(false);
});

test("navigate pushes entries; back and forward move through them", () => {
  const { result } = setup();
  act(() => result.current.navigate(alice));
  act(() => result.current.navigate(role));
  expect(result.current.route).toEqual(role);
  expect(result.current.canBack).toBe(true);

  act(() => result.current.back());
  expect(result.current.route).toEqual(alice);
  expect(result.current.canForward).toBe(true);
  act(() => result.current.back());
  expect(result.current.route).toEqual(home);
  expect(result.current.canBack).toBe(false);

  act(() => result.current.forward());
  act(() => result.current.forward());
  expect(result.current.route).toEqual(role);
  expect(result.current.canForward).toBe(false);
});

test("back at the start and forward at the end do nothing", () => {
  const { result } = setup();
  act(() => result.current.back());
  act(() => result.current.forward());
  expect(result.current.route).toEqual(home);
});

test("navigating after going back drops the forward entries", () => {
  const { result } = setup();
  act(() => result.current.navigate(alice));
  act(() => result.current.navigate(role));
  act(() => result.current.back());
  act(() => result.current.navigate({ view: "groups" }));
  expect(result.current.canForward).toBe(false);
  act(() => result.current.back());
  expect(result.current.route).toEqual(alice);
});

test("navigating to the current view and id does not add an entry", () => {
  const { result } = setup();
  act(() => result.current.navigate(alice));
  act(() => result.current.navigate({ ...alice, tab: "keys" }));
  act(() => result.current.back());
  expect(result.current.route).toEqual(home);
});

test("replace updates the current entry without adding history", () => {
  const { result } = setup();
  act(() => result.current.navigate(alice));
  act(() => result.current.replace((r) => ({ ...r, tab: "policies" })));
  expect(result.current.route).toEqual({ ...alice, tab: "policies" });
  act(() => result.current.navigate(role));
  act(() => result.current.back());
  expect(result.current.route).toEqual({ ...alice, tab: "policies" });
  act(() => result.current.back());
  expect(result.current.route).toEqual(home);
});

test("history length is capped, dropping the oldest entries", () => {
  const { result } = setup();
  for (let i = 0; i < 150; i++) act(() => result.current.navigate({ view: "users", id: `u${i}` }));
  expect(result.current.route).toEqual({ view: "users", id: "u149" });
  let steps = 0;
  while (result.current.canBack) {
    act(() => result.current.back());
    steps++;
  }
  expect(steps).toBeLessThanOrEqual(100);
  expect(steps).toBeGreaterThan(50);
});
