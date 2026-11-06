import { expect, it } from "vitest";
import { sqsChangeTone } from "./tone";

it("변경 대상에 일어나는 일에 따라 적용 버튼 색을 골라요", () => {
  expect(sqsChangeTone({ kind: "purge" })).toBe("danger");
  expect(sqsChangeTone({ kind: "deleteMessages", peekId: "p", messageIds: [] })).toBe("danger");
  expect(sqsChangeTone({ kind: "cancelMoveTask", taskHandle: "t" })).toBe("caution");
  expect(sqsChangeTone({ kind: "receive", max: 1, holdSecs: 10 })).toBe("primary");
  expect(sqsChangeTone({ kind: "moveTask", destinationArn: null, maxPerSecond: null })).toBe("primary");
  expect(sqsChangeTone({ kind: "resend", peekId: "p", messageIds: [], destinationUrl: "u", edits: {} })).toBe("primary");
});
