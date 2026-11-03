import { useMemo, useState } from "react";
import { KEEP_LINES } from "./logBuffer";
import { LogView, type LogStream } from "./LogView";
import {
  LOG_ALL_CONTAINERS, LOG_CONTAINER, LOG_FOLLOW, LOG_PREVIOUS, LOG_SINCE, LOG_SINCE_CHOICES, LOG_TAIL, LOG_TIME, LOG_TIME_TITLE, LOG_VIEW_LABEL,
  LOG_VIEW_PRETTY, LOG_VIEW_RAW, LOG_WRAP, logTailOption,
} from "./text";
import type { K8sContainer, K8sKindRef, K8sLogOptions, K8sTarget } from "./types";

export const TAIL_CHOICES = [100, 500, 1_000, 5_000, 10_000, KEEP_LINES];
const DEFAULT_TAIL = 500;

interface ShellProps {
  target: K8sTarget;
  ssoProfile: string;
  live: boolean;
  stream: LogStream;
  /** 컨테이너 선택에 올릴 컨테이너(init 포함). 둘 이상일 때만 선택이 보인다 */
  containers: K8sContainer[];
  /** 처음에 열 컨테이너(null이면 모든 컨테이너) */
  initialContainer: string | null;
}

/**
 * 로그 탭의 위 막대와 보기. 막대에서 컨테이너(모든 컨테이너 포함)·이전 컨테이너·따라가기·기간·처음 줄 수를 고르고,
 * 보기는 JSON 정리(기본) 또는 원문, 서버 시각과 줄바꿈은 켜고 끈다(화면만 바뀌고 흐름은 다시 열지 않는다).
 */
function LogsShell({ target, ssoProfile, live, stream, containers, initialContainer }: ShellProps) {
  const [container, setContainer] = useState<string | null>(initialContainer);
  const [previous, setPrevious] = useState(false);
  const [follow, setFollow] = useState(true);
  const [tailLines, setTail] = useState(DEFAULT_TAIL);
  const [sinceSeconds, setSince] = useState<number | null>(null);
  const [pretty, setPretty] = useState(true);
  const [showTime, setShowTime] = useState(false);
  const [wrap, setWrap] = useState(true);
  const options = useMemo<K8sLogOptions>(() => ({ container, follow, tailLines, previous, sinceSeconds }), [container, follow, tailLines, previous, sinceSeconds]);

  return (
    <div className="k8s-logs">
      <div className="k8s-log-bar">
        <div className="k8s-seg" role="group" aria-label={LOG_VIEW_LABEL}>
          <button aria-pressed={pretty} onClick={() => setPretty(true)}>
            {LOG_VIEW_PRETTY}
          </button>
          <button aria-pressed={!pretty} onClick={() => setPretty(false)}>
            {LOG_VIEW_RAW}
          </button>
        </div>
        {containers.length > 1 && (
          <label className="k8s-check">
            {LOG_CONTAINER}
            <select value={container ?? ""} onChange={(e) => setContainer(e.target.value || null)}>
              <option value="">{LOG_ALL_CONTAINERS}</option>
              {containers.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.init ? `${c.name} (init)` : c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="k8s-check">
          <input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} />
          {LOG_PREVIOUS}
        </label>
        <label className="k8s-check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          {LOG_FOLLOW}
        </label>
        <select aria-label={LOG_SINCE} title={LOG_SINCE} value={sinceSeconds ?? ""} onChange={(e) => setSince(e.target.value ? Number(e.target.value) : null)}>
          {LOG_SINCE_CHOICES.map((c) => (
            <option key={c.label} value={c.seconds ?? ""}>
              {c.label}
            </option>
          ))}
        </select>
        <select aria-label={LOG_TAIL} title={LOG_TAIL} value={tailLines} onChange={(e) => setTail(Number(e.target.value))}>
          {TAIL_CHOICES.map((n) => (
            <option key={n} value={n}>
              {logTailOption(n)}
            </option>
          ))}
        </select>
        <label className="k8s-check" title={LOG_TIME_TITLE}>
          <input type="checkbox" checked={showTime} onChange={(e) => setShowTime(e.target.checked)} />
          {LOG_TIME}
        </label>
        <label className="k8s-check">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
          {LOG_WRAP}
        </label>
      </div>
      <LogView target={target} ssoProfile={ssoProfile} live={live} stream={stream} options={options} pretty={pretty} showTime={showTime} wrap={wrap} />
    </div>
  );
}

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  live: boolean;
  namespace: string;
  pod: string;
  /** 상세에서 읽은 컨테이너(init 포함, 템플릿 제외) */
  containers: K8sContainer[];
}

/** 4열 상세의 Pod 로그 탭. 처음에는 첫 앱 컨테이너를 열고, 모든 컨테이너를 한꺼번에 볼 수도 있다. */
export function PodLogs({ target, ssoProfile, live, namespace, pod, containers }: Props) {
  const stream = useMemo<LogStream>(() => ({ kind: "pod", namespace, pod }), [namespace, pod]);
  const first = containers.find((c) => !c.init)?.name ?? containers[0]?.name ?? null;
  return <LogsShell target={target} ssoProfile={ssoProfile} live={live} stream={stream} containers={containers} initialContainer={first} />;
}

interface WorkloadProps {
  target: K8sTarget;
  ssoProfile: string;
  live: boolean;
  kind: K8sKindRef;
  namespace: string;
  name: string;
  /** 워크로드의 Pod 템플릿에서 읽은 컨테이너(없으면 모든 컨테이너만 있다) */
  containers: K8sContainer[];
}

/** Deployment·StatefulSet·DaemonSet·ReplicaSet·Job·Service의 로그 탭: 셀렉터에 맞는 모든 Pod의 모든 컨테이너를 합쳐 보고, 나중에 생기는 Pod에도 붙는다. */
export function WorkloadLogs({ target, ssoProfile, live, kind, namespace, name, containers }: WorkloadProps) {
  const stream = useMemo<LogStream>(() => ({ kind: "workload", ref: kind, namespace, name }), [kind, namespace, name]);
  return <LogsShell target={target} ssoProfile={ssoProfile} live={live} stream={stream} containers={containers} initialContainer={null} />;
}
