import { changeTone } from "./changeTone";
import type { K8sChange } from "./types";

const entry = (change: Partial<K8sChange> & { type: string }, extra: { undoOf?: string | null; create?: boolean } = {}) => ({ change: change as K8sChange, undoOf: extra.undoOf ?? null, create: extra.create });

test("the confirm button follows what the change does: state changes yellow, pausing orange, removal red, plain apply blue", () => {
  expect(changeTone([entry({ type: "restart" })])).toBe("warn");
  expect(changeTone([entry({ type: "scale" })])).toBe("warn");
  expect(changeTone([entry({ type: "cordon" })])).toBe("warn");
  expect(changeTone([entry({ type: "suspend", suspend: false } as Partial<K8sChange> & { type: string })])).toBe("warn");
  expect(changeTone([entry({ type: "suspend", suspend: true } as Partial<K8sChange> & { type: string })])).toBe("caution");
  expect(changeTone([entry({ type: "apply" })])).toBe("primary");
  expect(changeTone([entry({ type: "apply" }, { create: true })])).toBe("create");
});

test("a mixed batch takes its most consequential change, and an undo is always a revert", () => {
  expect(changeTone([entry({ type: "restart" }), entry({ type: "delete" })])).toBe("danger");
  expect(changeTone([entry({ type: "restart" }), entry({ type: "rolloutUndo" })])).toBe("caution");
  expect(changeTone([entry({ type: "apply" }, { create: true }), entry({ type: "scale" })])).toBe("warn");
  expect(changeTone([entry({ type: "restart" })], true)).toBe("caution");
  expect(changeTone([entry({ type: "apply" }, { undoOf: "id-1" })])).toBe("caution");
});
