import { invoke } from "../../api/invoke";
import type { K8sChange, K8sTarget } from "../types";
import type { RbacBatchPreview, RbacBatchResult } from "./types";

// 명령 이름과 인자는 src-tauri/src/k8s_commands/rbac.rs와 같다. 변경 하나는 공통 k8s_preview·k8s_apply가 처리한다.
export const rbacApi = {
  /** 변경들을 차례로(앞 변경이 적용된 상태에서) 미리보기한다. 항목마다 호출·차이·영향과 전체의 영향을 받는다 */
  previewBatch: (target: K8sTarget, changes: K8sChange[], ssoProfile: string) => invoke<RbacBatchPreview>("k8s_preview_batch", { target, changes, profile: ssoProfile }),
  /**
   * 미리보기한 변경들을 하나씩 적용한다. 적용 직전에 전체를 다시 계획해 미리보기와 다르면 아무것도 적용하지 않고 오류를 낸다.
   * 첫 실패에서 멈추고 나머지는 건너뛴다. confirmTexts·undoOf는 변경과 같은 순서다.
   */
  applyBatch: (target: K8sTarget, changes: K8sChange[], confirmTexts: (string | null)[], undoOf: (string | null)[], ssoProfile: string) =>
    invoke<RbacBatchResult>("k8s_apply_batch", { target, changes, confirmTexts, undoOf, profile: ssoProfile }),
};
