import { invoke } from "../api/invoke";
import type { DynamoOverview, DynamoTable, TopKeys } from "./types";

// 명령 이름과 인자는 src-tauri/src/dynamo_commands.rs와 같아야 한다(Tauri가 camelCase 인자를 snake_case로 바꿔 준다).
// profile은 최상위 인자로 넘긴다: invoke가 SSO 만료를 알릴 때 읽는다.
export const dynamoApi = {
  /** 리전의 테이블 목록과 건강 진단. 권한이 없는 부분은 gaps로 온다 */
  overview: (profile: string, region: string) => invoke<DynamoOverview>("dynamo_overview", { profile, region }),
  /** 테이블 하나를 다시 읽는다(진단 포함) */
  table: (profile: string, region: string, table: string) => invoke<DynamoTable>("dynamo_table", { profile, region, table }),
  /** Contributor Insights가 켜진 테이블의 최근 1시간 상위 키 */
  topKeys: (profile: string, region: string, table: string) => invoke<TopKeys>("dynamo_top_keys", { profile, region, table }),
};
