export type ColumnKind = "text" | "mono" | "state" | "datetime" | "bytes";

export interface Column {
  key: string;
  label: string;
  kind: ColumnKind;
}

export interface ResourceType {
  id: string;
  name: string;
  columns: Column[];
}

export interface ServiceInfo {
  id: string;
  name: string;
  global: boolean;
  types: ResourceType[];
}

export interface Field {
  label: string;
  value: string;
}

export interface Resource {
  id: string;
  name: string;
  arn: string | null;
  values: Record<string, string>;
  tags: Record<string, string>;
  fields: Field[];
  raw: string;
  consoleUrl: string | null;
}

export interface ListResult {
  items: Resource[];
  truncated: boolean;
}

export interface ProfileInfo {
  name: string;
  region: string | null;
}

/** 즐겨찾기이자 사이드바 선택 상태 */
export interface Favorite {
  service: string;
  type: string;
}

export interface Settings {
  enabledServices: string[];
  favorites: Favorite[];
  lastProfile: string | null;
  lastRegion: string | null;
}

export interface S3Entry {
  name: string;
  key: string;
  isFolder: boolean;
  size: number | null;
  lastModified: string | null;
  storageClass: string | null;
}

export interface S3Listing {
  entries: S3Entry[];
  nextToken: string | null;
}

export type AppError =
  | { kind: "ssoExpired" }
  | { kind: "accessDenied"; action: string }
  | { kind: "throttled" }
  | { kind: "network"; message: string }
  | { kind: "other"; message: string };
