/** 여러 Pod·컨테이너의 로그를 한 화면에 합칠 때 줄 앞에 붙이는 출처 이름과 색, 그리고 줄을 글로 바꾸는 규칙 */
import { formatTime } from "./jsonLog";
import type { LogEntry } from "./logBuffer";

/** 팔레트 크기(styles.css의 --log-c1 ~ --log-c8) */
export const LOG_COLORS = 8;

export interface SourceRef {
  key: string;
  pod: string;
  /** 컨테이너를 알 수 없는 오류 흐름이면 빈 글 */
  container: string;
}

export interface SourceLabel {
  /** 줄 앞과 칩에 보이는 짧은 이름 */
  text: string;
  /** 1 ~ LOG_COLORS */
  color: number;
  /** 마우스를 올리면 보이는 온전한 이름 */
  title: string;
}

/** FNV-1a. 같은 이름은 늘 같은 색이 된다(다시 열어도, 다른 Pod가 붙어도 바뀌지 않는다). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const REPLICA_SUFFIX = /^[a-z0-9]{8,10}-([a-z0-9]{5})$/;

/**
 * 워크로드 이름을 뗀 짧은 Pod 이름. Deployment·ReplicaSet Pod는 해시를 떼고 끝의 5글자만 남긴다.
 * StatefulSet의 순번(`db-0`)은 숫자만 남으면 무슨 Pod인지 알 수 없어 온전한 이름을 둔다.
 */
export function shortPod(pod: string, workload: string): string {
  if (!workload || !pod.startsWith(`${workload}-`) || pod.length === workload.length + 1) return pod;
  const rest = pod.slice(workload.length + 1);
  if (/^\d+$/.test(rest)) return pod;
  return REPLICA_SUFFIX.exec(rest)?.[1] ?? rest;
}

/** 출처의 온전한 이름 */
export const fullName = (s: SourceRef) => (s.container ? `${s.pod}/${s.container}` : s.pod);

/**
 * 출처마다 이름표. 출처가 둘 이상일 때만 만든다(하나면 줄 앞에 붙일 것이 없다).
 * Pod가 여럿이면 Pod 이름을, 컨테이너가 여럿이면 컨테이너 이름도 붙인다. 색은 Pod가 여럿이면 Pod 이름으로, 한 Pod의 컨테이너들이면 컨테이너 이름으로 고른다.
 */
export function sourceLabels(sources: SourceRef[], workload: string): Map<string, SourceLabel> | null {
  if (sources.length < 2) return null;
  const showPod = new Set(sources.map((s) => s.pod)).size > 1;
  const showContainer = new Set(sources.filter((s) => s.container).map((s) => s.container)).size > 1;
  const labels = new Map<string, SourceLabel>();
  for (const s of sources) {
    const parts = [showPod ? shortPod(s.pod, workload) : null, showContainer && s.container ? s.container : null].filter((p): p is string => p !== null);
    labels.set(s.key, {
      text: parts.length > 0 ? parts.join("/") : shortPod(s.pod, workload),
      color: (hash(showPod ? s.pod : s.container || s.pod) % LOG_COLORS) + 1,
      title: fullName(s),
    });
  }
  return labels;
}

/** 서버가 붙인 시각을 로컬 `MM-DD HH:mm:ss.SSS`로. 읽지 못하면 받은 그대로 */
export const timeText = (ts: string) => formatTime(ts) ?? ts;

/** 화면에 보이는 그대로의 줄 글: 출처 이름표와 시각(보일 때만)을 앞에 붙인다 */
export function lineText(e: LogEntry, label: SourceLabel | undefined, showTime: boolean): string {
  return `${label ? `${label.text} ` : ""}${showTime && e.ts !== null ? `${timeText(e.ts)} ` : ""}${e.text}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 저장할 파일 이름 `<이름>-<YYYYMMDD-HHMMSS>.log`(로컬 시각) */
export function logFileName(name: string, at: Date): string {
  const day = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  return `${name}-${day}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.log`;
}
