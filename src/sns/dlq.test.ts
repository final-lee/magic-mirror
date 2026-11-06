import { makeResource } from "../test/utils";
import { ACCOUNT, DLQ_ARN, FUNCTION_ARN, QUEUE_ARN, REGION, lambdaSubscription, partnerSubscription, sampleTopic, sqsSubscription } from "./fixtures";
import { dlqCandidates, dlqMustBeFifo } from "./dlq";
import type { SnsSubscription } from "./types";

const q = (name: string, arn = `arn:aws:sqs:${REGION}:${ACCOUNT}:${name}`) => makeResource(`https://sqs/${name}`, { name }, { arn });
const queues = [q("orders-queue.fifo"), q("dead.fifo"), q("dead-std"), q("other-account.fifo", `arn:aws:sqs:${REGION}:999999999999:other-account.fifo`), q("other-region", `arn:aws:sqs:us-east-1:${ACCOUNT}:other-region`), makeResource("broken", { name: "broken" })];
const names = (r: ReturnType<typeof dlqCandidates>) => r.queues.map((x) => x.name);
const standardQueueSub: SnsSubscription = { ...sqsSubscription, endpoint: `arn:aws:sqs:${REGION}:${ACCOUNT}:std-queue`, target: { kind: "sqs", arn: `arn:aws:sqs:${REGION}:${ACCOUNT}:std-queue`, url: "u", fifo: false, kmsKey: null, policy: null, redrivePolicy: null, error: null } };

describe("dlqMustBeFifo", () => {
  test("a FIFO endpoint queue needs a FIFO DLQ and a standard endpoint queue a standard one, whatever the topic is", () => {
    expect(dlqMustBeFifo(sqsSubscription, sampleTopic())).toBe(true);
    expect(dlqMustBeFifo(standardQueueSub, sampleTopic())).toBe(false);
  });
  test("an unresolved SQS endpoint is judged by its queue name", () => {
    expect(dlqMustBeFifo({ ...partnerSubscription, endpoint: "arn:aws:sqs:us-east-1:9:p.fifo" }, sampleTopic({ fifo: false }))).toBe(true);
    expect(dlqMustBeFifo(partnerSubscription, sampleTopic())).toBe(false);
  });
  test("non-SQS endpoints follow the topic kind", () => {
    expect(dlqMustBeFifo(lambdaSubscription, sampleTopic({ fifo: true }))).toBe(true);
    expect(dlqMustBeFifo(lambdaSubscription, sampleTopic({ fifo: false }))).toBe(false);
    expect(lambdaSubscription.endpoint).toBe(FUNCTION_ARN);
  });
});

describe("dlqCandidates", () => {
  test("a FIFO subscription gets only FIFO queues of this account and region, not the endpoint queue itself", () => {
    const r = dlqCandidates(queues, { ...sqsSubscription, endpoint: QUEUE_ARN }, sampleTopic());
    expect(r.fifo).toBe(true);
    expect(names(r)).toEqual(["dead.fifo"]);
    expect(r.hidden).toBe(queues.length - 1);
  });
  test("a standard subscription gets only standard queues", () => {
    expect(names(dlqCandidates(queues, standardQueueSub, sampleTopic()))).toEqual(["dead-std"]);
  });
  test("Lambda on a FIFO topic gets FIFO queues, on a standard topic standard queues", () => {
    expect(names(dlqCandidates(queues, lambdaSubscription, sampleTopic({ fifo: true })))).toEqual(["orders-queue.fifo", "dead.fifo"]);
    expect(names(dlqCandidates(queues, lambdaSubscription, sampleTopic({ fifo: false })))).toEqual(["dead-std"]);
  });
  test("a queue without an ARN (unreadable attributes) is not offered", () => {
    expect(dlqCandidates([makeResource("x", { name: "x" })], standardQueueSub, sampleTopic()).queues).toEqual([]);
    expect(DLQ_ARN).toContain("orders-dlq");
  });
});
