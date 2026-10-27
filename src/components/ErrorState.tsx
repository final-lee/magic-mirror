import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { errorMessage, isAppError } from "../api/errors";
import { useSsoLoginContext } from "../lib/useSsoLogin";

interface Props {
  error: unknown;
  profile: string;
  onRetry: () => void;
  /**
   * 이 상자가 뜬 뒤 그 세션의 로그인이 성공하면(자동이든 이 버튼이든) 한 번 부른다.
   * 로그인 관리자는 켜진 쿼리를 무효화해서 다시 부르지만, 누를 때만 도는 쿼리(enabled: false)는 다시 부르지 않는다.
   * 그런 쿼리의 상자만 그 쿼리 자신의 refetch를 넘긴다. 켜진 쿼리의 상자는 넘기지 않는다. 이미 무효화로 다시 불리고,
   * 상자마다 onRetry(앱 전체 새로 고침)를 부르면 같은 로그인 하나에 같은 일이 상자 수만큼 겹친다.
   */
  onLoggedIn?: () => void;
  compact?: boolean;
}

export function ErrorState({ error, profile, onRetry, onLoggedIn, compact = false }: Props) {
  const box = compact ? "error-banner" : "empty";
  const [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const sso = useSsoLoginContext();
  const ssoExpired = isAppError(error) && error.kind === "ssoExpired";
  // 이 화면이 뜬 뒤 그 세션의 로그인이 성공하면(자동 로그인이든 이 버튼이든) 한 번 onLoggedIn을 부른다.
  // 화면이 뜨기 전의 성공은 보지 않는다: 로그인한 뒤에도 만료로 실패한 화면을 계속 다시 부르지 않게 한다.
  // 같은 성공으로는 다시 부르지 않는다(오류 종류가 만료 → 다른 오류 → 만료로 바뀌어도 효과가 다시 돌기 때문).
  const [shownAt] = useState(() => Date.now());
  const loggedInAt = sso?.lastSuccessAt(profile) ?? null;
  const loggedIn = useRef(onLoggedIn);
  loggedIn.current = onLoggedIn;
  const notifiedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!ssoExpired || loggedInAt === null || loggedInAt < shownAt || notifiedFor.current === loggedInAt) return;
    notifiedFor.current = loggedInAt;
    loggedIn.current?.();
  }, [ssoExpired, loggedInAt, shownAt]);

  if (ssoExpired) {
    const running = sso ? sso.statusFor(profile)?.kind === "running" : busy;
    const login = async () => {
      if (sso) {
        // 성공하면 위의 효과가 onLoggedIn을 부른다
        await sso.start(profile, { manual: true });
        return;
      }
      setBusy(true);
      setLoginError(null);
      try {
        await api.ssoLogin(profile);
        onLoggedIn?.();
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
