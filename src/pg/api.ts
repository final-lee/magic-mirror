import { invoke } from "../api/invoke";
import type {
  PgCellDetail,
  PgDatabaseView,
  PgFindings,
  PgObjectRef,
  PgOverview,
  PgRoleView,
  PgSession,
  PgTarget,
  PgTargetInfo,
  PgWhoCan,
} from "./types";

// 명령 이름과 인자 이름은 설계 문서의 "계약"과 같아야 한다(Tauri가 camelCase 인자를 snake_case로 바꿔 준다).
// 모든 명령은 target을 객체 하나로 받는다. invoke가 SSO 만료를 알릴 때 그 안의 profile을 읽으므로(src/api/invoke.ts) 풀어서 넘기지 않는다.
export const pgApi = {
  /** RDS API로 대상을 확인한다. DB에는 연결하지 않는다. */
  target: (target: PgTarget) => invoke<PgTargetInfo>("pg_target", { target }),
  /** 연결하고 클러스터 전체 스냅숏을 새로 읽는다. 로그인 사용자는 이 대상에 대해 백엔드가 기억한다. */
  open: (target: PgTarget, loginUser: string) => invoke<PgOverview>("pg_open", { target, loginUser }),
  database: (target: PgTarget, database: string, force: boolean) => invoke<PgDatabaseView>("pg_database", { target, database, force }),
  cell: (target: PgTarget, database: string, role: string, schema: string) =>
    invoke<PgCellDetail>("pg_cell", { target, database, role, schema }),
  objects: (target: PgTarget, database: string, query: string) => invoke<PgObjectRef[]>("pg_objects", { target, database, query }),
  role: (target: PgTarget, role: string) => invoke<PgRoleView>("pg_role", { target, role }),
  whoCan: (target: PgTarget, database: string, object: PgObjectRef, privilege: string) =>
    invoke<PgWhoCan>("pg_who_can", { target, database, object, privilege }),
  sessions: (target: PgTarget) => invoke<PgSession[]>("pg_sessions", { target }),
  findings: (target: PgTarget, force: boolean) => invoke<PgFindings>("pg_findings", { target, force }),
  /** 이 대상의 연결을 모두 닫고 캐시와 기억해 둔 로그인을 버린다. 탭을 닫을 때 부른다. */
  close: (target: PgTarget) => invoke<null>("pg_close", { target }),
};
