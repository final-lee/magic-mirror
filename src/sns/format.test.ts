import { dlqName, endpointLabel, kmsLabel, parseJsonText, topicHeadline } from "./format";
import { sampleTopic } from "./fixtures";

describe("labels", () => {
  test("kmsLabel keeps aliases, shortens key ARNs", () => {
    expect(kmsLabel("alias/orders")).toBe("alias/orders");
    expect(kmsLabel("arn:aws:kms:ap-northeast-2:123456789012:alias/orders")).toBe("alias/orders");
    expect(kmsLabel("arn:aws:kms:ap-northeast-2:123456789012:key/1234-abcd")).toBe("1234-abcd");
    expect(kmsLabel("1234-abcd")).toBe("1234-abcd");
  });

  test("the headline reads kind · key · subscriptions", () => {
    expect(topicHeadline(sampleTopic())).toBe("FIFO · KMS(alias/orders) · 구독 4 (대기 1)");
  });

  test("endpoints show the resource name, with where only when it differs from the topic's", () => {
    const topic = { account: "123456789012", region: "ap-northeast-2" };
    expect(endpointLabel({ protocol: "sqs", endpoint: "arn:aws:sqs:ap-northeast-2:123456789012:jobs" }, topic)).toEqual({ name: "jobs", where: null });
    expect(endpointLabel({ protocol: "sqs", endpoint: "arn:aws:sqs:us-east-1:999999999999:jobs" }, topic)).toEqual({ name: "jobs", where: "999999999999 · us-east-1" });
    expect(endpointLabel({ protocol: "sqs", endpoint: "arn:aws:sqs:us-east-1:123456789012:jobs" }, topic)).toEqual({ name: "jobs", where: "us-east-1" });
    expect(endpointLabel({ protocol: "lambda", endpoint: "arn:aws:lambda:ap-northeast-2:123456789012:function:fn:live" }, topic)).toEqual({ name: "fn:live", where: null });
    expect(endpointLabel({ protocol: "https", endpoint: "https://example.com/hook" }, topic)).toEqual({ name: "https://example.com/hook", where: null });
    expect(endpointLabel({ protocol: "email", endpoint: "ops@example.com" }, topic)).toEqual({ name: "ops@example.com", where: null });
  });

  test("the DLQ is shown by queue name", () => {
    expect(dlqName({ dlqArn: null })).toBeNull();
    expect(dlqName({ dlqArn: "arn:aws:sqs:ap-northeast-2:123456789012:orders-dlq" })).toBe("orders-dlq");
  });

  test("parseJsonText only parses objects and arrays", () => {
    expect(parseJsonText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonText("[1]")).toEqual([1]);
    expect(parseJsonText("true")).toBeNull();
    expect(parseJsonText("{broken")).toBeNull();
    expect(parseJsonText(undefined)).toBeNull();
  });
});
