import { useEffect, useState } from "react";
import { CodeEditor } from "../components/CodeEditor";
import { errorMessage } from "../api/errors";
import { argowfApi } from "./api";
import { workflowExamples } from "./examples";
import type { ArgoWfConn, ManifestKind } from "./types";

interface Props {
  conn: ArgoWfConn;
  kind: ManifestKind;
  mode: "create" | "edit" | "resubmit";
  namespace: string | null;
  name?: string;
  initialYaml?: string;
  onClose(): void;
  onSaved(result: { namespace: string | null; name: string }): void;
}

export function ManifestEditor({ conn, kind, mode, namespace, name, initialYaml, onClose, onSaved }: Props) {
  const [yaml, setYaml] = useState(initialYaml ?? "");
  const [original, setOriginal] = useState(initialYaml ?? "");
  const [ns, setNs] = useState(namespace ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(mode !== "edit");
  // 편집기는 처음 값만 받는다: 불러오기·예제처럼 글을 통째로 갈아 끼울 때는 key를 바꿔 다시 만든다
  const [revision, setRevision] = useState(0);
  const replace = (text: string) => {
    setYaml(text);
    setRevision((r) => r + 1);
  };
  useEffect(() => {
    if (mode !== "edit" || !name) return;
    let active = true;
    setBusy(true);
    argowfApi
      .manifest(conn, kind, namespace, name)
      .then((value) => {
        if (active) {
          replace(value);
          setOriginal(value);
          setLoaded(true);
        }
      })
      .catch((error) => {
        if (active) setMessage(errorMessage(error));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [conn.url, conn.context, conn.ssoProfile, kind, mode, namespace, name]);
  const targetNamespace = kind === "ClusterWorkflowTemplate" ? null : ns.trim() || null;
  const dirty = yaml !== original || ns !== (namespace ?? "");
  const close = () => {
    if (!dirty || window.confirm("저장하지 않은 변경을 버릴까요?")) onClose();
  };
  const run = async (lint: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      if (lint) {
        const result = await argowfApi.lint(conn, kind, targetNamespace, yaml);
        setMessage(result.ok ? "검사를 통과했어요" : (result.message ?? "검사에 실패했어요"));
      } else if (mode === "edit" && name) {
        await argowfApi.update(conn, kind, targetNamespace, name, yaml);
        onSaved({ namespace: targetNamespace, name });
      } else if (mode === "resubmit") {
        onSaved(await argowfApi.create(conn, "Workflow", targetNamespace, yaml, true));
      } else {
        onSaved(await argowfApi.create(conn, kind, targetNamespace, yaml));
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal">
      <div className="sheet wide" role="dialog" aria-modal="true" aria-label={`${kind} YAML 편집`}>
        <h3>
          {kind} {mode === "edit" ? "고치기" : "만들기"}
          {dirty && " *"}
        </h3>
        <div className="awc-editor-opts">
          {kind !== "ClusterWorkflowTemplate" && (
            <label>
              네임스페이스 <input value={ns} disabled={mode === "edit"} onChange={(e) => setNs(e.target.value)} />
            </label>
          )}
          {kind === "Workflow" && mode === "create" && (
            <label>
              예제
              <select
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) replace(workflowExamples[e.target.value]);
                }}
              >
                <option value="">직접 작성</option>
                {Object.keys(workflowExamples).map((key) => (
                  <option key={key}>{key}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        {loaded ? (
          <CodeEditor key={revision} value={yaml} onChange={setYaml} label="YAML" minHeight="420px" />
        ) : (
          <div className="empty small">{busy ? "불러오는 중…" : "YAML을 불러오지 못했어요"}</div>
        )}
        {message && <p role="status">{message}</p>}
        <div className="foot">
          <button className="btn plain tone-ghost" onClick={close}>
            닫기
          </button>
          <button className="btn plain tone-primary" disabled={busy || !loaded} onClick={() => void run(true)}>
            검사
          </button>
          <button className={`btn plain ${mode === "edit" ? "tone-primary" : "tone-create"}`} disabled={busy || !loaded} onClick={() => void run(false)}>
            {mode === "edit" ? "저장" : "만들기"}
          </button>
        </div>
      </div>
    </div>
  );
}
