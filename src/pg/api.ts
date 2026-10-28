import { invoke } from "../api/invoke";
import type {
  PgApplyResult,
  PgBatchPreview,
  PgBatchResult,
  PgCellDetail,
  PgChange,
  PgChangeLogEntry,
  PgDatabaseView,
  PgDropPlan,
  PgDropResult,
  PgFindings,
  PgObjectRef,
  PgOverview,
  PgPresetKind,
  PgPresetSuggestion,
  PgPreview,
  PgRoleView,
  PgSession,
  PgTarget,
  PgTargetInfo,
  PgUndo,
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

  // 2단계: 변경. 모든 변경은 미리보기 → 확인 → 적용을 거친다(적용은 미리보기를 기억해 두었다가 다시 계산해 비교한다).
  /** 저장된 클러스터 스냅숏으로 개요를 만든다. RDS도 데이터베이스도 부르지 않는다. 적용 뒤에 화면의 개요를 바꿀 때 쓴다. */
  overview: (target: PgTarget) => invoke<PgOverview>("pg_overview", { target }),
  preview: (target: PgTarget, change: PgChange) => invoke<PgPreview>("pg_preview", { target, change }),
  /** 새 비밀번호를 만든 변경이면 결과에 password가 한 번 들어 있다. 그 밖의 어떤 결과에도 없다. */
  apply: (target: PgTarget, change: PgChange, confirmText: string | null, undoOf: string | null) =>
    invoke<PgApplyResult>("pg_apply", { target, change, confirmText, undoOf }),
  previewBatch: (target: PgTarget, database: string, changes: PgChange[]) => invoke<PgBatchPreview>("pg_preview_batch", { target, database, changes }),
  applyBatch: (target: PgTarget, database: string, changes: PgChange[], confirmText: string | null, undoOf: string[] | null) =>
    invoke<PgBatchResult>("pg_apply_batch", { target, database, changes, confirmText, undoOf }),
  preset: (target: PgTarget, database: string, preset: PgPresetKind, schemas: string[]) =>
    invoke<PgPresetSuggestion>("pg_preset", { target, database, preset, schemas }),
  dropPlan: (target: PgTarget, role: string, reassignTo: string) => invoke<PgDropPlan>("pg_drop_plan", { target, role, reassignTo }),
  applyDrop: (target: PgTarget, role: string, reassignTo: string, confirmText: string) =>
    invoke<PgDropResult>("pg_apply_drop", { target, role, reassignTo, confirmText }),
  /** 앱이 한 변경의 기록(최신순). 모든 대상의 것이 한 파일에 있어서 대상을 받지 않는다. */
  changeLog: () => invoke<PgChangeLogEntry[]>("pg_change_log"),
  /** 기록 하나를 되돌리는 변경들. 적용은 pg_apply(undoOf)나 pg_apply_batch(undoOf)가 미리보기를 다시 거쳐 한다. */
  undo: (logId: string) => invoke<PgUndo>("pg_undo", { logId }),
  undoBatch: (batchId: string) => invoke<PgUndo>("pg_undo_batch", { batchId }),
};
