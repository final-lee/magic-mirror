import { afterEach, describe, expect, it } from "vitest";
import { cartAdd, cartRemove, cartRemoveApplied, resetCarts } from "./cart";
import { deleteBinding, editSubjects } from "./changes";
import { CART_MAX } from "./types";

const A = { profile: "p", region: "r", cluster: "a" };
const B = { profile: "p", region: "r", cluster: "b" };
const user = (name: string) => ({ kind: "User" as const, name });

afterEach(resetCarts);

describe("장바구니", () => {
  it("같은 변경은 두 번 담지 않고 최대 수를 넘기지 않는다", () => {
    const first = editSubjects({ namespace: null, name: "b" }, [user("u0")], []);
    expect(cartAdd(A, first)).toBe("added");
    expect(cartAdd(A, editSubjects({ namespace: null, name: "b" }, [user("u0")], []))).toBe("duplicate");
    for (let i = 1; i < CART_MAX; i++) expect(cartAdd(A, editSubjects({ namespace: null, name: "b" }, [user(`u${i}`)], []))).toBe("added");
    expect(cartAdd(A, deleteBinding({ namespace: null, name: "x" }))).toBe("full");
  });

  it("대상마다 따로 담기고 적용한 것만 빠진다", () => {
    const one = deleteBinding({ namespace: "dev", name: "one" });
    const two = deleteBinding({ namespace: "dev", name: "two" });
    cartAdd(A, one);
    cartAdd(A, two);
    cartAdd(B, one);
    cartRemoveApplied(A, [one]);
    cartRemove(B, 0);
    cartAdd(B, two);
    expect(cartAdd(A, two)).toBe("duplicate");
    expect(cartAdd(A, one)).toBe("added");
    expect(cartAdd(B, two)).toBe("duplicate");
  });
});
