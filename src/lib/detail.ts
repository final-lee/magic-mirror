import type { Field, Resource, ResourceType, S3Entry, ServiceInfo } from "../api/types";
import { formatBytes, formatDate, formatValue } from "./format";

export interface DetailData {
  title: string;
  subtitle: string;
  rows: Field[];
  tags: Record<string, string>;
  copy: { label: string; value: string } | null;
  consoleUrl: string | null;
  raw: string | null;
}

export function resourceDetail(resource: Resource, type: ResourceType, service: ServiceInfo): DetailData {
  const columnRows = type.columns
    .filter((c) => c.key !== "name")
    .map((c) => ({ label: c.label, value: formatValue(c.kind, resource.values[c.key]) }))
    .filter((r) => r.value !== "");
  return {
    title: resource.name,
    subtitle: `${service.name} · ${type.name}`,
    rows: [...columnRows, ...resource.fields],
    tags: resource.tags,
    copy: resource.arn ? { label: "ARN", value: resource.arn } : { label: "ID", value: resource.id },
    consoleUrl: resource.consoleUrl,
    raw: resource.raw || null,
  };
}

export function s3EntryDetail(entry: S3Entry, bucket: string, region: string): DetailData {
  const rows: Field[] = [{ label: "Key", value: entry.key }];
  if (entry.size !== null) rows.push({ label: "Size", value: formatBytes(entry.size) });
  if (entry.storageClass) rows.push({ label: "Storage", value: entry.storageClass });
  if (entry.lastModified) rows.push({ label: "Modified", value: formatDate(entry.lastModified) });
  const prefix = encodeURIComponent(entry.key);
  return {
    title: entry.name,
    subtitle: entry.isFolder ? "S3 Folder" : "S3 Object",
    rows,
    tags: {},
    copy: { label: "S3 URI", value: `s3://${bucket}/${entry.key}` },
    consoleUrl: entry.isFolder
      ? `https://s3.console.aws.amazon.com/s3/buckets/${bucket}?region=${region}&prefix=${prefix}`
      : `https://s3.console.aws.amazon.com/s3/object/${bucket}?region=${region}&prefix=${prefix}`,
    raw: null,
  };
}
