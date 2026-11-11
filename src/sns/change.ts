// 변경 틀의 순수 조각: 계획 거절 판별, 값 표시, 줄 차이 분류.
import { isAppError } from "../api/errors";
import type { SnsApplyResult, SnsChangeRequest, SnsFix, SnsPlan } from "./types";

/** 적용이 `{ kind: "stalePlan" }`로 거절됐는가: 미리보기를 받은 뒤 AWS의 상태가 바뀌었다 */
export function isStalePlan(e: unknown): boolean {
  return isAppError(e) && (e as { kind: string }).kind === "stalePlan";
}

/** 변경의 입구와 최종 확인에 같은 색을 쓴다. */
export function changeTone(request: Pick<SnsChangeRequest, "kind"> & { retentionDays?: number | null }, plan?: SnsPlan | null): string {
  if (request.kind === "undo" || plan?.undoOf) return "tone-caution";
  if (request.kind === "unsubscribe" || (request.kind === "archivePolicy" && request.retentionDays === null)) return "tone-danger";
  if (request.kind === "subscribe") return "tone-create";
  if (request.kind === "rawDelivery" || request.kind === "archivePolicy") return "tone-warn";
  return "tone-primary";
}

/** 미리보기의 값 칸: 글은 그대로, 없으면 "없음", 그 밖에는 보기 좋은 JSON */
export function formatSnsValue(value: unknown, none: string): string {
  if (value === null || value === undefined) return none;
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? none;
}

export type SnsDiffKind = "add" | "del" | "head" | "hunk" | "same";

/** unified diff 글을 줄마다 갈래로 나눈다. `+++`·`---` 머리와 `@@` 구간 표시는 따로 센다 */
export function classifyDiff(diff: string): { kind: SnsDiffKind; text: string }[] {
  const lines = diff.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  return lines.map((text) => {
    if (text.startsWith("+++") || text.startsWith("---")) return { kind: "head", text };
    if (text.startsWith("@@")) return { kind: "hunk", text };
    if (text.startsWith("+")) return { kind: "add", text };
    if (text.startsWith("-")) return { kind: "del", text };
    return { kind: "same", text };
  });
}

/** 진단의 고치기가 여는 변경 요청. DLQ 붙이기는 큐를 고른 뒤에야 요청이 되므로 여기서는 만들지 않고, kmsStatement는 복사만 해서 null이다 */
export function fixRequest(fix: SnsFix, topicArn: string): SnsChangeRequest | null {
  switch (fix.kind) {
    case "queuePolicy":
      return { kind: "queuePolicy", topicArn, queueUrl: fix.queueUrl, queueArn: fix.queueArn };
    case "lambdaPermission":
      return { kind: "lambdaPermission", topicArn, functionArn: fix.functionArn };
    case "addDlq":
    case "kmsStatement":
      return null;
  }
}

/** 값이 객체이고 그 키가 있으면 그 값(아니면 undefined). 기록의 before·after처럼 모양을 믿을 수 없는 값을 읽을 때 쓴다 */
export function readKey(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

/** 적용 결과에서 사용자에게 보여 줄 값: 만든 구독의 ARN, 발행한 메시지의 MessageId(없으면 빈 목록) */
export function outputLines(result: SnsApplyResult): [string, string][] {
  const lines: [string, string][] = [];
  for (const out of result.outputs ?? []) {
    const arn = readKey(out, "subscriptionArn");
    const id = readKey(out, "messageId");
    if (typeof arn === "string") lines.push([arn.startsWith("arn:") ? "구독 ARN" : "구독 상태", arn]);
    if (typeof id === "string") lines.push(["MessageId", id]);
  }
  return lines;
}
