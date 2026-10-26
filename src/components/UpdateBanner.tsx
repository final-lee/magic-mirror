import { useState } from "react";
import type { Updater } from "../lib/useUpdater";

interface Props {
  updater: Updater;
  /** 진행 중인 파일 전송이 있으면 업데이트(앱 재시작)를 미룬다 */
  transfersActive: boolean;
}

export function UpdateBanner({ updater, transfersActive }: Props) {
  const [blocked, setBlocked] = useState(false);
  const { state } = updater;
  if (!updater.showBanner) return null;

  if (state.kind === "downloading") {
    return (
      <div className="update-banner" role="status">
        새 버전 {state.version} 내려받는 중{state.percent !== null ? `… ${state.percent}%` : "…"} 끝나면 앱이 다시 시작돼요.
      </div>
    );
  }
  if (state.kind !== "available") return null;

  const start = () => {
    if (transfersActive) {
      setBlocked(true);
      return;
    }
    void updater.install();
  };

  return (
    <div className="update-banner" role="status">
      <span>
        ✨ 새 버전 <b>{state.version}</b>이 나왔어요.
        {blocked && transfersActive && " 파일 전송이 끝난 뒤에 업데이트해 주세요."}
      </span>
      <button className="btn small primary" onClick={start}>
        지금 업데이트
      </button>
      <button className="btn small" onClick={updater.dismiss}>
        나중에
      </button>
    </div>
  );
}
