// DLQ로 붙일 수 있는 큐를 고르는 규칙(순수). 목록은 리소스 브라우저가 읽은 SQS 큐 행이다.
import type { Resource, ServiceInfo } from "../api/types";
import { arnScope } from "./targets";
import type { SnsSubscription, SnsTopic } from "./types";

/** 리소스 브라우저의 SQS 큐 목록과 같은 쿼리를 쓰기 위한 서비스 표지(쿼리 키는 서비스 id와 전역 여부만 쓴다) */
export const SQS_SERVICE: ServiceInfo = { id: "sqs", name: "SQS", global: false, types: [] };
export const SQS_QUEUES = "queues";

const isFifoArn = (arn: string) => arn.endsWith(".fifo");

/**
 * 이 구독의 DLQ는 FIFO여야 하는가. SNS는 DLQ의 종류가 구독과 같아야 한다.
 * SQS 구독은 엔드포인트 큐를 따르고(해석하지 못했으면 큐 이름의 `.fifo`), SQS가 아닌 구독(Lambda, HTTP(S) …)은 주제를 따른다.
 */
export function dlqMustBeFifo(sub: SnsSubscription, topic: SnsTopic): boolean {
  if (sub.protocol !== "sqs") return topic.fifo;
  return sub.target?.kind === "sqs" ? sub.target.fifo : isFifoArn(sub.endpoint);
}

export interface DlqCandidates {
  fifo: boolean;
  /** 고를 수 있는 큐(받은 순서 그대로) */
  queues: Resource[];
  /** 종류·계정·리전이 맞지 않거나 ARN을 모르거나 엔드포인트 큐 자신이라 뺀 큐 수 */
  hidden: number;
}

/** 고를 수 있는 DLQ: 같은 계정·리전, 구독과 같은 종류, 엔드포인트 큐 자신이 아닌 큐 */
export function dlqCandidates(queues: Resource[], sub: SnsSubscription, topic: SnsTopic): DlqCandidates {
  const fifo = dlqMustBeFifo(sub, topic);
  const keep = queues.filter((q) => {
    if (!q.arn) return false;
    const scope = arnScope(q.arn);
    return scope.account === topic.account && scope.region === topic.region && isFifoArn(q.arn) === fifo && q.arn !== sub.endpoint;
  });
  return { fifo, queues: keep, hidden: queues.length - keep.length };
}
