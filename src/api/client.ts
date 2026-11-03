import { invoke } from "./invoke";
import type { IndexedList, ListResult, ProfileInfo, S3Listing, ServiceInfo, Settings } from "./types";

export const api = {
  listProfiles: () => invoke<ProfileInfo[]>("list_profiles"),
  getAccount: (profile: string) => invoke<string>("get_account", { profile }),
  listServices: () => invoke<ServiceInfo[]>("list_services"),
  listResources: (profile: string, region: string, service: string, typeId: string) =>
    invoke<ListResult>("list_resources", { profile, region, service, typeId }),
  resourceIndex: (profile: string) => invoke<IndexedList[]>("resource_index", { profile }),
  clearResourceIndex: () => invoke<void>("clear_resource_index"),
  listS3Objects: (profile: string, region: string, bucket: string, prefix: string, continuationToken: string | null) =>
    invoke<S3Listing>("list_s3_objects", { profile, region, bucket, prefix, continuationToken }),
  ssoLogin: (profile: string) => invoke<void>("sso_login", { profile }),
  ssoLoginCancel: (profile: string) => invoke<void>("sso_login_cancel", { profile }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
};
