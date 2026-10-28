import { useRouteHistory } from "../lib/useRouteHistory";
import { sameRoute, type IamRoute } from "./route";

/**
 * IAM 탭의 뒤로/앞으로 기록. 같은 화면(view와 id가 같다)으로 이동하면 쌓지 않고, 뒤로 간 뒤 새로 이동하면 앞쪽 기록을 버린다.
 * `replace`는 현재 항목의 보던 상태(하위 탭, 열어 둔 칸)만 갱신해서 기록을 늘리지 않는다.
 */
export function useIamHistory(initial: IamRoute) {
  return useRouteHistory(initial, sameRoute);
}
