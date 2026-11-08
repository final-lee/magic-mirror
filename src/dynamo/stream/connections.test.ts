import { describe, expect, it } from "vitest";
import { hasNoConsumers, lambdaFunctionName } from "./connections";
import type { Connections } from "./types";

const ARN = "arn:aws:lambda:ap-northeast-2:111111111111:function:order-worker";

describe("lambdaFunctionName", () => {
  it("함수 ARN에서 함수 이름만 꺼낸다(리소스 목록의 id)", () => {
    expect(lambdaFunctionName(ARN)).toBe("order-worker");
  });

  it("별칭과 버전은 뗀다", () => {
    expect(lambdaFunctionName(`${ARN}:live`)).toBe("order-worker");
    expect(lambdaFunctionName(`${ARN}:12`)).toBe("order-worker");
  });

  it("ARN이 아니면 그대로 돌려준다", () => {
    expect(lambdaFunctionName("order-worker")).toBe("order-worker");
  });
});

function connections(over: Partial<Connections> = {}): Connections {
  return { stream: { arn: "arn:stream", viewType: "NEW_IMAGE" }, esms: [], pipes: [], kinesis: [], replicas: [], gaps: [], findings: [], ...over };
}

describe("hasNoConsumers", () => {
  it("스트림이 켜져 있고 소비자 출처를 모두 읽었는데 아무것도 없을 때만 소비자가 없다고 한다", () => {
    expect(hasNoConsumers(connections())).toBe(true);
  });

  it("스트림이 꺼져 있으면 소비자를 따지지 않는다", () => {
    expect(hasNoConsumers(connections({ stream: null }))).toBe(false);
  });

  it("Pipe·Kinesis 소비자가 하나라도 있으면 없다고 하지 않는다", () => {
    expect(hasNoConsumers(connections({ pipes: [{ name: "p", state: "RUNNING", target: "arn:t" }] }))).toBe(false);
    expect(hasNoConsumers(connections({ kinesis: [{ arn: "arn:k", state: "ACTIVE", precision: null }] }))).toBe(false);
  });

  it.each(["lambda", "pipes", "kinesis"])("%s를 읽지 못했으면 없다고 단정하지 않는다", (section) => {
    expect(hasNoConsumers(connections({ gaps: [{ section, error: "권한이 없어요" }] }))).toBe(false);
  });

  it("지표를 읽지 못한 것은 소비자 유무와 상관없다", () => {
    expect(hasNoConsumers(connections({ gaps: [{ section: "iteratorAge", error: "x" }] }))).toBe(true);
  });
});
