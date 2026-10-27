import { useState } from "react";
import { api } from "../api/client";
import { errorMessage, isAppError } from "../api/errors";
import { useSsoLoginContext } from "../lib/useSsoLogin";

interface Props {
  error: unknown;
  profile: string;
  onRetry: () => void;
  compact?: boolean;
}

export function ErrorState({ error, profile, onRetry, compact = false }: Props) {
  const box = compact ? "error-banner" : "empty";
  const [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const sso = useSsoLoginContext();

  if (isAppError(error) && error.kind === "ssoExpired") {
    const running = sso ? sso.statusFor(profile)?.kind === "running" : busy;
    const login = async () => {
      if (sso) {
        if (await sso.start(profile, { manual: true })) onRetry();
        return;
      }
      setBusy(true);
      setLoginError(null);
      try {
        await api.ssoLogin(profile);
        onRetry();
      } catch (e) {
        setLoginError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className={box}>
        <div>
          <p>SSO 세션이 만료됐어요 ({profile})</p>
          <button className="btn primary" disabled={running} onClick={login}>
            {running ? "브라우저에서 로그인을 완료하세요…" : "로그인"}
          </button>
          {loginError && <p className="err">{loginError}</p>}
        </div>
      </div>
    );
  }

  const retryable = !(isAppError(error) && error.kind === "accessDenied");
  return (
    <div className={box}>
      <div>
        <p className="err">{errorMessage(error)}</p>
        {retryable && (
          <button className="btn" onClick={onRetry}>
            다시 시도
          </button>
        )}
      </div>
    </div>
  );
}
