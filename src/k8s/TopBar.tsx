import type { K8sIdentity } from "./types";
import {
  YAML_CREATE,
  ALL_NAMESPACES,
  BAR_LABEL,
  IDENTITY_FALLBACK,
  LABEL_CONTEXT,
  LABEL_GROUPS,
  LABEL_IDENTITY,
  LABEL_NAMESPACE,
  RECONNECT,
  STATE_CONNECTED,
  STATE_CONNECTING,
  STATE_DISCONNECTED,
  profileMismatch,
} from "./text";

export type K8sConnection = "connecting" | "connected" | "failed";
const CONNECTION: Record<K8sConnection, { dot: string; label: string }> = {
  connecting: { dot: "yellow", label: STATE_CONNECTING },
  connected: { dot: "green", label: STATE_CONNECTED },
  failed: { dot: "red", label: STATE_DISCONNECTED },
};

/** 네임스페이스 선택 값: 모든 네임스페이스는 빈 문자열 */
export const ALL = "";
const MAX_GROUPS = 4;

interface Props {
  context: string;
  identity: K8sIdentity | null;
  connection: K8sConnection;
  /** kubeconfig가 접속에 쓰는 프로필과 앱에서 고른 프로필. 다르면 안내한다. */
  execProfile: string | null;
  profile: string;
  namespaces: string[];
  /** 고른 네임스페이스. 모든 네임스페이스는 ALL */
  namespace: string;
  onNamespace: (ns: string) => void;
  onReconnect: () => void;
  /** 'YAML로 만들기'를 연다. 주지 않으면 버튼을 그리지 않는다 */
  onCreateYaml?: () => void;
}

export function TopBar({ context, identity, connection, execProfile, profile, namespaces, namespace, onNamespace, onReconnect, onCreateYaml }: Props) {
  const shown = identity?.groups.slice(0, MAX_GROUPS) ?? [];
  const more = (identity?.groups.length ?? 0) - shown.length;
  const options = namespace !== ALL && !namespaces.includes(namespace) ? [namespace, ...namespaces] : namespaces;
  const mismatch = execProfile !== null && execProfile !== profile;
  return (
    <div className="k8s-top-wrap">
      <div className="pg-top" role="group" aria-label={BAR_LABEL}>
        <span className="k8s-field">
          <span className="dim">{LABEL_CONTEXT}</span>
          <b className="mono">{context}</b>
        </span>
        {identity && (
          <span className="k8s-field" title={identity.groups.join("\n")}>
            <span className="dim">{LABEL_IDENTITY}</span>
            <b>{identity.username}</b>
          </span>
        )}
        {identity && identity.groups.length > 0 && (
          <span className="k8s-field">
            <span className="dim">{LABEL_GROUPS}</span>
            {shown.map((g) => (
              <span key={g} className="k8s-chip">
                {g}
              </span>
            ))}
            {more > 0 && <span className="k8s-chip dim">+{more}</span>}
          </span>
        )}
        <span className="pg-status">
          <span className={`dot ${CONNECTION[connection].dot}`} aria-hidden="true" />
          {CONNECTION[connection].label}
        </span>
        <span className="pg-top-end">
          <label className="k8s-field">
            <span className="dim">{LABEL_NAMESPACE}</span>
            <select value={namespace} onChange={(e) => onNamespace(e.target.value)} disabled={connection !== "connected"}>
              <option value={ALL}>{ALL_NAMESPACES}</option>
              {options.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {onCreateYaml && (
            <button className="btn small tone-primary" disabled={connection !== "connected"} onClick={onCreateYaml}>
              {YAML_CREATE}
            </button>
          )}
          <button className="btn small tone-secondary" onClick={onReconnect}>
            {RECONNECT}
          </button>
        </span>
      </div>
      {(mismatch || identity?.source === "kubeconfig") && (
        <div className="k8s-notes">
          {mismatch && <p className="dim">{profileMismatch(execProfile, profile)}</p>}
          {identity?.source === "kubeconfig" && <p className="dim">{IDENTITY_FALLBACK}</p>}
        </div>
      )}
    </div>
  );
}
