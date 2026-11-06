// 변경 틀의 순수 조각: 계획 거절 판별, 값 표시, 줄 차이 분류.
import { isAppError } from "../api/errors";
import type { SnsChangeRequest, SnsFix } from "./types";

/** 적용이 `{ kind: "stalePlan" }`로 거절됐는가: 미리보기를 받은 뒤 AWS의 상태가 바뀌었다 */
export function isStalePlan(e: unknown): boolean {
  return isAppError(e) && (e as { kind: string }).kind === "stalePlan";
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
