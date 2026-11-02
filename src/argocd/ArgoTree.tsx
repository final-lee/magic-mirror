import { ArgoBadge } from "./argoParts";
import { ARGO_HEALTH_BADGE_TITLE, ARGO_HOOK, ARGO_NO_RESOURCES, ARGO_PRUNING, ARGO_SYNC_BADGE_TITLE, ARGO_TREE_LABEL } from "./text";
import type { ArgoResource, ArgoTreeNode } from "./types";

/** 트리 한 줄: 들여쓴 깊이와 보여 줄 값 */
export interface TreeRow {
  key: string;
  depth: number;
  kind: string;
  name: string;
  namespace: string | null;
  health: string | null;
  healthMessage: string | null;
  info: string[];
  /** Application.status.resources에서 붙인 Sync 상태 */
  sync: string | null;
  hook: boolean;
  requiresPruning: boolean;
}

const resourceKey = (group: string, kind: string, namespace: string | null, name: string) => `${group}/${kind}/${namespace ?? ""}/${name}`;

const byKindThenName = (a: ArgoTreeNode, b: ArgoTreeNode) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);

/**
 * parentRefs로 부모 → 자식 순서의 줄을 만든다(Deployment → ReplicaSet → Pod).
 * 부모가 목록에 없는 노드는 맨 위 줄이고, Sync 상태·hook·삭제 예정은 같은 group/kind/namespace/name의 app.resources에서 붙인다.
 * 트리에 없는 resources 항목(아직 만들어지지 않은 것)은 맨 끝에 Sync 상태만 달고 붙는다.
 */
export function buildTreeRows(nodes: ArgoTreeNode[], resources: ArgoResource[]): TreeRow[] {
  const known = new Set(nodes.map((n) => n.uid));
  const children = new Map<string, ArgoTreeNode[]>();
  const roots: ArgoTreeNode[] = [];
  for (const node of nodes) {
    const parent = node.parents.find((uid) => uid !== node.uid && known.has(uid));
    if (parent === undefined) {
      roots.push(node);
      continue;
    }
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }

  const resourceOf = new Map<string, ArgoResource>();
  for (const r of resources) resourceOf.set(resourceKey(r.group, r.kind, r.namespace, r.name), r);

  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  const attached = new Set<string>();
  const walk = (node: ArgoTreeNode, depth: number) => {
    if (seen.has(node.uid)) return;
    seen.add(node.uid);
    const key = resourceKey(node.group, node.kind, node.namespace, node.name);
    attached.add(key);
    const r = resourceOf.get(key);
    rows.push({
      key: node.uid,
      depth,
      kind: node.kind,
      name: node.name,
      namespace: node.namespace,
      health: node.health,
      healthMessage: node.healthMessage,
      info: node.info,
      sync: r?.status ?? null,
      hook: r?.hook ?? false,
      requiresPruning: r?.requiresPruning ?? false,
    });
    for (const child of [...(children.get(node.uid) ?? [])].sort(byKindThenName)) walk(child, depth + 1);
  };
  for (const node of [...roots].sort(byKindThenName)) walk(node, 0);
  // 서로를 부모로 가리키는 고리는 맨 위 줄이 없어 위에서 못 닿는다. 그래도 빠뜨리지 않는다.
  for (const node of nodes) walk(node, 0);

  for (const r of resources) {
    const key = resourceKey(r.group, r.kind, r.namespace, r.name);
    if (attached.has(key)) continue;
    attached.add(key);
    rows.push({
      key: `resource:${key}`,
      depth: 0,
      kind: r.kind,
      name: r.name,
      namespace: r.namespace,
      health: null,
      healthMessage: null,
      info: [],
      sync: r.status,
      hook: r.hook,
      requiresPruning: r.requiresPruning,
    });
  }
  return rows;
}

/** 리소스 트리: 부모 → 자식으로 들여 쓰고, 노드의 Health와 Application의 Sync 상태를 함께 보인다. */
export function ArgoTree({ nodes, resources }: { nodes: ArgoTreeNode[]; resources: ArgoResource[] }) {
  const rows = buildTreeRows(nodes, resources);
  if (rows.length === 0) return <p className="dim">{ARGO_NO_RESOURCES}</p>;
  return (
    <div className="argo-tree" role="tree" aria-label={ARGO_TREE_LABEL}>
      {rows.map((row) => (
        <div key={row.key} className="argo-node" role="treeitem" aria-level={row.depth + 1} aria-selected={false} style={{ paddingLeft: `${row.depth * 20}px` }}>
          <div className="argo-node-head">
            <span className="dim">{row.kind}</span>
            <span className="mono k8s-wrap">{row.name}</span>
            {row.namespace && <span className="dim">{row.namespace}</span>}
            <ArgoBadge status={row.health} title={ARGO_HEALTH_BADGE_TITLE} />
            <ArgoBadge status={row.sync} title={ARGO_SYNC_BADGE_TITLE} />
            {row.hook && <span className="k8s-chip">{ARGO_HOOK}</span>}
            {row.requiresPruning && <span className="k8s-chip argo-chip-warn">{ARGO_PRUNING}</span>}
          </div>
          {row.healthMessage && <div className="argo-pre dim">{row.healthMessage}</div>}
          {row.info.map((line, i) => (
            <div key={i} className="dim argo-pre">
              {line}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
