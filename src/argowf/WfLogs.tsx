import { useEffect, useRef, useState } from "react";
import { reportSsoExpired } from "../api/invoke";
import { errorMessage } from "../api/errors";
import { JsonLogLine } from "../k8s/JsonLogLine";
import { KEEP_LINES } from "../k8s/logBuffer";
import { highlight, searchPattern } from "../k8s/logSearch";
import { argowfApi } from "./api";
import type { ArgoWfConn, ArtifactRef, WfLogLine } from "./types";

export function WfLogs({
  conn,
  namespace,
  name,
  pod,
  running,
  live,
  initialTail = 1000,
  archivedLogs = null,
  onNotice,
  onTokenError,
}: {
  conn: ArgoWfConn;
  namespace: string;
  name: string;
  pod: string | null;
  running: boolean;
  live: boolean;
  initialTail?: number;
  /** Pod가 지워졌을 때 대신 읽을 `main-logs` 아티팩트(archiveLogs). 이 노드에 없으면 null */
  archivedLogs?: ArtifactRef | null;
  onNotice?(m: string): void;
  onTokenError(m: string): void;
}) {
  const [container, setContainer] = useState("main");
  const [follow, setFollow] = useState(running);
  const [tail, setTail] = useState(initialTail);
  const [previous, setPrevious] = useState(false);
  const [since, setSince] = useState<number | null>(null);
  const [timestamps, setTimestamps] = useState(false);
  const [fromArtifact, setFromArtifact] = useState(false);
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState<WfLogLine[] | null>(null);
  const [auto, setAuto] = useState(true);
  const [lines, setLines] = useState<WfLogLine[]>([]);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!live) return;
    let gone = false;
    let id: number | null = null;
    setLines([]);
    setEnded(false);
    setError(null);
    setPaused(null);
    setFromArtifact(false);
    const startedAt = Date.now();
    argowfApi
      .logs(conn, namespace, name, pod, { container, follow, tailLines: tail, previous, sinceSeconds: since, timestamps }, (m) => {
        if (gone) return;
        if (m.type === "lines") setLines((old) => [...old, ...m.lines].slice(-KEEP_LINES));
        else if (m.type === "end") setEnded(true);
        else {
          if (m.error.kind === "ssoExpired" && conn.ssoProfile) reportSsoExpired(conn.ssoProfile, startedAt);
          const message = errorMessage(m.error);
          setError(message);
          onTokenError(message);
          setEnded(true);
        }
      })
      .then((n) => {
        if (gone) void argowfApi.logsStop(n);
        else id = n;
      })
      .catch((e: unknown) => {
        if (!gone) {
          const message = errorMessage(e);
          setError(message);
          onTokenError(message);
          setEnded(true);
        }
      });
    return () => {
      gone = true;
      if (id !== null) void argowfApi.logsStop(id);
    };
  }, [conn.url, conn.context, conn.ssoProfile, namespace, name, pod, container, follow, tail, previous, since, timestamps, live, onTokenError]);
  // Pod가 지워져 로그가 비면 보관된 로그(아티팩트)를 읽어 로그 줄로 보인다
  useEffect(() => {
    if (!ended || lines.length > 0 || !archivedLogs) return;
    let gone = false;
    argowfApi
      .artifactPreview(conn, archivedLogs)
      .then((preview) => {
        if (gone || !preview.text) return;
        setLines(preview.text.split("\n").map((text) => ({ pod: pod ?? "", text })));
        setFromArtifact(true);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!gone) setError(errorMessage(e));
      });
    return () => {
      gone = true;
    };
    // 읽는 것은 로그가 끝난 뒤 한 번이다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended, archivedLogs?.nodeId, archivedLogs?.name]);
  useEffect(() => {
    if (auto && !paused) bottom.current?.scrollIntoView?.();
  }, [lines, auto, paused]);
  const shown = paused ?? lines;
  const pattern = searchPattern(query);
  const save = async () => {
    const text = shown.map((line) => (pod ? line.text : `${line.pod} ${line.text}`)).join("\n");
    try {
      const path = await argowfApi.saveText(`${name}-${pod ?? "workflow"}.log`, text);
      if (path) onNotice?.(`로그를 저장했어요: ${path}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="k8s-logs">
      <div className="k8s-log-bar">
        <label>
          컨테이너{" "}
          <select value={container} onChange={(e) => setContainer(e.target.value)}>
            {["main", "init", "wait"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> 따라가기
        </label>
        <label>
          최근 줄 <input type="number" min={1} value={tail} onChange={(e) => setTail(Math.max(1, Number(e.target.value)))} />
        </label>
        <input aria-label="로그 검색" placeholder="로그 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn small" onClick={() => setPaused(paused ? null : lines)}>
          {paused ? "재개" : "일시정지"}
        </button>
        <label>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 자동 스크롤
        </label>
        <label>
          <input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} /> 직전 컨테이너
        </label>
        <label>
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} /> 시각 표시
        </label>
        <label>
          최근{" "}
          <input
            type="number"
            min={1}
            aria-label="최근 N초"
            placeholder="전체"
            value={since ?? ""}
            onChange={(e) => setSince(e.target.value === "" ? null : Math.max(1, Number(e.target.value)))}
          />
          초
        </label>
        <button className="btn small" disabled={shown.length === 0} onClick={() => void save()}>
          파일로 저장
        </button>
      </div>
      {fromArtifact && <p className="dim">Pod가 지워져서 보관된 로그(main-logs 아티팩트)를 보여 줘요</p>}
      {error && <p className="err">{error}</p>}
      {ended && shown.length === 0 && !error && <p>Pod가 지워져 로그가 없어요</p>}
      <pre className="argowf-logs">
        {shown.map((line, i) => (
          <span key={i}>
            {!pod && <span className={`argowf-pod-color-${[...line.pod].reduce((n, c) => n + c.charCodeAt(0), 0) % 6}`}>{line.pod} </span>}
            {line.text.trimStart().startsWith("{") ? (
              <JsonLogLine line={line.text} query={query} />
            ) : (
              <>
                {highlight(line.text, pattern)}
                {"\n"}
              </>
            )}
          </span>
        ))}
        <span ref={bottom} />
      </pre>
    </div>
  );
}
