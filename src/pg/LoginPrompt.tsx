import { useId, useState } from "react";
import { loginNameError } from "./loginName";

interface Props {
  /** 입력칸의 처음 값. [바꾸기]로 다시 열면 지금 쓰는 이름이다 */
  initial?: string;
  onSubmit: (name: string) => void;
  /** 돌아갈 곳이 있을 때(바꾸기로 연 경우)만 준다. [취소]가 생긴다 */
  onCancel?: () => void;
}

/**
 * 대상마다 처음 열 때 IAM 인증으로 접속할 DB 사용자 이름을 묻는다.
 * 앞뒤 공백은 걷어내고, 백엔드가 거절할 이름(loginNameError)은 이유를 입력칸 아래에 보이고 넘기지 않는다.
 * 그래서 설정 파일에 저장되거나 접속에 쓰이는 이름은 늘 백엔드가 받는 이름이다.
 */
export function LoginPrompt({ initial = "", onSubmit, onCancel }: Props) {
  const [name, setName] = useState(initial);
  const messageId = useId();
  const trimmed = name.trim();
  const problem = loginNameError(trimmed);
  const ready = trimmed !== "" && problem === null;
  return (
    <form
      className="pg-login"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit(trimmed);
      }}
    >
      <h3>DB 사용자</h3>
      <p>IAM 인증으로 접속할 DB 사용자 이름을 입력하세요(예: iam_admin). 이 대상에 대해 기억해 둘게요</p>
      <input
        className="field-input mono"
        aria-label="DB 사용자"
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? messageId : undefined}
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        spellCheck={false}
        autoComplete="off"
      />
      {problem && (
        <p id={messageId} className="pg-login-error" role="alert">
          {problem}
        </p>
      )}
      <div className="pg-login-foot">
        {onCancel && (
          <button type="button" className="btn plain" onClick={onCancel}>
            취소
          </button>
        )}
        <button type="submit" className="btn primary" disabled={!ready}>
          연결
        </button>
      </div>
    </form>
  );
}
