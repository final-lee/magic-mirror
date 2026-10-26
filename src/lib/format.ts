import type { ColumnKind } from "../api/types";

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatValue(kind: ColumnKind, raw: string | undefined): string {
  if (!raw) return "";
  if (kind === "bytes") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : formatBytes(n);
  }
  if (kind === "datetime") return formatDate(raw);
  return raw;
}

const GREEN = ["running", "available", "active", "in-use", "enabled", "deployed", "issued", "succeeded"];
const RED = ["stopped", "stopping", "failed", "deleted", "deleting", "error", "inactive", "disabled", "terminated", "shutting-down"];
const YELLOW = ["pending", "creating", "updating", "modifying", "provisioning", "inprogress", "in progress", "backing-up", "draining"];

export function stateColor(state: string): "green" | "red" | "yellow" | "gray" {
  const s = state.toLowerCase();
  if (GREEN.includes(s)) return "green";
  if (RED.includes(s)) return "red";
  if (YELLOW.includes(s)) return "yellow";
  return "gray";
}

export function compareValues(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a !== "" && b !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b, "ko", { sensitivity: "base" });
}
