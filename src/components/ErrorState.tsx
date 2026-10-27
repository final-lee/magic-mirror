import { useEffect, useRef, useState } from "react";
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
  const ssoExpired = isAppError(error) && error.kind === "ssoExpired";
  // 이 화면이 뜬 뒤 그 세션의 로그인이 성공하면(자동 로그인이든 이 버튼이든) 한 번 다시 불러온다.
  // 무효화는 켜진 쿼리만 다시 부르니, 누를 때만 도는 쿼리(enabled: false)는 이렇게 해야 풀린다.
  // 화면이 뜨기 전의 성공은 보지 않는다: 로그인한 뒤에도 만료로 실패한 화면을 계속 다시 부르지 않게 한다.
  const [shownAt] = useState(() => Date.now());
  const loggedInAt = sso?.lastSuccessAt(profile) ?? null;
  const retry = useRef(onRetry);
  retry.current = onRetry;
  const reloadedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!ssoExpired || loggedInAt === null || loggedInAt < shownAt || reloadedFor.current === loggedInAt) return;
    reloadedFor.current = loggedInAt;
    retry.current();
  }, [ssoExpired, loggedInAt, shownAt]);

  if (ssoExpired) {
    const running = sso ? sso.statusFor(profile)?.kind === "running" : busy;
    const login = async () => {
      if (sso) {
        // 성공하면 위의 효과가 다시 불러온다
        await sso.start(profile, { manual: true });
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
