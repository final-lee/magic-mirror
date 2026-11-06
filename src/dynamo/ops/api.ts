import { invoke } from "../../api/invoke";
import type { Target } from "../change/types";
import type { Backup, Export } from "./types";
export const opsApi = {
  backups: (target: Target) => invoke<Backup[]>("dynamo_backups", { ...target }),
  exports: (target: Target, tableArn: string) => invoke<Export[]>("dynamo_exports", { profile: target.profile, region: target.region, tableArn }),
  buckets: (target: Target) => invoke<string[]>("dynamo_buckets", { profile: target.profile, region: target.region }),
};
