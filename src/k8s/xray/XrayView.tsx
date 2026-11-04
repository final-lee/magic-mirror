import { errorMessage } from "../../api/errors";
import { createPortal } from "react-dom";
import { ErrorState } from "../../components/ErrorState";
import { Problems } from "../columns";
import { resolveLink } from "../kinds";
import type { K8sKind, K8sTarget, ObjectRef } from "../types";
import { useK8sXray } from "./queries";
import {
  EDGE_HINTS, EDGE_LABELS, ROLE_LABELS, XRAY_CURRENT, XRAY_EMPTY, XRAY_LABEL, XRAY_LOADING, XRAY_MISSING, XRAY_MISSING_TITLE, XRAY_REFRESH, XRAY_TRUNCATED,
  xrayGap, xrayOpen, xrayPartial,
} from "./text";
import type { XrayEdge, XrayNode } from "./types";

interface Props {
  target: K8sTarget;
  context: string | null;
  ssoProfile: string;
  live: boolean;
  objectRef: ObjectRef;
  /** 목록에 있는 객체면 그 resourceVersion(바뀌면 다시 읽는다), 아니면 null */
  resourceVersion: string | null;
  kinds: K8sKind[];
  /** 노드의 객체를 상세로 연다(소유자·자식 링크와 같은 길) */
  onOpen: (ref: ObjectRef) => void;
  toolbar: HTMLElement | null;
}

function Row({ node, parent, kinds, onOpen }: { node: XrayNode; parent: XrayEdge; kinds: K8sKind[]; onOpen: (ref: ObjectRef) => void }) {
  const kind = resolveLink(node, kinds);
  const openable = !node.current && node.presence !== "missing" && kind !== null;
  return (
    <span className="xray-row">
      <span className="xray-kind">{node.kind}</span>
      {openable ? (
        <button
          className="link mono"
          aria-label={xrayOpen(node.kind, node.name)}
          title={xrayOpen(node.kind, node.name)}
          onClick={() => onOpen({ kind, namespace: kind.namespaced ? node.namespace : null, name: node.name })}
        >
          {node.name}
        </button>
      ) : (
        <span className={`mono${node.current ? " xray-current" : ""}`} aria-current={node.current ? "true" : undefined}>
          {node.name}
        </span>
      )}
      {node.current && <span className="xray-badge current">{XRAY_CURRENT}</span>}
      {node.edge !== parent && <span className={`xray-badge edge-${node.edge}`}>{EDGE_LABELS[node.edge]}</span>}
      {node.roles.map((role) => (
        <span key={role} className="xray-badge role">
          {ROLE_LABELS[role] ?? role}
        </span>
      ))}
      {node.presence === "missing" && (
        <span className="xray-badge missing" title={XRAY_MISSING_TITLE}>
          {XRAY_MISSING}
        </span>
      )}
      {node.status && <span className="xray-status">{node.status}</span>}
      <Problems problems={node.problems} />
    </span>
  );
}

function Tree({ nodes, parent, kinds, onOpen }: { nodes: XrayNode[]; parent: XrayEdge; kinds: K8sKind[]; onOpen: (ref: ObjectRef) => void }) {
  return (
    <ul className="xray-tree">
      {nodes.map((node, i) => (
        <li key={`${node.group}/${node.kind}/${node.namespace}/${node.name}/${i}`}>
          <Row node={node} parent={parent} kinds={kinds} onOpen={onOpen} />
          {node.children.length > 0 && <Tree nodes={node.children} parent={node.edge} kinds={kinds} onOpen={onOpen} />}
        </li>
      ))}
    </ul>
  );
}

/** 관계 탭: 소유·참조·선택·대상으로 묶은 들여쓰기 트리. 노드를 누르면 그 객체의 상세로 간다 */
export function XrayView({ target, context, ssoProfile, live, objectRef, resourceVersion, kinds, onOpen, toolbar }: Props) {
  const q = useK8sXray(target, context, objectRef, resourceVersion, ssoProfile, live);
  const refresh = toolbar && createPortal(<button className="btn tone-secondary" onClick={() => void q.refetch()} disabled={q.isFetching}>{XRAY_REFRESH}</button>, toolbar);
  if (q.isError) {
    return <>{refresh}<ErrorState error={q.error} profile={ssoProfile} compact onRetry={() => void q.refetch()} onLoggedIn={() => void q.refetch()} /></>;
  }
  if (!q.data) {
    return <>{refresh}<div className="empty">{XRAY_LOADING}</div></>;
  }
  const x = q.data;
  return (
    <div className="xray" aria-label={XRAY_LABEL}>
      {refresh}
      {x.gaps.map((g) => (
        <p key={g.kind} role="status" className="dim">
          {xrayGap(g.kind, errorMessage(g.error))}
        </p>
      ))}
      {x.partial.length > 0 && (
        <p role="status" className="dim">
          {xrayPartial(x.partial)}
        </p>
      )}
      {x.truncated && (
        <p role="status" className="dim">
          {XRAY_TRUNCATED}
        </p>
      )}
      {x.sections.length === 0 && <div className="empty">{XRAY_EMPTY}</div>}
      {x.sections.map((s) => (
        <section key={s.edge} className="k8s-sect" aria-label={EDGE_LABELS[s.edge]}>
          <h4 title={EDGE_HINTS[s.edge]}>
            {EDGE_LABELS[s.edge]} <span className="xray-hint">{EDGE_HINTS[s.edge]}</span>
          </h4>
          <Tree nodes={s.nodes} parent={s.edge} kinds={kinds} onOpen={onOpen} />
        </section>
      ))}
    </div>
  );
}
