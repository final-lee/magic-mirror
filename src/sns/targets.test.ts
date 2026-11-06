import { arnScope, resourceJumpOf, resourceNameOf, snsTabId, snsTabTitle, topicNameOf } from "./targets";
import { QUEUE_ARN, QUEUE_URL, snsTarget, TOPIC_ARN } from "./fixtures";
import { sameSnsRoute, snsNavView, snsSubscriptionRoute } from "./route";

test("the tab id carries profile, region and topic ARN; the title is the topic name", () => {
  expect(snsTabId(snsTarget)).toBe(`sns:personal:ap-northeast-2:${TOPIC_ARN}`);
  expect(snsTabTitle("orders-events.fifo")).toBe("📣 orders-events.fifo");
});

test("ARN helpers", () => {
  expect(arnScope(QUEUE_ARN)).toEqual({ region: "ap-northeast-2", account: "123456789012" });
  expect(arnScope("nope")).toEqual({ region: "", account: "" });
  expect(topicNameOf(TOPIC_ARN)).toBe("orders-events.fifo");
  expect(resourceNameOf(QUEUE_ARN)).toBe("orders-queue.fifo");
  expect(resourceNameOf("arn:aws:lambda:r:1:function:fn")).toBe("fn");
  expect(resourceNameOf("arn:aws:lambda:r:1:function:fn:live")).toBe("fn:live");
  expect(resourceNameOf("arn:aws:kinesis:r:1:stream/x")).toBeNull();
  expect(resourceNameOf("https://example.com")).toBeNull();
});

describe("resourceJumpOf", () => {
  test("an own-account queue is its row by queue URL; a function is its row by name without the alias", () => {
    expect(resourceJumpOf({ kind: "sqs", arn: QUEUE_ARN, url: QUEUE_URL, fifo: true, kmsKey: null, policy: null, redrivePolicy: null, error: null }, "123456789012")).toEqual({
      region: "ap-northeast-2",
      service: "sqs",
      type: "queues",
      id: QUEUE_URL,
    });
    expect(resourceJumpOf({ kind: "lambda", arn: "arn:aws:lambda:us-east-1:123456789012:function:fn:live", policy: null, error: null }, "123456789012")).toEqual({
      region: "us-east-1",
      service: "lambda",
      type: "functions",
      id: "fn",
    });
  });

  test("another account's resource has no row in this profile", () => {
    expect(resourceJumpOf({ kind: "lambda", arn: "arn:aws:lambda:us-east-1:999999999999:function:fn", policy: null, error: null }, "123456789012")).toBeNull();
  });
});

test("routes: same screen means same view and subscription; a subscription detail lights its list in the menu", () => {
  expect(sameSnsRoute({ view: "overview" }, { view: "overview" })).toBe(true);
  expect(sameSnsRoute(snsSubscriptionRoute("a"), snsSubscriptionRoute("a"))).toBe(true);
  expect(sameSnsRoute(snsSubscriptionRoute("a"), snsSubscriptionRoute("b"))).toBe(false);
  expect(sameSnsRoute({ view: "subscriptions" }, snsSubscriptionRoute("a"))).toBe(false);
  expect(snsNavView("subscription")).toBe("subscriptions");
  expect(snsNavView("metrics")).toBe("metrics");
});
