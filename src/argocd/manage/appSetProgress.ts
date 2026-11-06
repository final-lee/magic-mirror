import type { AppSetAppStatus, AppSetDetail, StepInfo } from "./types";

export interface StepProgress {
  /** 1부터 세는 단계 번호 */
  step: number;
  info: StepInfo;
  apps: AppSetAppStatus[];
}

/** Progressive Sync 단계마다 그 단계에 속한 앱의 진행 상태를 묶는다(status.applicationStatus의 step은 1부터 센 글이다) */
export function groupProgress(set: Pick<AppSetDetail, "strategy" | "applicationStatus">): StepProgress[] {
  return (set.strategy?.steps ?? []).map((info, i) => ({
    step: i + 1,
    info,
    apps: set.applicationStatus.filter((a) => a.step === String(i + 1)).sort((a, b) => a.application.localeCompare(b.application)),
  }));
}
