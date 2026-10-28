import { useQueryClient } from "@tanstack/react-query";
import { ErrorState } from "../components/ErrorState";
import { refreshPg } from "./queries";
import type { PgTarget } from "./types";

interface Props {
  error: unknown;
  target: PgTarget;
  compact?: boolean;
  /**
   * [다시 시도]와 로그인이 끝난 뒤에 할 일. 대상 전체를 다시 읽는 것이 맞지 않는 화면이 넘긴다:
   * 변경 기록은 이 대상의 DB가 아니라 앱의 파일을 읽으니 연결을 다시 열어도 나아지지 않고, 되돌리기가 실패했다면 그 되돌리기를 다시 하는 것이 다시 시도다.
   */
  onRetry?: () => void;
}

/**
 * 실패한 pg 쿼리를 보이는 상자. 화면마다 ErrorState를 직접 쓰지 말고 이것을 쓴다.
 * - [다시 시도]는 그 쿼리만이 아니라 대상 전체를 다시 읽는다(refreshPg). 연결이 끊겨서 실패했다면 개요부터 다시 연결해야 나머지가 읽힌다.
 * - SSO 로그인이 끝나도(자동이든 이 상자의 버튼이든) 같다. 앱의 로그인 관리자는 pg 쿼리를 다시 부르지 않는다(쿼리 키에 프로필이 없다).
 * - 화면이 onRetry를 넘기면 둘 다 그것을 한다.
 */
export function PgError({ error, target, compact, onRetry }: Props) {
  const qc = useQueryClient();
  const retry = onRetry ?? (() => void refreshPg(qc, target));
  return <ErrorState error={error} profile={target.profile} compact={compact} onRetry={retry} onLoggedIn={retry} />;
}
