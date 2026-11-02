import { invoke } from "../api/invoke";
import type { CostBreakdown, CostOverview, CostQuery, CostUsage } from "./types";

// 명령 이름과 인자 이름은 설계 문서의 "계약"과 같아야 한다. 모두 읽기 전용이다.
export const costApi = {
  overview: (profile: string, query: CostQuery, refresh: boolean) => invoke<CostOverview>("cost_overview", { profile, query, refresh }),
  breakdown: (profile: string, query: CostQuery, refresh: boolean) => invoke<CostBreakdown>("cost_breakdown", { profile, query, refresh }),
  tagKeys: (profile: string, refresh: boolean) => invoke<string[]>("cost_tag_keys", { profile, refresh }),
  usage: (profile: string) => invoke<CostUsage>("cost_usage", { profile }),
};
