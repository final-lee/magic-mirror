import type { SnsRoute } from "./route";
import type { SnsTarget } from "./types";

/** 주제 탭이 여는 주제. 탭 id와 쿼리 키의 단위 */
export interface SnsTopicRef {
  profile: string;
  region: string;
  topicArn: string;
  topicName: string;
}

/** 탭을 열면서 탭 안에서 갈 곳(구독 상세 등). nonce가 바뀔 때마다 그 화면으로 이동한다(같은 곳을 다시 열어도) */
export interface SnsOpen {
  route: SnsRoute;
  nonce: number;
}

/** 탭 id. 같은 주제는 같은 탭을 연다 */
export const snsTabId = (t: Pick<SnsTopicRef, "profile" | "region" | "topicArn">) => `sns:${t.profile}:${t.region}:${t.topicArn}`;

/** 탭 제목 */
export const snsTabTitle = (topicName: string) => `📣 ${topicName}`;

/** ARN을 `:`으로 나눈 조각. [arn, partition, service, region, account, ...resource] */
const arnParts = (arn: string) => arn.split(":");

/** ARN의 리전·계정(없으면 빈 글) */
export function arnScope(arn: string): { region: string; account: string } {
  const p = arnParts(arn);
  return { region: p[3] ?? "", account: p[4] ?? "" };
}

/** 주제 ARN의 이름(마지막 조각) */
export const topicNameOf = (arn: string) => arnParts(arn).pop() ?? arn;

/** SQS 큐 ARN의 큐 이름, Lambda ARN의 함수 이름(별칭·버전이 붙으면 `이름:별칭`). 모르는 모양이면 null */
export function resourceNameOf(arn: string): string | null {
  const p = arnParts(arn);
  if (p[0] !== "arn") return null;
  if (p[2] === "sqs") return p[5] || null;
  if (p[2] === "lambda" && p[5] === "function") return p.slice(6).join(":") || null;
  return null;
}

/** 리소스 브라우저에서 이 엔드포인트의 행을 가리키는 값(⌘K로 행을 찾아 갈 때와 같은 값) */
export interface ResourceJump {
  region: string;
  service: "sqs" | "lambda";
  type: "queues" | "functions";
  /** 행 ID. SQS는 큐 URL, Lambda는 함수 이름 */
  id: string;
}

/**
 * 구독 엔드포인트가 리소스 브라우저의 어느 행인지. 같은 계정의 SQS 큐(행 ID는 큐 URL)·Lambda 함수(행 ID는 함수 이름)만 열 수 있다.
 * 다른 계정의 리소스는 이 프로필의 목록에 없으니 null이다.
 */
export function resourceJumpOf(target: SnsTarget, account: string): ResourceJump | null {
  const { region, account: owner } = arnScope(target.arn);
  if (owner !== account) return null;
  if (target.kind === "sqs") return { region, service: "sqs", type: "queues", id: target.url };
  return { region, service: "lambda", type: "functions", id: arnParts(target.arn)[6] };
}

/** 계정 개요 탭(`📣 SNS`)의 id. 계정·리전마다가 아니라 하나뿐이고 주제 탭 id(`sns:`로 시작)와 겹치지 않는다 */
export const SNS_ACCOUNT_TAB = "sns-account";
