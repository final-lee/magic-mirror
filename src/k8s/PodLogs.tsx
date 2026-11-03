import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { reportSsoExpired } from "../api/invoke";
import { desktop } from "../api/desktop";
import { ErrorState } from "../components/ErrorState";
import { k8sApi } from "./api";
import { JsonLogLine } from "./JsonLogLine";
import { lineTone, type LogTone } from "./jsonLog";
import { EMPTY_BUFFER, KEEP_LINES, appendLines, type LogBuffer } from "./logBuffer";
import { highlight, matchRanges, searchPattern } from "./logSearch";
import {
  COPIED, COPY, LOG_CONTAINER, LOG_EMPTY, LOG_ENDED, LOG_FOLLOW, LOG_LEVEL_NAMES, LOG_LEVEL_NONE, LOG_LEVEL_OTHER_TITLE, LOG_LEVELS, LOG_OPENING, LOG_PAUSE,
  LOG_PREVIOUS, LOG_RESTART, LOG_RESUME, LOG_SEARCH, LOG_TAIL, LOG_TO_BOTTOM, LOG_VIEW_LABEL, LOG_VIEW_PRETTY, LOG_VIEW_RAW, logMatches, logPending,
  logTailOption, logTrimmed,
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

/**
 * 묶음 하나. 다 찬 묶음은 배열이 바뀌지 않아 다시 그리지 않는다.
 * 정리 보기면 `{`로 시작하는 줄을 JSON 로그로 그리고(`JsonLogLine`), 나머지 줄은 원문 그대로 둔다.
 */
const Chunk = memo(function Chunk({ lines, query, pretty }: { lines: string[]; query: string; pretty: boolean }) {
  const re = searchPattern(query);
  if (!re && !pretty) return <>{lines.join("\n") + "\n"}</>;
  const out: ReactNode[] = [];
  let plain = "";
  lines.forEach((line, i) => {
    const json = pretty && line.trimStart().startsWith("{");
    if (!json && (!re || matchRanges(line, re).length === 0)) {
      plain += line + "\n";
      return;
    }
    if (plain) out.push(plain);
    plain = "";
    out.push(json ? <JsonLogLine key={i} line={line} query={query} /> : <span key={i}>{highlight(line, re)}{"\n"}</span>);
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

type Level = LogTone | "other";
const LEVELS: Level[] = ["error", "warn", "info", "debug", "other"];

/** 묶음마다 줄의 레벨을 기억한다. 다 찬 묶음은 한 번만 읽는다. */
const leveled = new WeakMap<string[], Level[]>();
function levelsOf(lines: string[]): Level[] {
  let got = leveled.get(lines);
  if (!got) {
    got = lines.map((l) => lineTone(l) ?? "other");
    leveled.set(lines, got);
  }
  return got;
}

/**
 * 고른 레벨의 줄만. 고른 것이 없으면 모든 줄(같은 배열이라 묶음별 기억이 그대로 쓰인다).
 * 걸러 낸 배열도 묶음마다 기억해, 다 찬 묶음은 다시 그리지도 다시 세지도 않는다.
 */
const picked = new WeakMap<string[], { key: string; lines: string[] }>();
function pickLevels(lines: string[], levels: ReadonlySet<Level>): string[] {
  if (levels.size === 0) return lines;
  const key = LEVELS.filter((l) => levels.has(l)).join();
  const hit = picked.get(lines);
  if (hit?.key === key) return hit.lines;
  const ls = levelsOf(lines);
  const out = lines.filter((_, i) => levels.has(ls[i]));
  picked.set(lines, { key, lines: out });
  return out;
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

/** 4열 상세의 로그 탭. 위 막대에서 컨테이너·이전 컨테이너·따라가기·처음 줄 수를 고르고, 보기는 JSON 정리(기본) 또는 원문. */
export function PodLogs({ target, ssoProfile, live, namespace, pod, containers }: Props) {
  const names = containers.map((c) => c.name);
  const firstApp = containers.find((c) => !c.init)?.name ?? names[0] ?? null;
  const [container, setContainer] = useState<string | null>(firstApp);
  const [previous, setPrevious] = useState(false);
  const [follow, setFollow] = useState(true);
  const [tailLines, setTail] = useState(DEFAULT_TAIL);
  const [pretty, setPretty] = useState(true);
  const options = useMemo<K8sLogOptions>(() => ({ container, follow, tailLines, previous }), [container, follow, tailLines, previous]);

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
      <LogView target={target} ssoProfile={ssoProfile} live={live} namespace={namespace} pod={pod} options={options} pretty={pretty} />
    </div>
  );
}

interface ViewProps {
  target: K8sTarget;
  ssoProfile: string;
  live: boolean;
  namespace: string;
  pod: string;
  options: K8sLogOptions;
  pretty: boolean;
}

/** 로그 보기: 레벨 거르기(여러 개), 찾기, 일시정지, 복사(보이는 줄의 원문), 맨 아래 따라가기 */
function LogView({ target, ssoProfile, live, namespace, pod, options, pretty }: ViewProps) {
  const [nonce, setNonce] = useState(0);
  const { buf, status, error } = usePodLogs(target, ssoProfile, live, namespace, pod, options, nonce);
  const restart = () => setNonce((n) => n + 1);

  const [query, setQuery] = useState("");
  const [levels, setLevels] = useState<ReadonlySet<Level>>(new Set());
  const [paused, setPaused] = useState<LogBuffer | null>(null);
  const shown = paused ?? buf;
  const [copied, setCopied] = useState(false);
  const visible = useMemo(() => shown.chunks.map((c) => ({ id: c.id, lines: pickLevels(c.lines, levels) })), [shown, levels]);
  const counts = useMemo(() => {
    const n: Record<Level, number> = { error: 0, warn: 0, info: 0, debug: 0, other: 0 };
    for (const c of shown.chunks) for (const l of levelsOf(c.lines)) n[l]++;
    return n;
  }, [shown]);
  const matches = useMemo(() => {
    const re = searchPattern(query);
    return re ? visible.reduce((n, c) => n + matchingLines(c.lines, query, re), 0) : 0;
  }, [visible, query]);
  const toggleLevel = (l: Level) =>
    setLevels((s) => {
      const next = new Set(s);
      if (!next.delete(l)) next.add(l);
      return next;
    });

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
  // 옵션을 바꿔 다시 열면 일시정지를 푼다
  useEffect(() => setPaused(null), [options, nonce]);

  const copy = async () => {
    await desktop.copy(visible.map((c) => c.lines.join("\n")).join("\n"));
    setCopied(true);
  };
  const visibleCount = visible.reduce((n, c) => n + c.lines.length, 0);

  return (
    <>
      <div className="k8s-log-bar">
        <div className="k8s-levels" role="group" aria-label={LOG_LEVELS}>
          {LEVELS.map((l) => (
            <button key={l} className={`k8s-lvl k8s-lvl-${l}`} aria-pressed={levels.has(l)} title={l === "other" ? LOG_LEVEL_OTHER_TITLE : undefined} onClick={() => toggleLevel(l)}>
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
      </div>
      {status === "error" && <ErrorState error={error} profile={ssoProfile} compact onRetry={restart} onLoggedIn={restart} />}
      {shown.trimmed && <p className="dim k8s-hint">{logTrimmed(KEEP_LINES)}</p>}
      {shown.size > 0 && visibleCount === 0 && <p className="dim k8s-hint">{LOG_LEVEL_NONE}</p>}
      <div className="k8s-log-wrap">
        <div ref={box} className="k8s-log mono" onScroll={onScroll} aria-label={pod}>
          {visible.map((c) => (
            <Chunk key={c.id} lines={c.lines} query={query} pretty={pretty} />
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
