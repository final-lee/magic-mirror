import { useEffect, useRef } from "react";
import { errorMessage } from "../../api/errors";
import { isTokenError } from "../queries";

/** 토큰이 없거나 무효라서 난 오류가 있으면 한 번 알린다(서버 단위의 일이라 토큰 폼으로 돌려보낸다) */
export function useTokenGuard(errors: unknown[], onTokenError: (message: string) => void) {
  const notify = useRef(onTokenError);
  notify.current = onTokenError;
  useEffect(() => {
    const bad = errors.find(isTokenError);
    if (bad) notify.current(errorMessage(bad));
    // errors는 호출마다 새 배열이라 안의 값으로 비교한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, errors);
}
