import type { ArgoTreeNode } from "../types";

export interface NetworkVertex { id: string; layer: number; label: string; node?: ArgoTreeNode }
export interface NetworkEdge { from: string; to: string }
export function networkGraph(nodes: ArgoTreeNode[]): { vertices: NetworkVertex[]; edges: NetworkEdge[] } {
  const vertices: NetworkVertex[] = []; const edges: NetworkEdge[] = []; const seen = new Set<string>();
  const relevant = nodes.filter(n => ["Ingress", "Service", "Pod"].includes(n.kind));
  const ids = new Map(relevant.map((n, i) => [n, `node:${n.uid || `${n.group}/${n.kind}/${n.namespace}/${n.name}`}:${i}`]));
  const edge = (from: string, to: string) => { const key = JSON.stringify([from, to]); if (!seen.has(key)) { seen.add(key); edges.push({ from, to }); } };
  for (const node of relevant) {
    const id = ids.get(node)!; const layer = node.kind === "Ingress" ? 1 : node.kind === "Service" ? 2 : 3;
    vertices.push({ id, layer, label: node.name, node });
    const info = node.networkingInfo;
    for (const address of [...(info?.externalURLs ?? []), ...(info?.ingress ?? []).flatMap(i => [i.hostname, i.ip].filter((v): v is string => !!v))]) {
      const external = `external:${address}`;
      if (!vertices.some(v => v.id === external)) vertices.push({ id: external, layer: 0, label: address });
      edge(external, id);
    }
    for (const target of relevant) {
      if (target === node) continue;
      const targetLayer = target.kind === "Ingress" ? 1 : target.kind === "Service" ? 2 : 3;
      if (targetLayer <= layer) continue;
      const refs = info?.targetRefs ?? [];
      const refMatch = refs.some(r => r.uid ? r.uid === target.uid : r.name === target.name && (!r.kind || r.kind === target.kind) && (!r.group || r.group === target.group) && (r.namespace || node.namespace || "") === (target.namespace || ""));
      const selector = Object.entries(info?.targetLabels ?? {});
      const labelMatch = (node.namespace ?? "") === (target.namespace ?? "") && selector.length > 0 && selector.every(([k, v]) => target.networkingInfo?.labels?.[k] === v);
      if (refMatch || labelMatch) edge(id, ids.get(target)!);
    }
  }
  return { vertices, edges };
}
