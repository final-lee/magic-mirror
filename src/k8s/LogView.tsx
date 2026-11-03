import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { reportSsoExpired } from "../api/invoke";
import { desktop } from "../api/desktop";
import { errorMessage } from "../api/errors";
import { ErrorState } from "../components/ErrorState";
import { k8sApi } from "./api";
import { JsonLogLine } from "./JsonLogLine";
import { lineTone, type LogTone } from "./jsonLog";
import { EMPTY_BUFFER, KEEP_LINES, appendLines, sourceKey, type LogBuffer, type LogEntry } from "./logBuffer";
import { highlight, matchRanges, searchPattern } from "./logSearch";
import { fullName, lineText, logFileName, sourceLabels, timeText, type SourceLabel } from "./logSources";
import {
  COPIED, COPY, LOG_EMPTY, LOG_ENDED, LOG_LEVEL_NAMES, LOG_LEVEL_NONE, LOG_LEVEL_OTHER_TITLE, LOG_LEVELS, LOG_OPENING, LOG_PAUSE, LOG_RESTART, LOG_RESUME,
  LOG_REVEAL, LOG_SAVE, LOG_SEARCH, LOG_SOURCES, LOG_TO_BOTTOM, logMatches, logPending, logSaved, logSaveFailed, logSourceError, logSourceTitle, logTrimmed,
} from "./text";
import { targetKey } from "./targets";
import type { K8sKindRef, K8sLogMessage, K8sLogOptions, K8sTarget } from "./types";

/** 로그를 어디서 받을지: Pod 하나, 또는 워크로드(셀렉터에 맞는 모든 Pod) */
export type LogStream = { kind: "pod"; namespace: string; pod: string } | { kind: "workload"; ref: K8sKindRef; namespace: string; name: string };

type Status = "opening" | "streaming" | "ended" | "error";

/** 흐름 하나(Pod·컨테이너). 끝났거나 실패했으면 ended, 실패했으면 error도 있다. */
interface SourceState {
  key: string;
  pod: string;
  /** 컨테이너를 알 수 없는 오류 흐름이면 빈 글 */
  container: string;
  ended: boolean;
  error: unknown;
}

interface StreamState {
  buf: LogBuffer;
  sources: SourceState[];
  notices: string[];
  status: Status;
  /** 흐름 전체의 오류(status가 error일 때) */
  error: unknown;
}

const INITIAL: StreamState = { buf: EMPTY_BUFFER, sources: [], notices: [], status: "opening", error: null };

type Action = { type: "reset" } | { type: "message"; message: K8sLogMessage } | { type: "fail"; error: unknown };

/** 흐름을 찾아 patch를 합친다. 없으면 새로 붙이고, 바뀐 것이 없으면 같은 배열을 돌려준다(이름표를 다시 만들지 않게). */
function upsert(sources: SourceState[], pod: string, container: string, patch: Partial<Pick<SourceState, "ended" | "error">>): SourceState[] {
  const key = sourceKey(pod, container);
  const i = sources.findIndex((s) => s.key === key);
  if (i < 0) return [...sources, { key, pod, container, ended: false, error: null, ...patch }];
  const next = { ...sources[i], ...patch };
  if (next.ended === sources[i].ended && next.error === sources[i].error) return sources;
  const out = [...sources];
  out[i] = next;
  return out;
}

function reduce(state: StreamState, action: Action): StreamState {
  if (action.type === "reset") return INITIAL;
  if (action.type === "fail") return { ...state, status: "error", error: action.error };
  const m = action.message;
  switch (m.type) {
    case "lines": {
      const source = sourceKey(m.pod, m.container);
      const entries = m.lines.map((l): LogEntry => ({ source, ts: l.ts, text: l.text }));
      return { ...state, buf: appendLines(state.buf, entries), sources: upsert(state.sources, m.pod, m.container, {}), status: "streaming" };
    }
    case "source":
      return { ...state, sources: upsert(state.sources, m.pod, m.container, m.state === "ended" ? { ended: true } : { ended: false, error: null }), status: "streaming" };
    case "notice":
      return state.notices.includes(m.message) ? state : { ...state, notices: [...state.notices, m.message] };
    case "error":
      // pod가 있으면 그 흐름만 실패한 것이다: 나머지는 계속 받는다
      if (m.pod !== null) return { ...state, sources: upsert(state.sources, m.pod, m.container ?? "", { ended: true, error: m.error }), status: "streaming" };
      return { ...state, status: "error", error: m.error };
    case "end":
      return { ...state, status: "ended" };
  }
}

/** 로그 흐름 하나. 옵션이나 nonce가 바뀌면 끊고 처음부터 다시 연다. 컴포넌트가 사라지면 끊는다. */
export function useLogStream(target: K8sTarget, ssoProfile: string, live: boolean, stream: LogStream, options: K8sLogOptions, nonce: number) {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const key = JSON.stringify([targetKey(target), stream, options, nonce, live, ssoProfile]);

  useEffect(() => {
    dispatch({ type: "reset" });
    if (!live) return;
    let gone = false;
    let id: number | null = null;
    const startedAt = Date.now();
    const onMessage = (message: K8sLogMessage) => {
      if (gone) return;
      if (message.type === "error" && message.error.kind === "ssoExpired") reportSsoExpired(ssoProfile, startedAt);
      dispatch({ type: "message", message });
    };
    (stream.kind === "pod"
      ? k8sApi.logs(target, stream.namespace, stream.pod, options, ssoProfile, onMessage)
      : k8sApi.workloadLogs(target, stream.ref, stream.namespace, stream.name, options, ssoProfile, onMessage)
    )
      .then((n) => {
        if (gone) void k8sApi.unwatch(n);
        else id = n;
      })
      .catch((e: unknown) => {
        if (!gone) dispatch({ type: "fail", error: e });
      });
    return () => {
      gone = true;
      if (id !== null) void k8sApi.unwatch(id);
    };
    // key가 대상·로그 출처·옵션·nonce·live·프로필을 모두 담는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

/** 줄 앞에 붙는 출처 이름표와 서버 시각. 붙일 것이 없으면 null */
function leadOf(e: LogEntry, label: SourceLabel | undefined, showTime: boolean): ReactNode {
  const time = showTime && e.ts !== null ? <span className="k8s-log-ts">{timeText(e.ts)} </span> : null;
  if (!label && !time) return null;
  return (
    <>
      {label && (
        <span className={`k8s-log-src lc${label.color}`} title={label.title}>
          {label.text}{" "}
        </span>
      )}
      {time}
    </>
  );
}

/**
 * 묶음 하나. 다 찬 묶음은 배열이 바뀌지 않아 다시 그리지 않는다.
 * 정리 보기면 `{`로 시작하는 줄을 JSON 로그로 그리고(`JsonLogLine`), 나머지 줄은 원문 그대로 둔다. 출처 이름표와 시각이 있으면 줄마다 앞에 붙인다.
 */
const Chunk = memo(function Chunk({ lines, query, pretty, labels, showTime }: { lines: LogEntry[]; query: string; pretty: boolean; labels: Map<string, SourceLabel> | null; showTime: boolean }) {
  const re = searchPattern(query);
  if (!re && !pretty && !labels && !showTime) return <>{lines.map((l) => l.text).join("\n") + "\n"}</>;
  const out: ReactNode[] = [];
  let plain = "";
  lines.forEach((e, i) => {
    const json = pretty && e.text.trimStart().startsWith("{");
    const lead = leadOf(e, labels?.get(e.source), showTime);
    if (lead === null && !json && (!re || matchRanges(e.text, re).length === 0)) {
      plain += e.text + "\n";
      return;
    }
    if (plain) out.push(plain);
    plain = "";
    out.push(
      json ? (
        <JsonLogLine key={i} line={e.text} query={query} lead={lead} />
      ) : (
        <span key={i}>
          {lead}
          {highlight(e.text, re)}
          {"\n"}
        </span>
      ),
    );
  });
  if (plain) out.push(plain);
  return <>{out}</>;
});

/** 묶음마다 일치하는 줄 수를 기억한다. 다 찬 묶음은 배열이 바뀌지 않으니 따라가는 동안에도 마지막 묶음만 다시 센다. */
const counted = new WeakMap<LogEntry[], { query: string; n: number }>();
function matchingLines(lines: LogEntry[], query: string, re: RegExp): number {
  const hit = counted.get(lines);
  if (hit && hit.query === query) return hit.n;
  const n = lines.reduce((sum, l) => {
    re.lastIndex = 0;
    return sum + (re.test(l.text) ? 1 : 0);
  }, 0);
  counted.set(lines, { query, n });
  return n;
}

type Level = LogTone | "other";
const LEVELS: Level[] = ["error", "warn", "info", "debug", "other"];

/** 묶음마다 줄의 레벨을 기억한다. 다 찬 묶음은 한 번만 읽는다. */
const leveled = new WeakMap<LogEntry[], Level[]>();
function levelsOf(lines: LogEntry[]): Level[] {
  let got = leveled.get(lines);
  if (!got) {
    got = lines.map((l) => lineTone(l.text) ?? "other");
    leveled.set(lines, got);
  }
  return got;
}

/**
 * 고른 레벨의 줄만. 고른 것이 없으면 모든 줄(같은 배열이라 묶음별 기억이 그대로 쓰인다).
 * 걸러 낸 배열도 묶음마다 기억해, 다 찬 묶음은 다시 그리지도 다시 세지도 않는다.
 */
const picked = new WeakMap<LogEntry[], { key: string; lines: LogEntry[] }>();
function pickLevels(lines: LogEntry[], levels: ReadonlySet<Level>): LogEntry[] {
  if (levels.size === 0) return lines;
  const key = LEVELS.filter((l) => levels.has(l)).join();
  const hit = picked.get(lines);
  if (hit?.key === key) return hit.lines;
  const ls = levelsOf(lines);
  const out = lines.filter((_, i) => levels.has(ls[i]));
  picked.set(lines, { key, lines: out });
  return out;
}

/** 감추지 않은 출처의 줄만. 감춘 것이 없으면 모든 줄. 이것도 묶음마다 기억한다(key는 감춘 출처 목록). */
const sourcePicked = new WeakMap<LogEntry[], { key: string; lines: LogEntry[] }>();
function pickSources(lines: LogEntry[], hidden: ReadonlySet<string>, key: string): LogEntry[] {
  if (hidden.size === 0) return lines;
  const hit = sourcePicked.get(lines);
  if (hit?.key === key) return hit.lines;
  const out = lines.filter((l) => !hidden.has(l.source));
  sourcePicked.set(lines, { key, lines: out });
  return out;
}

/** 묶음마다 출처별 줄 수를 기억한다 */
const sourceCounted = new WeakMap<LogEntry[], Map<string, number>>();
function sourceCountsOf(lines: LogEntry[]): Map<string, number> {
  let got = sourceCounted.get(lines);
  if (!got) {
    got = new Map();
    for (const l of lines) got.set(l.source, (got.get(l.source) ?? 0) + 1);
    sourceCounted.set(lines, got);
  }
  return got;
}

interface ViewProps {
  target: K8sTarget;
  ssoProfile: string;
  live: boolean;
  stream: LogStream;
  options: K8sLogOptions;
  pretty: boolean;
  showTime: boolean;
  wrap: boolean;
}

/**
 * 로그 보기: 출처 칩(여러 Pod·컨테이너를 합쳐 볼 때), 레벨 거르기(여러 개), 찾기, 일시정지, 복사·저장(보이는 줄 그대로), 맨 아래 따라가기.
 * 출처가 둘 이상이면 줄마다 출처 이름표를 앞에 붙이고, 칩으로 출처마다 보이거나 감춘다.
 */
export function LogView({ target, ssoProfile, live, stream, options, pretty, showTime, wrap }: ViewProps) {
  const [nonce, setNonce] = useState(0);
  const { buf, sources, notices, status, error } = useLogStream(target, ssoProfile, live, stream, options, nonce);
  const restart = () => setNonce((n) => n + 1);
  const name = stream.kind === "pod" ? stream.pod : stream.name;

  // 출처 목록(Pod·컨테이너)이 같으면 이름표도 같다: 오류나 끝남이 바뀌어도 모든 묶음을 다시 그리지 않는다
  const sourceList = sources.map((s) => s.key).join("\n");
  const labels = useMemo(
    () => sourceLabels(sources, stream.kind === "workload" ? stream.name : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceList, stream.kind === "workload" ? stream.name : ""],
  );

  const [query, setQuery] = useState("");
  const [levels, setLevels] = useState<ReadonlySet<Level>>(new Set());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [paused, setPaused] = useState<LogBuffer | null>(null);
  const shown = paused ?? buf;
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<{ path: string } | { error: string } | null>(null);
  const hiddenKey = useMemo(() => [...hidden].sort().join("\n"), [hidden]);
  const sourced = useMemo(() => shown.chunks.map((c) => ({ id: c.id, lines: pickSources(c.lines, hidden, hiddenKey) })), [shown, hidden, hiddenKey]);
  const visible = useMemo(() => sourced.map((c) => ({ id: c.id, lines: pickLevels(c.lines, levels) })), [sourced, levels]);
  const counts = useMemo(() => {
    const n: Record<Level, number> = { error: 0, warn: 0, info: 0, debug: 0, other: 0 };
    for (const c of sourced) for (const l of levelsOf(c.lines)) n[l]++;
    return n;
  }, [sourced]);
  const perSource = useMemo(() => {
    const n = new Map<string, number>();
    for (const c of shown.chunks) for (const [k, v] of sourceCountsOf(c.lines)) n.set(k, (n.get(k) ?? 0) + v);
    return n;
  }, [shown]);
  const matches = useMemo(() => {
    const re = searchPattern(query);
    return re ? visible.reduce((n, c) => n + matchingLines(c.lines, query, re), 0) : 0;
  }, [visible, query]);
  const toggle = <T,>(set: ReadonlySet<T>, item: T): Set<T> => {
    const next = new Set(set);
    if (!next.delete(item)) next.add(item);
    return next;
  };

  // 맨 아래에 붙어 있으면 새 줄을 따라 내려간다. 위로 올려 읽는 중이면 그대로 둔다.
  const box = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [visible, atBottom]);
  const onScroll = () => {
    const el = box.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };
  // 옵션을 바꿔 다시 열면 일시정지를 풀고 저장 안내를 지운다
  useEffect(() => {
    setPaused(null);
    setSaved(null);
  }, [options, nonce]);

  // 복사·저장은 화면에 보이는 그대로(출처 이름표와 시각이 보이면 함께)
  const shownText = () => visible.flatMap((c) => c.lines.map((l) => lineText(l, labels?.get(l.source), showTime))).join("\n");
  const copy = async () => {
    await desktop.copy(shownText());
    setCopied(true);
  };
  const save = async () => {
    try {
      setSaved({ path: await k8sApi.logsSave(logFileName(name, new Date()), shownText() + "\n") });
    } catch (e) {
      setSaved({ error: errorMessage(e) });
    }
  };
  const visibleCount = visible.reduce((n, c) => n + c.lines.length, 0);
  const failed = sources.filter((s) => s.error !== null);

  return (
    <>
      {labels && (
        <div className="k8s-sources" role="group" aria-label={LOG_SOURCES}>
          {sources.map((s) => {
            const label = labels.get(s.key);
            return (
              <button
                key={s.key}
                className={`k8s-src-chip lc${label?.color ?? 1}${s.ended ? " ended" : ""}`}
                aria-pressed={!hidden.has(s.key)}
                title={logSourceTitle(label?.title ?? fullName(s), s.ended)}
                onClick={() => setHidden((h) => toggle(h, s.key))}
              >
                {label?.text ?? fullName(s)} <span className="k8s-lvl-n">{(perSource.get(s.key) ?? 0).toLocaleString("ko-KR")}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="k8s-log-bar">
        <div className="k8s-levels" role="group" aria-label={LOG_LEVELS}>
          {LEVELS.map((l) => (
            <button key={l} className={`k8s-lvl k8s-lvl-${l}`} aria-pressed={levels.has(l)} title={l === "other" ? LOG_LEVEL_OTHER_TITLE : undefined} onClick={() => setLevels((s) => toggle(s, l))}>
              {LOG_LEVEL_NAMES[l]} <span className="k8s-lvl-n">{counts[l].toLocaleString("ko-KR")}</span>
            </button>
          ))}
        </div>
        <input type="search" className="k8s-filter" aria-label={LOG_SEARCH} placeholder={LOG_SEARCH} value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && <span className="dim k8s-log-count">{logMatches(matches)}</span>}
        <button className="btn tone-secondary" aria-pressed={paused !== null} onClick={() => setPaused((p) => (p ? null : buf))}>
          {paused ? LOG_RESUME : LOG_PAUSE}
        </button>
        {paused && buf.received > paused.received && <span className="dim k8s-log-count">{logPending(buf.received - paused.received)}</span>}
        <button className="btn tone-secondary" disabled={visibleCount === 0} onClick={() => void copy()} onBlur={() => setCopied(false)}>
          {copied ? COPIED : COPY}
        </button>
        <button className="btn tone-secondary" disabled={visibleCount === 0} onClick={() => void save()}>
          {LOG_SAVE}
        </button>
      </div>
      {status === "error" && <ErrorState error={error} profile={ssoProfile} compact onRetry={restart} onLoggedIn={restart} />}
      {failed.map((s) => (
        <p key={s.key} className="k8s-hint k8s-log-fail" role="alert">
          {logSourceError(fullName(s), errorMessage(s.error))}
        </p>
      ))}
      {notices.map((n) => (
        <p key={n} className="dim k8s-hint">
          {n}
        </p>
      ))}
      {saved && (
        <p className="dim k8s-hint" role="status">
          {"path" in saved ? logSaved(saved.path) : logSaveFailed(saved.error)}{" "}
          {"path" in saved && (
            <button className="link" onClick={() => void desktop.reveal(saved.path)}>
              {LOG_REVEAL}
            </button>
          )}
        </p>
      )}
      {shown.trimmed && <p className="dim k8s-hint">{logTrimmed(KEEP_LINES)}</p>}
      {shown.size > 0 && visibleCount === 0 && <p className="dim k8s-hint">{LOG_LEVEL_NONE}</p>}
      <div className="k8s-log-wrap">
        <div ref={box} className={`k8s-log mono${wrap ? "" : " nowrap"}`} onScroll={onScroll} aria-label={name}>
          {visible.map((c) => (
            <Chunk key={c.id} lines={c.lines} query={query} pretty={pretty} labels={labels} showTime={showTime} />
          ))}
        </div>
        {!atBottom && (
          <button
            className="btn k8s-log-bottom tone-secondary"
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
    </>
  );
}
