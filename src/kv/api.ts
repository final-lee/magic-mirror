import { Channel } from "@tauri-apps/api/core";
import { invoke } from "../api/invoke";
import type { KvBigKeysMessage, KvBigKeysReport, KvBullFlow, KvBullJob, KvBullJobsPage, KvBullQueue, KvBullQueueView, KvBullQueuesPage, KvBullState, KvBullTopology, KvBullTransitions, KvClient, KvKeyName, KvKeyView, KvLogin, KvOverview, KvScanPage, KvSlowEntry, KvTarget, KvTargetInfo, KvType } from "./types";

// 명령 이름과 인자 이름은 계약(local://kv-contract.md)과 같아야 한다(Tauri가 camelCase 인자를 snake_case로 바꿔 준다).
// 모든 명령은 target을 객체 하나로 받는다. invoke가 SSO 만료를 알릴 때 그 안의 profile을 읽으므로(src/api/invoke.ts) 풀어서 넘기지 않는다.
// 읽기만 하는 명령뿐이다. 값은 화면과 메모리 캐시에만 있다.
export const kvApi = {
  /** ElastiCache API로 대상을 확인한다. 캐시에는 연결하지 않는다. */
  target: (target: KvTarget) => invoke<KvTargetInfo>("kv_target", { target }),
  /** 연결하고 개요를 읽는다. 비밀번호는 키체인에 저장하거나(rememberPassword) 지운다. 이 앱의 설정에 기억하는 일은 화면이 한다. */
  open: (target: KvTarget, login: KvLogin) => invoke<KvOverview>("kv_open", { target, login }),
  overview: (target: KvTarget) => invoke<KvOverview>("kv_overview", { target }),
  scan: (target: KvTarget, pattern: string, typeFilter: KvType | null, cursor: string | null, count: number) =>
    invoke<KvScanPage>("kv_scan", { target, pattern, typeFilter, cursor, count }),
  key: (target: KvTarget, key: KvKeyName, page: string | null) => invoke<KvKeyView>("kv_key", { target, key, page }),
  slowlog: (target: KvTarget) => invoke<KvSlowEntry[]>("kv_slowlog", { target }),
  clients: (target: KvTarget) => invoke<KvClient[]>("kv_clients", { target }),
  /** 큰 키 찾기. 진행과 결과는 채널로 오고(done), 반환은 끝났다는 뜻이다 */
  bigkeys: (target: KvTarget, limit: number, onMessage: (m: KvBigKeysMessage) => void) => {
    const onProgress = new Channel<KvBigKeysMessage>();
    onProgress.onmessage = onMessage;
    return invoke<null>("kv_bigkeys", { target, limit, onProgress });
  },
  bigkeysStop: (target: KvTarget) => invoke<null>("kv_bigkeys_stop", { target }),
  /** 이 대상·지금 DB의 마지막 큰 키 찾기 결과(찾은 적이 없으면 null) */
  bigkeysReport: (target: KvTarget) => invoke<KvBigKeysReport | null>("kv_bigkeys_report", { target }),
  /** 🐂 Bull: prefix 아래의 큐를 찾는다(제한된 SCAN. cursor로 이어서 찾는다) */
  bullQueues: (target: KvTarget, prefix: string, cursor: string | null) => invoke<KvBullQueuesPage>("kv_bull_queues", { target, prefix, cursor }),
  /** 🐂 이미 찾은 큐들의 요약만 다시 읽는다(키 공간을 훑지 않는다) */
  bullQueueSummaries: (target: KvTarget, prefix: string, names: string[]) => invoke<KvBullQueue[]>("kv_bull_queue_summaries", { target, prefix, names }),
  bullQueue: (target: KvTarget, prefix: string, name: string) => invoke<KvBullQueueView>("kv_bull_queue", { target, prefix, name }),
  bullJobs: (target: KvTarget, prefix: string, name: string, state: KvBullState, start: number, count: number) =>
    invoke<KvBullJobsPage>("kv_bull_jobs", { target, prefix, name, state, start, count }),
  bullJob: (target: KvTarget, prefix: string, name: string, id: string) => invoke<KvBullJob>("kv_bull_job", { target, prefix, name, id }),
  /** 🐂 작업 흐름(부모·자식 그래프). 위로 루트까지, 아래로 자식까지 걷는다 */
  bullFlow: (target: KvTarget, prefix: string, name: string, id: string) => invoke<KvBullFlow>("kv_bull_flow", { target, prefix, name, id }),
  /** 🐂 상태 전이: events 스트림의 (prev, event) 쌍을 센 것. minutes는 지금부터 거슬러 올라가는 구간 */
  bullTransitions: (target: KvTarget, prefix: string, name: string, minutes: number) => invoke<KvBullTransitions>("kv_bull_transitions", { target, prefix, name, minutes }),
  /** 🐂 큐 지도: 큐, 부모→자식 큐 연결, 워커 호스트 */
  bullTopology: (target: KvTarget, prefix: string) => invoke<KvBullTopology>("kv_bull_topology", { target, prefix }),
  /** 이 대상의 연결을 닫는다. 탭을 닫을 때 부른다. */
  close: (target: KvTarget) => invoke<null>("kv_close", { target }),
  /** 키체인에 저장해 둔 이 사용자의 비밀번호를 지운다 */
  forgetPassword: (target: KvTarget, user: string) => invoke<null>("kv_forget_password", { target, user }),
};
