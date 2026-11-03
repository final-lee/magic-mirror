import type { QueryClient } from "@tanstack/react-query";
import { accessApi } from "../access/api";
import { accessKeys } from "../access/queries";
import type { K8sTarget } from "../types";

/** 권한 변경을 적용한 뒤 접근 화면(신원·권한 표)을 새로 읽는다: 백엔드 계산 캐시도 버린다 */
export async function refreshAccess(qc: QueryClient, target: K8sTarget, context: string | null) {
  try {
    const view = await accessApi.access(target, true);
    qc.removeQueries({ queryKey: accessKeys.root(target, context) });
    qc.setQueryData(accessKeys.view(target, context), view);
  } catch {
    void qc.invalidateQueries({ queryKey: accessKeys.root(target, context) });
  }
}
