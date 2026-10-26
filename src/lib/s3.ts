import type { Column, Resource, S3Entry } from "../api/types";

export interface S3Location {
  bucket: string;
  region: string;
  prefix: string;
}

export const S3_COLUMNS: Column[] = [
  { key: "name", label: "Name", kind: "text" },
  { key: "size", label: "Size", kind: "bytes" },
  { key: "kind", label: "Kind", kind: "text" },
  { key: "lastModified", label: "Last modified", kind: "datetime" },
];

export function prefixSegments(prefix: string): { label: string; prefix: string }[] {
  const parts = prefix.split("/").filter(Boolean);
  return parts.map((label, i) => ({ label, prefix: parts.slice(0, i + 1).join("/") + "/" }));
}

export function s3EntryToRow(e: S3Entry): Resource {
  return {
    id: e.key,
    name: e.name,
    arn: null,
    values: {
      name: `${e.isFolder ? "📁" : "📄"} ${e.name}`,
      size: e.size !== null ? String(e.size) : "",
      kind: e.isFolder ? "Folder" : "Object",
      lastModified: e.lastModified ?? "",
    },
    tags: {},
    fields: [],
    raw: "",
    consoleUrl: null,
  };
}
