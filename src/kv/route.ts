import type { KvBullState, KvKeyName } from "./types";

export type KvView = "keys" | "bull" | "overview" | "slowlog" | "clients" | "bigkeys";

/** 키 이름을 가리키는 짧은 글. 바이너리 이름은 base64로, 글 이름은 text로(서로 겹치지 않게 접두사를 둔다) */
export const keyId = (name: KvKeyName) => (name.base64 !== null ? `b:${name.base64}` : `t:${name.text}`);

/**
 * 키 탭 안의 위치. 정체성은 view와 key뿐이다. key가 있으면 키 화면에서 그 키의 값 상세가 열려 있다.
 * 키를 열고 닫는 것도 기록에 쌓여서 뒤로 가면 상세가 닫히고 앞으로 가면 다시 열린다.
 */
export interface KvRoute {
  view: KvView;
  key?: KvKeyName;
  /** 🐂 Bull 화면이면 큐 상세가 열려 있는 큐 이름. 없으면 큐 목록 */
  queue?: string;
  /** 🐂 큐 상세에서 작업 표가 보이는 상태. 상세를 보던 상태라 기록에 쌓지 않고 현재 항목에 남긴다(replace) */
  state?: KvBullState;
  /** 🐂 큐 상세 위에 작업 상세가 열려 있는 작업 id */
  job?: string;
}

export const KV_VIEW_LABEL: Record<KvView, string> = {
  keys: "키",
  bull: "Bull",
  overview: "개요",
  slowlog: "Slow log",
  clients: "클라이언트",
  bigkeys: "큰 키",
};

/** 같은 화면인지. useRouteHistory에 넘기는 함수라 모듈 밖에 둔다. */
export const sameKvRoute = (a: KvRoute, b: KvRoute) =>
  a.view === b.view && (a.key ? keyId(a.key) : null) === (b.key ? keyId(b.key) : null) && (a.queue ?? null) === (b.queue ?? null) && (a.job ?? null) === (b.job ?? null);
