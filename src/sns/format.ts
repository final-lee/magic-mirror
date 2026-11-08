import { arnScope, resourceNameOf } from "./targets";
import type { SnsSubscription, SnsSubscriptionState, SnsTopic } from "./types";

/** 별칭(alias/orders)은 그대로, 키 ARN은 별칭이면 alias/…로, 키 ID면 ID만 */
export function kmsLabel(key: string): string {
  const alias = key.indexOf(":alias/");
  if (alias >= 0) return key.slice(alias + 1);
  const id = key.indexOf(":key/");
  return id >= 0 ? key.slice(id + 5) : key;
}

/** 위쪽 줄의 한 줄: `FIFO · KMS(alias/orders) · 구독 6 (대기 1)` */
export function topicHeadline(topic: SnsTopic): string {
  const o = topic.overview;
  const subscriptions = o.confirmedCount + o.pendingCount;
  return [topic.fifo ? "FIFO" : "표준", o.kmsKey ? `KMS(${kmsLabel(o.kmsKey)})` : "암호화 안 됨", `구독 ${subscriptions}${o.pendingCount > 0 ? ` (대기 ${o.pendingCount})` : ""}`].join(" · ");
}

export const STATE_LABEL: Record<SnsSubscriptionState, string> = { confirmed: "확인됨", pending: "확인 대기", unknown: "판단 불가" };

/** 표에 보일 엔드포인트: SQS·Lambda는 리소스 이름(주제와 계정·리전이 다르면 그것을 곁들인다), 나머지는 엔드포인트 그대로 */
export function endpointLabel(sub: Pick<SnsSubscription, "protocol" | "endpoint">, topic: Pick<SnsTopic, "account" | "region">): { name: string; where: string | null } {
  const name = sub.protocol === "sqs" || sub.protocol === "lambda" ? resourceNameOf(sub.endpoint) : null;
  if (name === null) return { name: sub.endpoint, where: null };
  const scope = arnScope(sub.endpoint);
  const where = [scope.account !== topic.account ? scope.account : "", scope.region !== topic.region ? scope.region : ""].filter(Boolean).join(" · ");
  return { name, where: where || null };
}

/** DLQ 큐 이름. 없으면 null */
export function dlqName(sub: Pick<SnsSubscription, "dlqArn">): string | null {
  if (sub.dlqArn === null) return null;
  return resourceNameOf(sub.dlqArn) ?? sub.dlqArn;
}


/** 속성 값이 JSON 객체·배열 글이면 파싱해서, 아니면 null */
export function parseJsonText(text: string | null | undefined): unknown | null {
  if (!text || !/^\s*[[{]/.test(text)) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
