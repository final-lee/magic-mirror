import { buildTreeRows, type TreeRow } from "../ArgoTree";
import { rowKey } from "../argoGroup";
import type { ArgoAppRow, ArgoEvent, ArgoHistory, ArgoHistoryEntry, ArgoResource, ArgoTreeNode } from "../types";
import { appForest, timeline, versions, type AppBranch, type TimelineItem, type VersionGroup } from "./model";

type Identity = { namespace: string; name: string };
const same = (a: Identity, b: Identity) => a.namespace === b.namespace && a.name === b.name;

/** Keep paths to this app and all of its descendants, but not unrelated siblings. */
export function appHierarchy(rows: ArgoAppRow[], selected: Identity): AppBranch[] {
  const prune = (branch: AppBranch, below: boolean): AppBranch | null => {
    const selectedHere = same(branch.row, selected);
    const children = branch.children.map(child => prune(child, below || selectedHere)).filter((b): b is AppBranch => b !== null);
    return below || selectedHere || children.length ? { ...branch, children } : null;
  };
  return appForest(rows).map(b => prune(b, false)).filter((b): b is AppBranch => b !== null);
}
export function appSetSiblings(rows: ArgoAppRow[], app: Identity, owner: string | null): ArgoAppRow[] {
  if (!owner) return [];
  return rows.filter(row => row.namespace === app.namespace && row.values.appSet === owner);
}
export function appVersion(rows: ArgoAppRow[], app: Identity, trees: Map<string, ArgoTreeNode[]>, details: Map<string, { images: string[] }>): VersionGroup | undefined {
  return versions(rows, trees, details).find(group => Object.values(group.cells).some(cells => cells?.some(cell => same(cell.row, app))));
}
export function appTimeline(events: ArgoEvent[], app: Identity, history: (ArgoHistory | ArgoHistoryEntry)[], now: number, days: number): TimelineItem[] {
  return timeline(events.filter(e => e.namespace === app.namespace && e.app === app.name), new Map([[rowKey(app.namespace, app.name), history]]), now, days);
}

export interface ResourceVertex { row: TreeRow; layer: number }
export interface ResourceGraph { vertices: ResourceVertex[]; edges: { from: string; to: string }[] }
export function resourceGraph(nodes: ArgoTreeNode[], resources: ArgoResource[]): ResourceGraph {
  const rows = buildTreeRows(nodes, resources);
  const vertices = rows.map(row => ({ row, layer: row.depth + 1 }));
  const known = new Set(rows.map(row => row.key));
  const edges: { from: string; to: string }[] = [];
  for (const row of rows) {
    const node = nodes.find(n => n.uid === row.uid);
    const parents = node?.parents.filter(uid => uid !== row.key && known.has(uid)) ?? [];
    if (!parents.length || row.depth === 0) edges.push({ from: "app", to: row.key });
    for (const parent of parents) edges.push({ from: parent, to: row.key });
  }
  return { vertices, edges };
}
