import { act, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { useAddedColumns } from "./useAddedColumns";

const A = "arn:aws:iam::aws:policy/A";
const B = "arn:aws:iam::aws:policy/B";

test("starts with no added columns", () => {
  const { result } = renderHook(() => useAddedColumns("prod"));
  expect(result.current.arns).toEqual([]);
});

test("adds in the order given and ignores one that is already there", () => {
  const { result } = renderHook(() => useAddedColumns("prod"));
  act(() => result.current.add(A));
  act(() => result.current.add(B));
  expect(result.current.arns).toEqual([A, B]);
  const before = result.current.arns;
  act(() => result.current.add(A));
  expect(result.current.arns).toBe(before); // 같은 배열: 아무것도 바뀌지 않았다
});

test("several adds in one go compose", () => {
  const { result } = renderHook(() => useAddedColumns("prod"));
  act(() => {
    result.current.add(A);
    result.current.add(B);
    result.current.add(A);
  });
  expect(result.current.arns).toEqual([A, B]);
});

describe("the list belongs to one profile", () => {
  test("another profile starts empty, and the old list is never seen under it, not even for one render", () => {
    const seen: { profile: string; arns: string[] }[] = [];
    const { result, rerender } = renderHook(
      ({ profile }) => {
        const added = useAddedColumns(profile);
        seen.push({ profile, arns: added.arns });
        return added;
      },
      { initialProps: { profile: "prod" } },
    );
    act(() => result.current.add(A));
    seen.length = 0;
    rerender({ profile: "dev" });
    expect(result.current.arns).toEqual([]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((s) => s.profile === "dev").every((s) => s.arns.length === 0)).toBe(true);
  });

  test("going back to the first profile does not bring its list back", () => {
    const { result, rerender } = renderHook(({ profile }) => useAddedColumns(profile), { initialProps: { profile: "prod" } });
    act(() => result.current.add(A));
    rerender({ profile: "dev" });
    rerender({ profile: "prod" });
    expect(result.current.arns).toEqual([]);
  });

  test("a late call of the previous profile's add leaves the new list alone", () => {
    const { result, rerender } = renderHook(({ profile }) => useAddedColumns(profile), { initialProps: { profile: "prod" } });
    const lateAdd = result.current.add;
    rerender({ profile: "dev" });
    act(() => result.current.add(B));
    act(() => lateAdd(A));
    expect(result.current.arns).toEqual([B]);
  });

  test("an add under the new profile starts a new list", () => {
    const { result, rerender } = renderHook(({ profile }) => useAddedColumns(profile), { initialProps: { profile: "prod" } });
    act(() => result.current.add(A));
    rerender({ profile: "dev" });
    act(() => result.current.add(B));
    expect(result.current.arns).toEqual([B]);
  });
});

test("rendering twice (StrictMode) changes nothing", () => {
  const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
  const { result, rerender } = renderHook(({ profile }) => useAddedColumns(profile), { wrapper, initialProps: { profile: "prod" } });
  act(() => result.current.add(A));
  expect(result.current.arns).toEqual([A]);
  rerender({ profile: "dev" });
  expect(result.current.arns).toEqual([]);
  act(() => result.current.add(B));
  expect(result.current.arns).toEqual([B]);
});
