import { invoke } from "@tauri-apps/api/core";
import type { VpcTopology } from "./types";

export const vpcApi = {
  topology: (profile: string, region: string, vpcId: string) =>
    invoke<VpcTopology>("vpc_topology", { profile, region, vpcId }),
  /** 저장 대화상자는 Rust에서 띄운다. 저장하면 true, 취소하면 false. */
  savePng: (defaultName: string, bytes: Uint8Array) =>
    invoke<boolean>("save_png", { defaultName, data: Array.from(bytes) }),
};
