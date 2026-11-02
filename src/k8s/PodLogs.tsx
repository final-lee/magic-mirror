import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { reportSsoExpired } from "../api/invoke";
import { desktop } from "../api/desktop";
import { ErrorState } from "../components/ErrorState";
import { k8sApi } from "./api";
import { EMPTY_BUFFER, KEEP_LINES, appendLines, type LogBuffer } from "./logBuffer";
import {
  COPIED, COPY, LOG_CONTAINER, LOG_EMPTY, LOG_ENDED, LOG_FOLLOW, LOG_OPENING, LOG_PAUSE, LOG_PREVIOUS, LOG_RESTART, LOG_RESUME, LOG_SEARCH, LOG_TAIL,
  LOG_TO_BOTTOM, logMatches, logPending, logTailOption, logTrimmed,
} from "./text";
import { targetKey } from "./targets";
import type { K8sContainer, K8sLogOptions, K8sTarget } from "./types";

export const TAIL_CHOICES = [100, 500, 1_000, 5_000, 10_000, KEEP_LINES];
const DEFAULT_TAIL = 500;

type Status = "opening" | "streaming" | "ended" | "error";

/** 로그 흐름 하나. 옵션이나 nonce가 바뀌면 끊고 처음부터 다시 연다. 컴포넌트가 사라지면 끊는다. */
export function usePodLogs(target: K8sTarget, ssoProfile: string, live: boolean, namespace: string, pod: string, options: K8sLogOptions, nonce: number) {
  const [buf, setBuf] = useState<LogBuffer>(EMPTY_BUFFER);
  const [status, setStatus] = useState<Status>("opening");
  const [error, setError] = useState<unknown>(null);
  const key = JSON.stringify([targetKey(target), namespace, pod, options, nonce, live, ssoProfile]);

  useEffect(() => {
    setBuf(EMPTY_BUFFER);
    setStatus("opening");
    setError(null);
    if (!live) return;
    let gone = false;
    let id: number | null = null;
    const startedAt = Date.now();
    k8sApi
      .logs(target, namespace, pod, options, ssoProfile, (m) => {
        if (gone) return;
        if (m.type === "lines") {
          setBuf((b) => appendLines(b, m.lines));
          setStatus("streaming");
        } else if (m.type === "end") {
          setStatus("ended");
        } else {
          if (m.error.kind === "ssoExpired") reportSsoExpired(ssoProfile, startedAt);
          setError(m.error);
          setStatus("error");
        }
      })
      .then((n) => {
        if (gone) void k8sApi.unwatch(n);
        else id = n;
      })
      .catch((e: unknown) => {
        if (gone) return;
        setError(e);
        setStatus("error");
      });
    return () => {
      gone = true;
      if (id !== null) void k8sApi.unwatch(id);
    };
    // key가 대상·네임스페이스·Pod·옵션·nonce·live·프로필을 모두 담는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { buf, status, error };
}

/** 대소문자를 가리지 않는 찾기. 원래 글의 위치로 맞추므로(소문자로 바꾸면 길이가 달라지는 글자가 있다) 정규식으로 찾는다. */
export function searchPattern(query: string): RegExp | null {
  return query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu") : null;
}

/** 줄 안의 일치를 원래 글의 [시작, 끝]으로 */
export function matchRanges(line: string, re: RegExp): [number, number][] {
  const out: [number, number][] = [];
  re.lastIndex = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    out.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/** 묶음 하나. 다 찬 묶음은 배열이 바뀌지 않아 다시 그리지 않는다. */
const Chunk = memo(function Chunk({ lines, query }: { lines: string[]; query: string }) {
  const re = searchPattern(query);
  if (!re) return <>{lines.join("\n") + "\n"}</>;
  const out: ReactNode[] = [];
  let plain = "";
  lines.forEach((line, i) => {
    const ranges = matchRanges(line, re);
    if (ranges.length === 0) {
      plain += line + "\n";
      return;
    }
    if (plain) out.push(plain);
    plain = "";
    let at = 0;
    for (const [from, to] of ranges) {
      if (from > at) out.push(line.slice(at, from));
      out.push(<mark key={`${i}:${from}`}>{line.slice(from, to)}</mark>);
      at = to;
    }
    out.push(line.slice(at) + "\n");
  });
  if (plain) out.push(plain);
  return <>{out}</>;
});

/** 묶음마다 일치하는 줄 수를 기억한다. 다 찬 묶음은 배열이 바뀌지 않으니 따라가는 동안에도 마지막 묶음만 다시 센다. */
const counted = new WeakMap<string[], { query: string; n: number }>();
function matchingLines(lines: string[], query: string, re: RegExp): number {
  const hit = counted.get(lines);
  if (hit && hit.query === query) return hit.n;
  const n = lines.reduce((sum, l) => {
    re.lastIndex = 0;
    return sum + (re.test(l) ? 1 : 0);
  }, 0);
  counted.set(lines, { query, n });
  return n;
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

/** 4열 상세의 로그 탭: 컨테이너 고르기, 이전 컨테이너, 따라가기, 처음 줄 수, 찾기, 일시정지, 복사 */
export function PodLogs({ target, ssoProfile, live, namespace, pod, containers }: Props) {
  const names = containers.map((c) => c.name);
  const firstApp = containers.find((c) => !c.init)?.name ?? names[0] ?? null;
  const [container, setContainer] = useState<string | null>(firstApp);
  const [previous, setPrevious] = useState(false);
  const [follow, setFollow] = useState(true);
  const [tailLines, setTail] = useState(DEFAULT_TAIL);
  const [nonce, setNonce] = useState(0);
  const options = useMemo<K8sLogOptions>(() => ({ container, follow, tailLines, previous }), [container, follow, tailLines, previous]);
  const { buf, status, error } = usePodLogs(target, ssoProfile, live, namespace, pod, options, nonce);
  const restart = () => setNonce((n) => n + 1);

  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState<LogBuffer | null>(null);
  const shown = paused ?? buf;
  const [copied, setCopied] = useState(false);
  const matches = useMemo(() => {
    const re = searchPattern(query);
    return re ? shown.chunks.reduce((n, c) => n + matchingLines(c.lines, query, re), 0) : 0;
  }, [shown, query]);

  // 맨 아래에 붙어 있으면 새 줄을 따라 내려간다. 위로 올려 읽는 중이면 그대로 둔다.
  const box = useRef<HTMLPreElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [shown, atBottom]);
  const onScroll = () => {
    const el = box.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };
  // 옵션을 바꿔 다시 열면 일시정지를 푼다
  useEffect(() => setPaused(null), [options, nonce]);

  const copy = async () => {
    await desktop.copy(shown.chunks.map((c) => c.lines.join("\n")).join("\n"));
    setCopied(true);
  };

  return (
    <div className="k8s-logs">
      <div className="k8s-log-bar">
        {names.length > 1 && (
          <label className="k8s-check">
            {LOG_CONTAINER}
            <select value={container ?? ""} onChange={(e) => setContainer(e.target.value)}>
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
        <select aria-label={LOG_TAIL} title={LOG_TAIL} value={tailLines} onChange={(e) => setTail(Number(e.target.value))}>
          {TAIL_CHOICES.map((n) => (
            <option key={n} value={n}>
              {logTailOption(n)}
            </option>
          ))}
        </select>
      </div>
      <div className="k8s-log-bar">
        <input type="search" className="k8s-filter" aria-label={LOG_SEARCH} placeholder={LOG_SEARCH} value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && <span className="dim k8s-log-count">{logMatches(matches)}</span>}
        <button className="btn" aria-pressed={paused !== null} onClick={() => setPaused((p) => (p ? null : buf))}>
          {paused ? LOG_RESUME : LOG_PAUSE}
        </button>
        {paused && buf.received > paused.received && <span className="dim k8s-log-count">{logPending(buf.received - paused.received)}</span>}
        <button className="btn" disabled={shown.size === 0} onClick={() => void copy()} onBlur={() => setCopied(false)}>
          {copied ? COPIED : COPY}
        </button>
      </div>
      {status === "error" && <ErrorState error={error} profile={ssoProfile} compact onRetry={restart} onLoggedIn={restart} />}
      {shown.trimmed && <p className="dim k8s-hint">{logTrimmed(KEEP_LINES)}</p>}
      <div className="k8s-log-wrap">
        <pre ref={box} className="k8s-log mono" onScroll={onScroll} aria-label={pod}>
          {shown.chunks.map((c) => (
            <Chunk key={c.id} lines={c.lines} query={query} />
          ))}
        </pre>
        {!atBottom && (
          <button
            className="btn k8s-log-bottom"
            onClick={() => {
              setAtBottom(true);
              const el = box.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            {LOG_TO_BOTTOM}
          </button>
        )}
      </div>
      {status === "opening" && <p className="dim k8s-hint">{LOG_OPENING}</p>}
      {status === "ended" && (
        <p className="dim k8s-hint">
          {shown.size === 0 ? LOG_EMPTY : LOG_ENDED}{" "}
          <button className="link" onClick={restart}>
            {LOG_RESTART}
          </button>
        </p>
      )}
    </div>
  );
}
