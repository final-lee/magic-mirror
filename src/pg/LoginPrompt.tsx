import { useState } from "react";

interface Props {
  /** 입력칸의 처음 값. [바꾸기]로 다시 열면 지금 쓰는 이름이다 */
  initial?: string;
  onSubmit: (name: string) => void;
  /** 돌아갈 곳이 있을 때(바꾸기로 연 경우)만 준다. [취소]가 생긴다 */
  onCancel?: () => void;
}

/** 대상마다 처음 열 때 IAM 인증으로 접속할 DB 사용자 이름을 묻는다. */
export function LoginPrompt({ initial = "", onSubmit, onCancel }: Props) {
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  return (
    <form
      className="pg-login"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed) onSubmit(trimmed);
      }}
    >
      <h3>DB 사용자</h3>
      <p>IAM 인증으로 접속할 DB 사용자 이름을 입력하세요(예: iam_admin). 이 대상에 대해 기억해 둘게요</p>
      <input className="field-input mono" aria-label="DB 사용자" value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} autoComplete="off" />
      <div className="pg-login-foot">
        {onCancel && (
          <button type="button" className="btn plain" onClick={onCancel}>
            취소
          </button>
        )}
        <button type="submit" className="btn primary" disabled={!trimmed}>
          연결
        </button>
      </div>
    </form>
  );
}
