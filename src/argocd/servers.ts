import type { ArgocdServer } from "./types";

/** 설정에 서버가 없을 때 쓰는 기본 목록 */
export const DEFAULT_SERVERS: ArgocdServer[] = [
  { name: "stg", url: "https://argocd.taileada8.ts.net" },
  { name: "ops", url: "http://ops.example" },
];

/** 끝의 `/`를 뗀 주소. 키체인 계정과 쿼리 키가 이 모양을 쓴다. */
export const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, "");
