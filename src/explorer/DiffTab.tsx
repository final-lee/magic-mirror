import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { ErrorState } from "../components/ErrorState";
import { formatBytes, formatDate } from "../lib/format";
import { explorerApi } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { refKey, refLabel } from "./rows";
import type { DiffLine, DiffResult, DiffRow, FileRef, TransferRequest } from "./types";
import type { Transfers } from "./useTransfers";

interface Props {
  profile: string | null;
  left: FileRef;
  right: FileRef;
  active: boolean;
  transfers: Transfers;
}

const VERDICT = { same: "같은 파일로 보여요", different: "두 파일이 달라요", unknown: "같은지 판단할 수 없어요" } as const;
const REASON = {
  binary: "바이너리 파일이라 내용 대신 정보만 비교해요",
  tooLarge: "2MB가 넘어서 내용 대신 정보만 비교해요",
} as const;

function Line({ line }: { line: DiffLine | null }) {
  if (!line) return <div className="dcell empty-cell" />;
  return (
    <div className="dcell">
      <span className="ln">{line.no}</span>
      <span className="code">
        {line.segments.map((s, i) => (
          <span key={i} className={s.emph ? "emph" : undefined}>
            {s.text}
          </span>
        ))}
      </span>
    </div>
  );
}

function RowView({ row }: { row: DiffRow }) {
  return (
    <>
      <Line line={row.left} />
      <Line line={row.right} />
    </>
  );
}

export function DiffTab({ profile, left, right, active, transfers }: Props) {
  const q = useQuery<DiffResult>({
    queryKey: ["diff", profile, refKey(left), refKey(right)],
    queryFn: () => explorerApi.diffFiles(profile!, left, right),
    enabled: !!profile,
    staleTime: Infinity,
    retry: false,
  });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [current, setCurrent] = useState(-1);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ message: string; request: TransferRequest } | null>(null);
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const hunks = q.data?.hunks ?? [];

  const go = (dir: 1 | -1) => {
    if (hunks.length === 0) return;
    const next = current < 0 ? (dir === 1 ? 0 : hunks.length - 1) : (current + dir + hunks.length) % hunks.length;
    setCurrent(next);
    rowRefs.current.get(hunks[next])?.scrollIntoView?.({ block: "center" });
  };
  const goRef = useRef(go);
  goRef.current = go;

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "F7") return;
      e.preventDefault();
      goRef.current(e.shiftKey ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  const localRef = left.source === "local" ? left : right.source === "local" ? right : null;
  const s3Ref = left.source === "s3" ? left : right.source === "s3" ? right : null;
  const transferTo = (direction: "upload" | "download") => {
    if (!localRef || localRef.source !== "local" || !s3Ref || s3Ref.source !== "s3") return;
    const request: TransferRequest = {
      id: crypto.randomUUID(),
      direction,
      localPath: localRef.path,
      bucket: s3Ref.bucket,
      region: s3Ref.region,
      key: s3Ref.key,
    };
    const target = direction === "upload" ? refLabel(s3Ref) : localRef.path;
    setConfirm({ message: `${target}을(를) 덮어쓸까요?`, request });
  };

  const openExternal = () => {
    if (!profile) return;
    setNotice(null);
    explorerApi.openExternalDiff(profile, left, right).catch((e) => setNotice(errorMessage(e)));
  };

  const d = q.data;
  const sameText = d?.mode === "text" && d.stats.added + d.stats.removed + d.stats.changed === 0;

  return (
    <div className="diff">
      <div className="diff-head">
        {d?.mode === "text" && (
          <span className="stats">
            +{d.stats.added} −{d.stats.removed} ~{d.stats.changed}
          </span>
        )}
        <button className="btn small" disabled={hunks.length === 0} onClick={() => go(-1)}>
          ▲ 이전
        </button>
        <button className="btn small" disabled={hunks.length === 0} onClick={() => go(1)}>
          ▼ 다음
        </button>
        <span className="sp">
          {localRef && s3Ref && (
            <>
              <button className="btn small" onClick={() => transferTo("download")}>
                ← 로컬로 내려받기
              </button>
              <button className="btn small" onClick={() => transferTo("upload")}>
                S3로 업로드 →
              </button>
            </>
          )}
          <button className="btn small" onClick={openExternal}>
            외부 도구로 열기
          </button>
        </span>
      </div>
      {notice && <div className="error-banner">{notice}</div>}
      {q.isError && !d ? (
        <ErrorState error={q.error} profile={profile ?? ""} onRetry={() => void q.refetch()} />
      ) : !d ? (
        <div className="empty">비교하는 중…</div>
      ) : (
        <>
          <div className="diff-sides">
            {[d.left, d.right].map((s) => (
              <div key={s.label} className="diff-side">
                <b className="mono">{s.label}</b>
                <span className="dim">
                  {" "}
                  · {formatBytes(s.size)}
                  {s.modified ? ` · ${formatDate(s.modified)}` : ""}
                </span>
              </div>
            ))}
          </div>
          {d.mode === "meta" ? (
            <div className="meta-compare">
              <p className={d.metaVerdict === "different" ? "err" : undefined}>{VERDICT[d.metaVerdict ?? "unknown"]}</p>
              {d.reason && <p className="dim">{REASON[d.reason]}</p>}
              <table>
                <tbody>
                  <tr>
                    <th>크기</th>
                    <td>{formatBytes(d.left.size)}</td>
                    <td>{formatBytes(d.right.size)}</td>
                  </tr>
                  <tr>
                    <th>수정일</th>
                    <td>{d.left.modified ? formatDate(d.left.modified) : "—"}</td>
                    <td>{d.right.modified ? formatDate(d.right.modified) : "—"}</td>
                  </tr>
                  <tr>
                    <th>MD5</th>
                    <td className="mono">{d.left.md5 ?? "—"}</td>
                    <td className="mono">{d.right.md5 ?? "—"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <div className="diff-body">
              {sameText && (
                <div className="notice">{d?.eolOnly ? "줄바꿈(CRLF/LF)이나 파일 끝 줄바꿈만 달라요" : "두 파일이 같아요"}</div>
              )}
              {d.rows.map((row, i) => (
                <Fragment key={i}>
                  {row.kind === "collapsed" ? (
                    expanded.has(i) ? (
                      row.hiddenRows.map((h, j) => (
                        <div key={`${i}-${j}`} className="drow k-equal">
                          <RowView row={h} />
                        </div>
                      ))
                    ) : (
                      <div className="drow k-collapsed" ref={(el) => el && rowRefs.current.set(i, el)}>
                        <button className="link" onClick={() => setExpanded((prev) => new Set(prev).add(i))}>
                          … {row.hiddenRows.length}줄 같음
                        </button>
                      </div>
                    )
                  ) : (
                    <div
                      data-testid={`drow-${i}`}
                      className={`drow k-${row.kind}${hunks[current] === i ? " current" : ""}`}
                      ref={(el) => el && rowRefs.current.set(i, el)}
                    >
                      <RowView row={row} />
                    </div>
                  )}
                </Fragment>
              ))}
            </div>
          )}
        </>
      )}
      {confirm && (
        <ConfirmDialog
          title="덮어쓸까요?"
          message={confirm.message}
          actions={[{ label: "덮어쓰기", value: "ok", danger: true }]}
          onResult={(value) => {
            const req = confirm.request;
            setConfirm(null);
            if (value === "ok") void transfers.enqueue([req]);
          }}
        />
      )}
    </div>
  );
}
