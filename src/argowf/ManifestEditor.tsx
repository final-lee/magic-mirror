import { useEffect, useRef, useState } from "react";
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
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (mode !== "edit" || !name) return;
    let active = true;
    setBusy(true);
    argowfApi
      .manifest(conn, kind, namespace, name)
      .then((value) => {
        if (active) {
          setYaml(value);
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
                  if (e.target.value) setYaml(workflowExamples[e.target.value]);
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
        {/* 줄 번호와 글이 함께 스크롤되게 textarea는 줄 수만큼 키우고 바깥 상자가 스크롤한다 */}
        <div className="awc-manifest-editor">
          <pre aria-hidden="true" className="awc-editor-lines">
            {yaml
              .split("\n")
              .map((_, i) => i + 1)
              .join("\n")}
          </pre>
          <textarea
            ref={textarea}
            aria-label="YAML"
            className="mono awc-editor-text"
            spellCheck={false}
            rows={yaml.split("\n").length}
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Tab") return;
              e.preventDefault();
              const { selectionStart, selectionEnd } = e.currentTarget;
              setYaml(yaml.slice(0, selectionStart) + "  " + yaml.slice(selectionEnd));
              requestAnimationFrame(() => textarea.current?.setSelectionRange(selectionStart + 2, selectionStart + 2));
            }}
          />
        </div>
        {message && <p role="status">{message}</p>}
        <div className="foot">
          <button className="btn plain" onClick={close}>
            닫기
          </button>
          <button className="btn plain" disabled={busy || !loaded} onClick={() => void run(true)}>
            검사
          </button>
          <button className="btn primary" disabled={busy || !loaded} onClick={() => void run(false)}>
            {mode === "edit" ? "저장" : "만들기"}
          </button>
        </div>
      </div>
    </div>
  );
}
