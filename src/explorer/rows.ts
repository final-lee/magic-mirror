import type { Resource } from "../api/types";
import type { FileRef, LocalEntry } from "./types";

export function localEntryToRow(e: LocalEntry): Resource {
  return {
    id: e.path,
    name: e.name,
    arn: null,
    values: {
      name: `${e.isDir ? "📁" : "📄"} ${e.name}`,
      size: e.size !== null ? String(e.size) : "",
      kind: e.isDir ? "Folder" : "File",
      lastModified: e.modified ?? "",
    },
    tags: {},
    fields: [],
    raw: "",
    consoleUrl: null,
  };
}

export function refKey(r: FileRef): string {
  return r.source === "local" ? `local:${r.path}` : `s3:${r.bucket}/${r.key}`;
}

export function refName(r: FileRef): string {
  const full = r.source === "local" ? r.path : r.key;
  return full.split("/").filter(Boolean).pop() ?? full;
}

export function refLabel(r: FileRef): string {
  return r.source === "local" ? r.path : `s3://${r.bucket}/${r.key}`;
}

export function parentPrefix(key: string): string {
  const trimmed = key.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? "" : key.slice(0, i + 1);
}
