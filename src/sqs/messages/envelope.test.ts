import { describe, expect, it } from "vitest";
import { base64Bytes, fieldValue, groupByField, isGzip, remainingMessages, unwrapBody, unwrapJson } from "./envelope";
import type { SqsMessage } from "../types";

const message = (messageId: string, body: string): SqsMessage => ({ messageId, body, md5: "", attributes: {}, messageAttributes: [], size: body.length });
describe("메시지 봉투", () => {
  it("SNS와 EventBridge를 차례로 풀어요", async () => {
    const body = JSON.stringify({ Type: "Notification", Message: JSON.stringify({ "detail-type": "order", detail: { id: 7 } }) });
    const result = await unwrapBody(body);
    expect(result.layers).toEqual(["SNS", "EventBridge"]);
    expect(JSON.parse(result.text)).toEqual({ id: 7 });
  });
  it("S3 레코드를 꺼내고 다른 JSON은 건드리지 않아요", () => {
    expect(unwrapJson({ Records: [{ s3: { bucket: { name: "b" } } }] })).toEqual({ kind: "S3", value: [{ s3: { bucket: { name: "b" } } }] });
    expect(unwrapJson({ Records: [{ other: 1 }] })).toBeNull();
  });
  it("base64와 gzip을 감지하고 풀어요", async () => {
    const encoded = "H4sIAAAAAAAAA6tWKkvMKU1VsjKsBQDS4tHvCwAAAA==";
    expect(isGzip(base64Bytes(encoded)!)).toBe(true);
    const result = await unwrapBody(encoded);
    expect(result.layers).toEqual(["base64", "gzip"]);
    expect(JSON.parse(result.text)).toEqual({ value: 1 });
    expect((await unwrapBody(btoa("hello world"))).text).toBe("hello world");
    expect(base64Bytes("not base64!")).toBeNull();
  });
});
describe("메시지 분류와 결과", () => {
  const messages = [message("a", '{"detail":{"reason":"x"}}'), message("b", '{"detail":{"reason":"x"}}'), message("c", '{"detail":{"reason":"y"}}'), message("d", "아님")];
  it("점 경로의 값과 없는 값을 각각 세요", () => {
    expect(fieldValue(messages[0].body, "detail.reason")).toBe("x");
    expect(groupByField(messages, "detail.reason")).toEqual([{ value: "x", count: 2 }, { value: "(없음)", count: 1 }, { value: "y", count: 1 }]);
  });
  it("성공한 메시지만 목록에서 빼고 실패한 메시지는 남겨요", () => {
    expect(remainingMessages(messages, [{ id: "a", ok: true, error: null }, { id: "b", ok: false, error: "실패" }]).map(m => m.messageId)).toEqual(["b", "c", "d"]);
  });
});
