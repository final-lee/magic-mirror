import { useState, type FormEvent } from "react";
import { SERVER_KUBE_CONTEXT, SERVER_KUBE_CONTEXT_NONE, serverKubeContextLabel } from "./ops/text";
import type { KubeContext } from "./ops/types";
import { normalizeUrl } from "./servers";
import { SERVER_ADD, SERVER_DUPLICATE, SERVER_INVALID, SERVER_NAME, SERVER_NAME_PLACEHOLDER, SERVER_REMOVE, SERVER_URL, SERVER_URL_PLACEHOLDER, serverRemoveLabel } from "./text";
import type { ArgocdServer } from "./types";

interface FormProps {
  /** 이미 있는 서버(같은 주소는 다시 넣지 못한다) */
  servers: ArgocdServer[];
  onAdd: (server: ArgocdServer) => void;
  /** 제출 버튼 글(처음 연결할 때는 "다음") */
  submitLabel?: string;
}

/** 서버 하나 넣기: 주소는 http(s)://, 이름은 비우면 주소의 호스트를 쓴다. */
export function ArgoServerForm({ servers, onAdd, submitLabel = SERVER_ADD }: FormProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const add = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeUrl(url);
    const host = /^https?:\/\/([^\s/]+)/i.exec(normalized)?.[1];
    if (!host) {
      setProblem(SERVER_INVALID);
      return;
    }
    if (servers.some((s) => s.url === normalized)) {
      setProblem(SERVER_DUPLICATE);
      return;
    }
    onAdd({ name: name.trim() || host, url: normalized });
    setName("");
    setUrl("");
    setProblem(null);
  };

  return (
    <>
      <form className="argo-server-add" onSubmit={add}>
        <input aria-label={SERVER_URL} placeholder={SERVER_URL_PLACEHOLDER} value={url} onChange={(e) => setUrl(e.target.value)} />
        <input aria-label={SERVER_NAME} placeholder={SERVER_NAME_PLACEHOLDER} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn small tone-primary" type="submit">
          {submitLabel}
        </button>
      </form>
      {problem && (
        <p className="err" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}

interface Props {
  servers: ArgocdServer[];
  onAdd: (server: ArgocdServer) => void;
  onRemove: (url: string) => void;
  /** ArgoCD가 자기 클러스터(in-cluster)에 배포할 때 터미널이 붙을 kubeconfig context의 후보. 주면 서버마다 고르는 칸이 생긴다 */
  kubeContexts?: KubeContext[];
  onKubeContext?: (url: string, context: string | null) => void;
}

/** 서버 목록 편집: 줄마다 삭제(와 in-cluster context 고르기), 아래에서 추가한다. */
export function ArgoServerEditor({ servers, onAdd, onRemove, kubeContexts, onKubeContext }: Props) {
  return (
    <div className="argo-servers">
      <ul className="argo-server-list">
        {servers.map((s) => (
          <li key={s.url}>
            <b>{s.name}</b> <span className="dim mono">{s.url}</span>
            {onKubeContext && (
              <label className="k8s-field">
                {SERVER_KUBE_CONTEXT}
                <select aria-label={serverKubeContextLabel(s.name)} value={s.kubeContext ?? ""} onChange={(e) => onKubeContext(s.url, e.target.value || null)}>
                  <option value="">{SERVER_KUBE_CONTEXT_NONE}</option>
                  {s.kubeContext && !kubeContexts?.some((c) => c.name === s.kubeContext) && <option value={s.kubeContext}>{s.kubeContext}</option>}
                  {kubeContexts?.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button className="btn small tone-danger" aria-label={serverRemoveLabel(s.name)} onClick={() => onRemove(s.url)}>
              {SERVER_REMOVE}
            </button>
          </li>
        ))}
      </ul>
      <ArgoServerForm servers={servers} onAdd={onAdd} />
    </div>
  );
}
