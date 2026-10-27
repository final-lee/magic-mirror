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
        // 관리자가 성공 때 쿼리를 무효화하지만 켜진 쿼리만 다시 불린다. 누를 때만 도는 쿼리(enabled: false)는 여기서 다시 불러야 화면이 풀린다.
        // 켜진 쿼리는 한 번 더 불리는 셈인데, 그 비용은 받아들인다.
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
