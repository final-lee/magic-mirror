import { invoke } from "../api/invoke";
import type { TsDiagnosis } from "./types";

export const tailscaleApi = {
  diagnose: (url: string) => invoke<TsDiagnosis>("tailscale_diagnose", { url }),
  acceptRoutes: (enabled: boolean) => invoke<null>("tailscale_accept_routes", { enabled }),
};
