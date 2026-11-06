import { invoke } from "../../api/invoke";
import type { Item, ItemPage, ReadRequest } from "./types";
export const itemsApi = {
 read: (profile: string, region: string, table: string, req: ReadRequest) => invoke<ItemPage>("dynamo_read", { profile, region, table, req }),
 exportPath: (name: string) => invoke<string | null>("dynamo_export_path", { name }),
 export: (path: string, items: Item[], format: string) => invoke<void>("dynamo_export", { path, items, format }),
};
