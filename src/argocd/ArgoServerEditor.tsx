import { useState, type FormEvent } from "react";
import { normalizeUrl } from "./servers";
import { SERVER_ADD, SERVER_DUPLICATE, SERVER_INVALID, SERVER_NAME, SERVER_REMOVE, SERVER_URL, SERVER_URL_PLACEHOLDER, serverRemoveLabel } from "./text";
import type { ArgocdServer } from "./types";

interface Props {
  servers: ArgocdServer[];
  /** 추가·삭제로 바뀐 목록(설정에 저장하는 쪽이 받는다) */
  onChange: (servers: ArgocdServer[]) => void;
}

/** 서버 목록 편집: 이름·주소를 넣어 추가하고, 줄마다 삭제한다. */
export function ArgoServerEditor({ servers, onChange }: Props) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const add = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeUrl(url);
    if (name.trim() === "" || !/^https?:\/\/[^\s/]+/i.test(normalized)) {
      setProblem(SERVER_INVALID);
      return;
    }
    if (servers.some((s) => s.url === normalized)) {
      setProblem(SERVER_DUPLICATE);
      return;
    }
    onChange([...servers, { name: name.trim(), url: normalized }]);
    setName("");
    setUrl("");
    setProblem(null);
  };

  return (
    <div className="argo-servers">
      <ul className="argo-server-list">
        {servers.map((s) => (
          <li key={s.url}>
            <b>{s.name}</b> <span className="dim mono">{s.url}</span>
            <button className="btn small" aria-label={serverRemoveLabel(s.name)} onClick={() => onChange(servers.filter((item) => item.url !== s.url))}>
              {SERVER_REMOVE}
            </button>
          </li>
        ))}
      </ul>
      <form className="argo-server-add" onSubmit={add}>
        <input aria-label={SERVER_NAME} placeholder={SERVER_NAME} value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label={SERVER_URL} placeholder={SERVER_URL_PLACEHOLDER} value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="btn small" type="submit">
          {SERVER_ADD}
        </button>
      </form>
      {problem && (
        <p className="err" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
