import { useState } from "react";
import { desktop } from "../api/desktop";
import { COPIED, COPY, RECHECK } from "./text";

interface Props {
  message: string;
  command: string;
  onRecheck: () => void;
}

/** 접속할 context가 없을 때: 안내 문장, 복사할 수 있는 명령, 다시 확인 */
export function NoContext({ message, command, onRecheck }: Props) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await desktop.copy(command);
      setCopied(true);
    } catch (e) {
      console.error("복사하지 못했어요", e);
    }
  };
  return (
    <div className="k8s-prompt">
      <div className="k8s-card">
        <p>{message}</p>
        <code className="k8s-cmd">{command}</code>
        <div className="k8s-actions">
          <button className="btn tone-secondary" onClick={() => void copy()}>
            {copied ? COPIED : COPY}
          </button>
          <button className="btn tone-secondary" onClick={onRecheck}>
            {RECHECK}
          </button>
        </div>
      </div>
    </div>
  );
}
