import { ARGO_ENVS, envOf, type ArgoEnv } from "../argoEnv";
import { clusterOf, groupLevel, projectOf, rowKey, tally, type ArgoLevel, type Tally } from "../argoGroup";
import type { ArgoAppRow, ArgoEvent, ArgoHistory, ArgoHistoryEntry, ArgoTreeNode } from "../types";

export type Dimension = "cluster" | "project";
export const dimensionOf = (row: ArgoAppRow, dim: Dimension) => dim === "cluster" ? clusterOf(row) : projectOf(row);
export interface MatrixCell { rows: ArgoAppRow[]; tally: Tally; level: ArgoLevel }
export function matrix(rows: ArgoAppRow[], dim: Dimension) {
  const columns = [...new Set(rows.map(r => dimensionOf(r, dim)))].sort((a, b) => a.localeCompare(b));
  const cells = new Map<string, MatrixCell>();
  for (const row of rows) {
    const key = JSON.stringify([envOf(row).env, dimensionOf(row, dim)]);
    const cell = cells.get(key) ?? { rows: [], tally: tally([]), level: "ok" as ArgoLevel };
    cell.rows.push(row); cell.tally = tally(cell.rows); cell.level = groupLevel(null, cell.tally); cells.set(key, cell);
  }
  return { columns, cells };
}

const ENV_TOKEN = /^(dev(?:elopment)?|stg|stag(?:e|ing)|prd|prod(?:uction)?|ops|demo|preview)\d*$/i;
export function normalizeAppName(name: string): string {
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.filter(t => !ENV_TOKEN.test(t)).join("-") || name.toLowerCase();
}
export interface VersionCell { row: ArgoAppRow; revision: string; target: string; images: string[]; drift: boolean }
export interface VersionGroup { name: string; cells: Partial<Record<ArgoEnv, VersionCell[]>>; drift: boolean }
export function versions(rows: ArgoAppRow[], trees: Map<string, ArgoTreeNode[]>, apps: Map<string, { images: string[] }>): VersionGroup[] {
  const groups = new Map<string, VersionGroup>();
  for (const row of rows) {
    const name = row.values.appSet || normalizeAppName(row.name);
    const key = row.values.appSet ? `set:${row.namespace}/${name}` : `name:${name}`;
    const group = groups.get(key) ?? { name, cells: {}, drift: false };
    const id = rowKey(row.namespace, row.name);
    const images = [...new Set([...(apps.get(id)?.images ?? []), ...(trees.get(id) ?? []).flatMap(n => n.images)])].sort();
    const cell: VersionCell = { row, revision: row.values.revision ?? "", target: row.values.targetRevision ?? "", images, drift: false };
    const env = envOf(row).env; (group.cells[env] ??= []).push(cell); groups.set(key, group);
  }
  for (const group of groups.values()) {
    // dev → stg → prd: compare each environment with the nearest upstream environment that has data.
    let upstream: VersionCell[] | undefined;
    for (const env of ARGO_ENVS) {
      const cells = group.cells[env]; if (!cells?.length) continue;
      if (upstream) for (const cell of cells) {
        cell.drift = upstream.every(other => {
          const left = other.revision || other.target; const right = cell.revision || cell.target;
          const revisionDiffers = !!left && !!right && left !== right;
          const imagesDiffer = other.images.length > 0 && cell.images.length > 0 && JSON.stringify(other.images) !== JSON.stringify(cell.images);
          return revisionDiffers || imagesDiffer;
        });
        group.drift ||= cell.drift;
      }
      upstream = cells;
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface AppBranch { row: ArgoAppRow; children: AppBranch[]; level: ArgoLevel; cycle: boolean }
export function appForest(rows: ArgoAppRow[]): AppBranch[] {
  const byKey = new Map(rows.map(r => [rowKey(r.namespace, r.name), r]));
  const children = new Map<string, ArgoAppRow[]>(); const referenced = new Set<string>();
  for (const row of rows) {
    const found = (row.resources ?? []).filter(r => r.kind === "Application" && r.group === "argoproj.io").map(r => byKey.get(rowKey(r.namespace || row.namespace, r.name))).filter((r): r is ArgoAppRow => !!r);
    children.set(rowKey(row.namespace, row.name), found); for (const child of found) referenced.add(rowKey(child.namespace, child.name));
  }
  const visited = new Set<string>();
  const build = (row: ArgoAppRow, path: Set<string>): AppBranch => {
    const key = rowKey(row.namespace, row.name); const cycle = path.has(key);
    if (cycle) return { row, children: [], level: groupLevel(null, tally([row])), cycle: true };
    visited.add(key); const next = new Set(path); next.add(key);
    const branches = (children.get(key) ?? []).map(child => build(child, next));
    const own = groupLevel(null, tally([row]));
    const level = [own, ...branches.map(b => b.level)].includes("err") ? "err" : [own, ...branches.map(b => b.level)].includes("warn") ? "warn" : "ok";
    return { row, children: branches, level, cycle: false };
  };
  const roots = rows.filter(r => !referenced.has(rowKey(r.namespace, r.name))).map(r => build(r, new Set()));
  for (const row of rows) if (!visited.has(rowKey(row.namespace, row.name))) roots.push(build(row, new Set()));
  return roots;
}

export interface TimelineItem { key: string; app: string; namespace: string; start: number; end: number; failed: boolean; revision: string; initiatedBy: string; message: string }
export function timeline(events: ArgoEvent[], histories: Map<string, (ArgoHistory | ArgoHistoryEntry)[]>, now: number, days: number): TimelineItem[] {
  const start = now - days * 86400000; const items: TimelineItem[] = [];
  const add = (item: TimelineItem) => { if (Number.isFinite(item.end) && item.end >= start && item.start <= now) items.push(item); };
  for (const e of events) if (e.kind === "operation") {
    const end = Date.parse(e.finishedAt || e.at); const begin = Date.parse(e.startedAt || e.finishedAt || e.at);
    add({ key: `event:${e.namespace}/${e.app}:${e.at}`, app: e.app, namespace: e.namespace, start: Number.isFinite(begin) ? begin : end, end, failed: e.phase === "Failed" || e.phase === "Error", revision: e.revision ?? "", initiatedBy: e.initiatedBy ?? "", message: e.message ?? "" });
  }
  for (const [key, entries] of histories) for (const h of entries) {
    const slash = key.indexOf("/"); const namespace = key.slice(0, slash); const app = key.slice(slash + 1);
    const end = Date.parse(h.deployedAt ?? ""); const begin = Date.parse(h.deployStartedAt || h.deployedAt || "");
    const revisions = h.revisions.map(r => typeof r === "string" ? r : r.revision).join(", ");
    if (items.some(i => i.namespace === namespace && i.app === app && Math.abs(i.end - end) < 1000 && !i.failed)) continue;
    add({ key: `history:${key}:${h.id}`, app, namespace, start: Number.isFinite(begin) ? begin : end, end, failed: false, revision: revisions, initiatedBy: h.initiatedBy ?? "", message: "" });
  }
  return items.sort((a, b) => a.start - b.start);
}

