import { useState } from "react";
import { errorMessage } from "../api/errors";
import { desktop } from "../api/desktop";
import { argowfApi } from "./api";
import { isTokenError } from "./queries";
import type { ArgoWfConn, ArtifactPreview, ArtifactRef, WfArtifact, WfTarget } from "./types";

type Preview =
  { name: string; state: "loading" } | { name: string; state: "error"; message: string } | { name: string; state: "done"; preview: ArtifactPreview };

/** JSON이면 들여쓰고, 아니면 그대로 */
export function prettyText(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 노드의 아티팩트 표: [미리보기](글·JSON·이미지)와 [내려받기](저장 창) */
export function Artifacts({
  conn,
  target,
  nodeId,
  artifacts,
  onNotice,
  onTokenError,
}: {
  conn: ArgoWfConn;
  target: WfTarget;
  nodeId: string;
  artifacts: WfArtifact[];
  onNotice(m: string): void;
  onTokenError(m: string): void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  if (artifacts.length === 0) return <p className="dim">아티팩트가 없어요</p>;
  const ref = (a: WfArtifact): ArtifactRef => ({ target, nodeId, name: a.name, direction: a.direction });
  const fail = (e: unknown) => {
    if (isTokenError(e)) onTokenError(errorMessage(e));
    return errorMessage(e);
  };
  const open = async (a: WfArtifact) => {
    setPreview({ name: a.name, state: "loading" });
    try {
      setPreview({ name: a.name, state: "done", preview: await argowfApi.artifactPreview(conn, ref(a)) });
    } catch (e) {
      setPreview({ name: a.name, state: "error", message: fail(e) });
    }
  };
  const save = async (a: WfArtifact) => {
    try {
      const path = await argowfApi.saveArtifact(conn, ref(a));
      if (path) onNotice(`${a.name}을(를) 저장했어요: ${path}`);
    } catch (e) {
      setPreview({ name: a.name, state: "error", message: fail(e) });
    }
  };
  return (
    <>
      <table className="argowf-table">
        <thead>
          <tr>
            <th>이름</th>
            <th>방향</th>
            <th>저장소</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {artifacts.map((a) => (
            <tr key={`${a.direction}/${a.name}`}>
              <td>{a.name}</td>
              <td>{a.direction === "input" ? "입력" : "출력"}</td>
              <td className="mono">{[a.repository, a.key].filter(Boolean).join(" · ") || "—"}</td>
              <td>
                <button className="btn small tone-secondary" aria-label={`${a.name} 미리보기`} onClick={() => void open(a)}>
                  미리보기
                </button>{" "}
                <button className="btn small tone-secondary" aria-label={`${a.name} 내려받기`} onClick={() => void save(a)}>
                  내려받기
                </button>{" "}
                {a.key && (
                  <button className="btn small tone-secondary" aria-label={`${a.name} 키 복사`} onClick={() => void desktop.copy(a.key!)}>
                    키 복사
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {preview?.state === "loading" && <p>{preview.name} 불러오는 중…</p>}
      {preview?.state === "error" && (
        <p className="err" role="alert">
          {preview.name}: {preview.message}
        </p>
      )}
      {preview?.state === "done" &&
        (preview.preview.imageBase64 ? (
          <img
            className="argowf-artifact-img"
            alt={preview.name}
            src={`data:${preview.preview.contentType ?? "image/png"};base64,${preview.preview.imageBase64}`}
          />
        ) : preview.preview.text !== null ? (
          <pre className="argowf-artifact-text" aria-label={`${preview.name} 내용`}>
            {prettyText(preview.preview.text)}
          </pre>
        ) : (
          <p className="dim">미리 볼 수 없어요(크거나 바이너리). [내려받기]로 저장하세요</p>
        ))}
    </>
  );
}
