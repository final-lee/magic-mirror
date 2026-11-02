import { useQuery } from "@tanstack/react-query";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { reportSsoExpired } from "../api/invoke";
import { desktop } from "../api/desktop";
import { ErrorState } from "../components/ErrorState";
import { k8sApi } from "./api";
import { EMPTY_BUFFER, KEEP_LINES, appendLines, type LogBuffer } from "./logBuffer";
import {
  COPIED, COPY, LNAV_EXITED, LNAV_MISSING, LNAV_OPENING, LOG_CONTAINER, LOG_EMPTY, LOG_ENDED, LOG_FOLLOW, LOG_OPENING, LOG_PAUSE, LOG_PREVIOUS,
  LOG_RESTART, LOG_RESUME, LOG_SEARCH, LOG_TAIL, LOG_TO_BOTTOM, LOG_VIEW_LABEL, LOG_VIEW_LNAV, LOG_VIEW_TEXT, logMatches, logPending, logTailOption,
  logTrimmed,
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

/**
 * 4열 상세의 로그 탭. 위 막대에서 컨테이너·이전 컨테이너·따라가기·처음 줄 수를 고르고, 보기는 기본 lnav(설치돼 있을 때), 원하면 텍스트.
 * lnav가 없으면 텍스트로 보여 주고 설치 방법을 알려 준다.
 */
export function PodLogs({ target, ssoProfile, live, namespace, pod, containers }: Props) {
  const names = containers.map((c) => c.name);
  const firstApp = containers.find((c) => !c.init)?.name ?? names[0] ?? null;
  const [container, setContainer] = useState<string | null>(firstApp);
  const [previous, setPrevious] = useState(false);
  const [follow, setFollow] = useState(true);
  const [tailLines, setTail] = useState(DEFAULT_TAIL);
  const options = useMemo<K8sLogOptions>(() => ({ container, follow, tailLines, previous }), [container, follow, tailLines, previous]);
  const lnav = useQuery({ queryKey: ["lnav-available"], queryFn: k8sApi.lnavAvailable, staleTime: Infinity, retry: false });
  const [picked, setPicked] = useState<"lnav" | "text">("lnav");
  const mode = lnav.data === false || lnav.isError ? "text" : picked;

  return (
    <div className="k8s-logs">
      <div className="k8s-log-bar">
        <div className="k8s-seg" role="group" aria-label={LOG_VIEW_LABEL}>
          <button aria-pressed={mode === "lnav"} disabled={lnav.data !== true} onClick={() => setPicked("lnav")}>
            {LOG_VIEW_LNAV}
          </button>
          <button aria-pressed={mode === "text"} onClick={() => setPicked("text")}>
            {LOG_VIEW_TEXT}
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
      {lnav.data === false && <p className="dim k8s-hint">{LNAV_MISSING}</p>}
      {lnav.isPending ? (
        <p className="dim k8s-hint">{LOG_OPENING}</p>
      ) : mode === "lnav" ? (
        <LnavLogs key={JSON.stringify(options)} target={target} ssoProfile={ssoProfile} live={live} namespace={namespace} pod={pod} options={options} />
      ) : (
        <PlainLogs target={target} ssoProfile={ssoProfile} live={live} namespace={namespace} pod={pod} options={options} />
      )}
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
}

/** 텍스트 보기: 찾기, 일시정지, 복사, 맨 아래 따라가기 */
function PlainLogs({ target, ssoProfile, live, namespace, pod, options }: ViewProps) {
  const [nonce, setNonce] = useState(0);
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
    <>
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
    </>
  );
}

/** base64 PTY 출력 → 바이트(터미널이 UTF-8 경계를 이어 붙인다) */
function bytesOf(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 앱의 어두운 테마에 맞춘 터미널 색 */
const TERM_THEME = {
  background: "#1a1a1c", foreground: "#e6e6e8", cursor: "#e6e6e8", selectionBackground: "#0a84ff55",
  black: "#1e1e20", red: "#ff453a", green: "#30d158", yellow: "#ffd60a", blue: "#0a84ff", magenta: "#bf5af2", cyan: "#64d2ff", white: "#e6e6e8",
  brightBlack: "#6e6e73", brightRed: "#ff6961", brightGreen: "#4ae08a", brightYellow: "#ffe45c", brightBlue: "#409cff", brightMagenta: "#da8fff", brightCyan: "#8de3ff", brightWhite: "#ffffff",
};

/** lnav 보기: 터미널(xterm.js) 안에서 lnav가 로그 파일을 따라간다. 키 입력과 크기는 lnav로 간다. */
function LnavLogs({ target, ssoProfile, live, namespace, pod, options }: ViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<"opening" | "running" | "exited" | "error">("opening");
  const [error, setError] = useState<unknown>(null);
  const [logError, setLogError] = useState<unknown>(null);
  const [logEnded, setLogEnded] = useState(false);
  const restart = () => setNonce((n) => n + 1);

  useEffect(() => {
    setState("opening");
    setError(null);
    setLogError(null);
    setLogEnded(false);
    const el = host.current;
    if (!live || !el) return;
    const term = new Terminal({ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, theme: TERM_THEME, scrollback: 0, cursorBlink: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    let gone = false;
    let id: number | null = null;
    const startedAt = Date.now();
    k8sApi
      .lnav(target, namespace, pod, options, term.cols, term.rows, ssoProfile, (m) => {
        if (gone) return;
        if (m.type === "output") {
          term.write(bytesOf(m.data));
          setState((s) => (s === "opening" ? "running" : s));
        } else if (m.type === "exit") {
          setState("exited");
        } else if (m.type === "logEnd") {
          setLogEnded(true);
        } else {
          if (m.error.kind === "ssoExpired") reportSsoExpired(ssoProfile, startedAt);
          setLogError(m.error);
        }
      })
      .then((n) => {
        if (gone) {
          void k8sApi.unwatch(n);
          return;
        }
        id = n;
        term.focus();
      })
      .catch((e: unknown) => {
        if (gone) return;
        setError(e);
        setState("error");
      });
    const input = term.onData((d) => {
      if (id !== null) void k8sApi.lnavInput(id, d);
    });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      fit.fit();
      if (id !== null) void k8sApi.lnavResize(id, term.cols, term.rows);
    });
    resize?.observe(el);
    return () => {
      gone = true;
      resize?.disconnect();
      input.dispose();
      term.dispose();
      if (id !== null) void k8sApi.unwatch(id);
    };
    // 옵션은 이 컴포넌트의 key가 담는다(바뀌면 새로 띄운다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, live, ssoProfile]);

  return (
    <>
      {state === "error" && <ErrorState error={error} profile={ssoProfile} compact onRetry={restart} onLoggedIn={restart} />}
      {logError !== null && <ErrorState error={logError} profile={ssoProfile} compact onRetry={restart} onLoggedIn={restart} />}
      <div className="k8s-log-wrap">
        <div ref={host} className="k8s-term" aria-label={pod} />
        {state === "exited" && (
          <div className="k8s-term-over">
            <p>{LNAV_EXITED}</p>
            <button className="btn" onClick={restart}>
              {LOG_RESTART}
            </button>
          </div>
        )}
      </div>
      {state === "opening" && <p className="dim k8s-hint">{LNAV_OPENING}</p>}
      {logEnded && <p className="dim k8s-hint">{LOG_ENDED}</p>}
    </>
  );
}
