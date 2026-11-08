import type { Connections } from "./types";

/** 소비자를 읽는 출처. 이 중 하나라도 읽지 못했으면 소비자가 없다고 말할 수 없다 */
const CONSUMER_SECTIONS = ["lambda", "pipes", "kinesis"];

/**
 * 함수 ARN에서 함수 이름만. 별칭·버전(`:live`)은 뗀다. Lambda 어댑터의 리소스 id가 함수 이름이다.
 * ARN이 아니면 그대로 돌려준다.
 */
export function lambdaFunctionName(functionArn: string): string {
  const afterMarker = functionArn.split(":function:")[1] ?? functionArn;
  return afterMarker.split(":")[0];
}

/** 스트림은 켜져 있는데 소비자가 없는가: 소비자 출처를 모두 읽었고 아무것도 없을 때만 */
export function hasNoConsumers(connections: Connections): boolean {
  if (!connections.stream) return false;
  const unread = connections.gaps.some((gap) => CONSUMER_SECTIONS.includes(gap.section));
  return !unread && connections.esms.length === 0 && connections.pipes.length === 0 && connections.kinesis.length === 0;
}
