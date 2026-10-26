import type { AppError } from "../api/types";
export type { S3Location } from "../lib/s3";

export type FileRef = { source: "local"; path: string } | { source: "s3"; bucket: string; region: string; key: string };

export interface LocalEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  modified: string | null;
}

export type Direction = "upload" | "download";

export interface TransferRequest {
  id: string;
  direction: Direction;
  localPath: string;
  bucket: string;
  region: string;
  key: string;
}

export type TransferStatus = "queued" | "running" | "done" | "failed";

export interface TransferEvent {
  id: string;
  status: TransferStatus;
  transferred: number;
  total: number | null;
  error: AppError | null;
}

export type RenameResult = { kind: "done" } | { kind: "conflict"; target: string };

export interface Segment {
  text: string;
  emph: boolean;
}

export interface DiffLine {
  no: number;
  segments: Segment[];
}

export type RowKind = "equal" | "insert" | "delete" | "replace" | "collapsed";

export interface DiffRow {
  kind: RowKind;
  left: DiffLine | null;
  right: DiffLine | null;
  hiddenRows: DiffRow[];
}

export interface DiffStats {
  added: number;
  removed: number;
  changed: number;
}

export interface SideMeta {
  label: string;
  size: number;
  modified: string | null;
  md5: string | null;
}

export interface DiffResult {
  left: SideMeta;
  right: SideMeta;
  mode: "text" | "meta";
  rows: DiffRow[];
  hunks: number[];
  stats: DiffStats;
  metaVerdict: "same" | "different" | "unknown" | null;
  reason: "binary" | "tooLarge" | null;
  eolOnly: boolean;
}

export type DiffTool = "filemerge" | "vscode" | "custom";
