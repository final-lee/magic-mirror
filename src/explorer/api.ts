import { listen } from "@tauri-apps/api/event";
import { invoke } from "../api/invoke";
import type { DiffResult, FileRef, LocalEntry, RenameResult, TransferEvent, TransferRequest } from "./types";

export const explorerApi = {
  localHome: () => invoke<string>("local_home"),
  localList: (path: string) => invoke<LocalEntry[]>("local_list", { path }),
  planUpload: (localPaths: string[], bucket: string, region: string, prefix: string) =>
    invoke<TransferRequest[]>("plan_upload", { localPaths, bucket, region, prefix }),
  planDownload: (profile: string, bucket: string, region: string, keys: string[], localDir: string) =>
    invoke<TransferRequest[]>("plan_download", { profile, bucket, region, keys, localDir }),
  findConflicts: (profile: string, requests: TransferRequest[]) => invoke<string[]>("find_conflicts", { profile, requests }),
  startTransfers: (profile: string, requests: TransferRequest[]) => invoke<void>("start_transfers", { profile, requests }),
  s3CreateFolder: (profile: string, bucket: string, region: string, prefix: string, name: string) =>
    invoke<void>("s3_create_folder", { profile, bucket, region, prefix, name }),
  s3Rename: (profile: string, bucket: string, region: string, fromKey: string, newName: string, overwrite: boolean) =>
    invoke<RenameResult>("s3_rename", { profile, bucket, region, fromKey, newName, overwrite }),
  s3CountUnder: (profile: string, bucket: string, region: string, keys: string[]) =>
    invoke<number>("s3_count_under", { profile, bucket, region, keys }),
  s3Delete: (profile: string, bucket: string, region: string, keys: string[]) =>
    invoke<number>("s3_delete", { profile, bucket, region, keys }),
  diffFiles: (profile: string, left: FileRef, right: FileRef) => invoke<DiffResult>("diff_files", { profile, left, right }),
  openExternalDiff: (profile: string, left: FileRef, right: FileRef) =>
    invoke<void>("open_external_diff", { profile, left, right }),
};

/** 네이티브(macOS)에서 가로챈 마우스 뒤로/앞으로 버튼 */
export function onMouseNav(cb: (dir: "back" | "forward") => void): Promise<() => void> {
  return listen<"back" | "forward">("mouse-nav", (e) => cb(e.payload));
}

export function onTransferProgress(cb: (ev: TransferEvent) => void): Promise<() => void> {
  return listen<TransferEvent>("transfer-progress", (e) => cb(e.payload));
}
