import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { desktop } from "../api/desktop";

interface Props {
  /** 방금 만든 새 비밀번호. 이 컴포넌트가 화면에서 사라지면 어디에도 남지 않는다 */
  password: string;
  /** 어느 변경의 비밀번호인지(예: "역할 만들기: carol"). 비밀번호만 덜렁 보이지 않게 한다 */
  summary?: string;
  onClose: () => void;
}

/** 입력 칸의 글을 모두 고른다. 직접 복사하려는 사람이 한 번에 고르게 한다 */
const selectAll = (e: SyntheticEvent<HTMLInputElement>) => e.currentTarget.select();

/**
 * 비밀번호 결과: 적용에 성공한 뒤 새 비밀번호를 한 번만 보여 준다. 창을 닫으면 다시 볼 수 없다.
 * 미리보기 창의 본문과 버튼 자리를 대신하는 조각이라서, 창(.sheet.cp) 안에 본문과 아래 버튼 줄을 함께 그린다.
 * 처음 초점은 [복사]다: 비밀번호를 버리는 [닫기]에 두지 않는다.
 */
export function PasswordResult({ password, summary, onClose }: Props) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const copyRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    copyRef.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);

  const copy = async () => {
    try {
      await desktop.copy(password);
      if (mounted.current) setCopied("done");
    } catch {
      // 클립보드가 거절해도 비밀번호는 칸에 그대로 있다: 거기서 직접 복사할 수 있다
      if (mounted.current) setCopied("failed");
    }
  };

  return (
    <>
      <div className="cp-body">
        <h3>새 비밀번호</h3>
        {summary && <p className="cp-sum">{summary}</p>}
        <input className="field-input mono cp-password" type="text" readOnly value={password} aria-label="새 비밀번호" autoComplete="off" spellCheck={false} onFocus={selectAll} onClick={selectAll} />
        <p className="cp-note">이 창을 닫으면 다시 볼 수 없어요</p>
        {/* 알림 자리는 처음부터 있어야 스크린 리더가 바뀐 글을 읽는다 */}
        <p role="status" className={`cp-copied${copied === "failed" ? " err" : ""}`}>
          {copied === "done" ? "복사했어요" : copied === "failed" ? "복사하지 못했어요" : ""}
        </p>
      </div>
      <div className="foot">
        <button ref={copyRef} className="btn" onClick={() => void copy()}>
          복사
        </button>
        <button className="btn primary" onClick={onClose}>
          닫기
        </button>
      </div>
    </>
  );
}
