/** 끝의 `/`를 뗀 주소. 키체인 계정과 쿼리 키가 이 모양을 쓴다. */
export const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, "");
