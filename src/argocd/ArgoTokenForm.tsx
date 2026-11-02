import { useState, type FormEvent } from "react";
import { TOKEN_CANCEL, TOKEN_HELP, TOKEN_HTTP_WARNING, TOKEN_LABEL, TOKEN_SUBMIT } from "./text";

interface Props {
  /** 토큰을 넣을 서버 주소(http://면 평문 경고를 보인다) */
  url: string;
  /** 왜 토큰을 다시 받는지, 또는 지난 시도의 실패 */
  message: string | null;
  busy: boolean;
  onSubmit: (token: string) => void;
  /** 주면 "취소" 버튼을 보인다(지금 토큰이 아직 쓸 만할 때 폼을 닫는다) */
  onCancel?: () => void;
}

/** API 토큰 입력 폼. 토큰은 이 폼의 상태에만 있고, 보내는 순간 비운다. */
export function ArgoTokenForm({ url, message, busy, onSubmit, onCancel }: Props) {
  const [token, setToken] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const submitted = token.trim();
    if (submitted === "") return;
    setToken("");
    onSubmit(submitted);
  };
  return (
    <form className="argo-token" onSubmit={submit}>
      <p>{TOKEN_HELP}</p>
      {url.toLowerCase().startsWith("http://") && (
        <p className="err" role="alert">
          {TOKEN_HTTP_WARNING}
        </p>
      )}
      {message && (
        <p className="err" role="alert">
          {message}
        </p>
      )}
      <label>
        {TOKEN_LABEL}
        <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
      </label>
      <div className="argo-token-acts">
        <button className="btn primary" type="submit" disabled={busy || token.trim() === ""}>
          {TOKEN_SUBMIT}
        </button>
        {onCancel && (
          <button className="btn plain" type="button" onClick={onCancel}>
            {TOKEN_CANCEL}
          </button>
        )}
      </div>
    </form>
  );
}
