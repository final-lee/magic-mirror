import { useQueryClient } from "@tanstack/react-query";
import { isAppError } from "../api/errors";
import { ErrorState } from "../components/ErrorState";
import { LoginPrompt } from "./LoginPrompt";
import { useKvLogin } from "./loginContext";
import { refreshKv } from "./queries";
import type { KvTarget } from "./types";

interface Props {
  error: unknown;
  target: KvTarget;
  compact?: boolean;
  /** [다시 시도]와 로그인이 끝난 뒤에 할 일. 대상 전체를 다시 읽는 것이 맞지 않는 화면이 넘긴다 */
  onRetry?: () => void;
}

/**
 * 실패한 kv 쿼리를 보이는 상자. 화면마다 ErrorState를 직접 쓰지 말고 이것을 쓴다.
 * - loginRequired(인증 실패, 저장한 비밀번호 없음, 방식 불일치)면 그 자리에서 로그인 상자를 띄운다. 오류의 message가 이유다.
 * - 그 밖에는 [다시 시도]가 그 쿼리만이 아니라 대상 전체를 다시 읽는다(refreshKv): 연결이 끊겨서 실패했다면 개요부터 다시 연결해야 나머지가 읽힌다.
 * - SSO 로그인이 끝나도(자동이든 이 상자의 버튼이든) 같다.
 */
export function KvError({ error, target, compact, onRetry }: Props) {
  const qc = useQueryClient();
  const login = useKvLogin();
  if (isAppError(error) && error.kind === "loginRequired" && login) {
    return (
      <div className="kv-prompt">
        <LoginPrompt info={login.info} initial={login.current} message={error.message} onSubmit={login.connect} />
      </div>
    );
  }
  const retry = onRetry ?? (() => void refreshKv(qc, target));
  return <ErrorState error={error} profile={target.profile} compact={compact} onRetry={retry} onLoggedIn={retry} />;
}
