import type { K8sProblem, ObjectRef } from "../types";
import type { K8sXray, XrayEdge, XrayNode, XrayPresence } from "./types";

/**
 * 관계 지도의 노드. 지금 보는 객체가 0열이고, 이 객체가 가리키는 것(자식, 참조, 고르는 Pod, 대상)은 오른쪽(+),
 * 이 객체를 가리키는 것(소유자, 쓰는 것, 고르는 Service, 대상으로 삼는 것)은 왼쪽(−)이다. 화살표는 늘 왼쪽에서 오른쪽으로 간다.
 */
export interface MapNode {
  id: string;
  group: string;
  kind: string;
  namespace: string | null;
  name: string;
  current: boolean;
  presence: XrayPresence;
  status: string | null;
  problems: K8sProblem[];
  column: number;
  /** 처음 만난 트리 노드(상세로 열 때 쓴다). 지금 보는 객체는 null일 수 있다 */
  source: XrayNode | null;
}

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  edge: XrayEdge;
  roles: string[];
}

export interface RelationMap {
  nodes: MapNode[];
  edges: MapEdge[];
}

/** 대상 묶음이 이 객체에서 바깥으로 나가는 종류(이 객체가 대상을 고른다). 그 밖에서는 대상 묶음이 이 객체를 대상으로 삼는 것이다 */
const TARGETS_OUTWARD: Record<string, true> = { Ingress: true, HorizontalPodAutoscaler: true, EndpointSlice: true };

const keyOf = (n: { group: string; kind: string; namespace: string | null; name: string }) => `${n.group}/${n.kind}/${n.namespace ?? ""}/${n.name}`;

/**
 * 관계 트리(네 묶음)를 하나의 지도로 합친다. 같은 객체는 한 노드이고, 여러 자리에 나오면 지금 보는 객체에서 가장 먼 열에 둔다:
 * 가까운 쪽 간선은 열을 건너뛰어 길어질 뿐이지만, 가까운 열에 두면 먼 쪽 간선이 같은 열이나 거꾸로 돌아간다
 * (Pod를 고르는 Service와 EndpointSlice 너머의 같은 Service, Deployment가 고르는 Pod와 ReplicaSet 아래의 같은 Pod).
 */
export function buildRelationMap(x: K8sXray, root: ObjectRef): RelationMap {
  const nodes = new Map<string, MapNode>();
  const edges = new Map<string, MapEdge>();
  const rootId = keyOf({ group: root.kind.group, kind: root.kind.kind, namespace: root.namespace, name: root.name });
  nodes.set(rootId, {
    id: rootId, group: root.kind.group, kind: root.kind.kind, namespace: root.namespace, name: root.name,
    current: true, presence: "found", status: null, problems: [], column: 0, source: null,
  });

  const place = (n: XrayNode, column: number): string => {
    const id = n.current ? rootId : keyOf(n);
    const seen = nodes.get(id);
    if (!seen) {
      nodes.set(id, { id, group: n.group, kind: n.kind, namespace: n.namespace, name: n.name, current: n.current, presence: n.presence, status: n.status, problems: n.problems, column, source: n });
    } else {
      // 지금 보는 객체는 트리에서 상태를 얻는다
      if (n.current && seen.source === null) Object.assign(seen, { status: n.status, problems: n.problems, source: n });
      if (!seen.current && Math.abs(column) > Math.abs(seen.column)) seen.column = column;
    }
    return id;
  };
  const link = (from: string, to: string, edge: XrayEdge, roles: string[]) => {
    const id = `${from}->${to}`;
    const seen = edges.get(id);
    const shown = roles.filter((r) => r !== "usedBy");
    if (seen) seen.roles = [...new Set([...seen.roles, ...shown])];
    else edges.set(id, { id, from, to, edge, roles: shown });
  };
  /** 바깥쪽 가지: 부모(안쪽) → 자식(바깥쪽). side는 +1(오른쪽) 또는 −1(왼쪽) */
  const branch = (parent: string, n: XrayNode, column: number, side: 1 | -1, edge: XrayEdge) => {
    const id = place(n, column);
    if (side === 1) link(parent, id, edge, n.roles);
    else link(id, parent, edge, n.roles);
    for (const child of n.children) branch(id, child, column + side, side, child.edge);
  };
  /** 소유 묶음: 맨 위 소유자 → … → 이 객체 → 자식. 이 객체가 든 갈래가 아니면 이 객체의 다른 소유자다 */
  const owners = (top: XrayNode) => {
    const path: XrayNode[] = [];
    const find = (n: XrayNode): boolean => {
      path.push(n);
      if (n.current || n.children.some(find)) return true;
      path.pop();
      return false;
    };
    if (!find(top)) {
      link(place(top, -1), rootId, "owner", top.roles);
      return;
    }
    const at = path.length - 1;
    const ids = path.map((n, i) => place(n, i - at));
    for (let i = 1; i < ids.length; i++) link(ids[i - 1], ids[i], "owner", path[i].roles);
    for (const child of path[at].children) branch(rootId, child, 1, 1, child.edge);
  };

  const targetSide = TARGETS_OUTWARD[root.kind.kind] ? 1 : -1;
  for (const section of x.sections) {
    for (const top of section.nodes) {
      if (section.edge === "owner") {
        owners(top);
        continue;
      }
      // 쓰는 것(usedBy)과 이 객체를 고르는 Service·PDB·NetworkPolicy는 왼쪽, 가리키는 것과 고르는 Pod는 오른쪽
      const side: 1 | -1 =
        section.edge === "reference" ? (top.roles.includes("usedBy") ? -1 : 1) : section.edge === "selector" ? (top.kind === "Pod" ? 1 : -1) : targetSide;
      branch(rootId, top, side, side, section.edge);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
