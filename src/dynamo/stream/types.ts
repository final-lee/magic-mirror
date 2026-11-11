import type { Finding, Gap, StreamSpec } from "../types";

/** Lambda 이벤트 소스 매핑 하나 */
export interface Esm {
  id: string;
  /** 함수 ARN(별칭·버전이 붙을 수 있다) */
  function: string;
  state: string;
  batchSize: number | null;
  startingPosition: string | null;
  parallelization: number | null;
  bisect: boolean | null;
  /** -1은 무제한 */
  retries: number | null;
  maxAge: number | null;
  failureDestination: string | null;
  filters: string[];
  /** 최근 15분 `IteratorAge` 최댓값(밀리초) */
  iteratorAgeMs: number | null;
}

export interface Pipe {
  name: string;
  state: string;
  target: string;
}

export interface KinesisDestination {
  arn: string;
  state: string;
  precision: string | null;
}

export interface ReplicaConnection {
  region: string;
  status: string;
  class: string | null;
  /** 받는 리전 기준 최근 1시간 `ReplicationLatency` 평균(밀리초) */
  latencyMs: number | null;
}

export interface Connections {
  stream: StreamSpec | null;
  esms: Esm[];
  pipes: Pipe[];
  kinesis: KinesisDestination[];
  replicas: ReplicaConnection[];
  /** 읽지 못한 부분. `section`은 lambda · pipes · kinesis · iteratorAge · replicationLatency */
  gaps: Gap[];
  findings: Finding[];
}

/** 스트림 이미지: DynamoDB JSON 속성들. 뷰 타입이 담지 않는 이미지는 null */
export type StreamImage = Record<string, unknown>;

export type StreamEvent = "INSERT" | "MODIFY" | "REMOVE";

export interface StreamRecord {
  id: string;
  /** INSERT · MODIFY · REMOVE */
  event: string;
  /** epoch 초 */
  time: number | null;
  keys: StreamImage | null;
  size: number | null;
  oldImage: StreamImage | null;
  newImage: StreamImage | null;
}

export interface StreamPoll {
  records: StreamRecord[];
  /** 지금 읽는 샤드 수 */
  shards: number;
  /** 읽을 차례를 기다리는 샤드 수 */
  behind: number;
}

/** 읽기를 시작할 자리 */
export type StartFrom = "LATEST" | "TRIM_HORIZON";
