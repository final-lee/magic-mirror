// 변경의 요약 글. 백엔드 pg::change::text와 글자까지 같아야 한다(요약은 미리보기와 변경 기록에 백엔드가 쓰고, 화면은 미리보기를 받기 전의 제목과 장바구니의 줄에 같은 글을 쓴다).
// 이름 뒤에는 조사를 붙이지 않는다: 이름 앞에 "역할"을 붙이거나 이름을 쌍점 뒤에 둔다.
import { granteeLabel } from "./sentences";
import type { PgChange, PgGrantItem, PgGrantTarget } from "./types";

/** 권한 이름의 순서. 백엔드 `Privilege`의 선언 순서와 같다(pg::model::Privilege). 읽기 전용이다: 제자리에서 정렬하면 모든 요약이 바뀐다 */
export const PRIVILEGE_ORDER = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN", "EXECUTE", "USAGE", "CREATE", "CONNECT", "TEMPORARY"] as const;

/**
 * 권한 목록의 글: 선언 순서로 한 번씩만 적고 ", "로 잇는다(pg::change::sql_text::privilege_list). 호출하는 쪽이 준 순서와 상관없이 같은 글이 나와야
 * 요약이 SQL이 주는 권한과 순서까지 같고 미리보기를 비교할 수 있다. 목록에 없는 이름(백엔드는 읽지 않는다)은 받은 순서대로 맨 뒤에 둔다.
 */
export function privilegeList(privileges: string[]): string {
  const order: readonly string[] = PRIVILEGE_ORDER;
  const rank = (name: string) => {
    const i = order.indexOf(name);
    return i === -1 ? order.length : i;
  };
  return [...new Set(privileges)].sort((a, b) => rank(a) - rank(b)).join(", ");
}

/** 받는 대상 하나의 이름. 함수는 서버가 적어 준 인자 목록까지 붙인다. */
export function targetLabel(target: PgGrantTarget): string {
  switch (target.kind) {
    case "database":
      return `데이터베이스 ${target.name}`;
    case "schema":
      return `스키마 ${target.name}`;
    case "relation":
    case "sequence":
      return `${target.schema}.${target.name}`;
    case "function":
      return `${target.schema}.${target.name}(${target.signature})`;
    case "allTables":
      return `${target.schema} 스키마의 모든 테이블`;
    case "allSequences":
      return `${target.schema} 스키마의 모든 시퀀스`;
  }
}

/** 권한 주기·빼기 요약의 뒷부분: 항목이 하나면 대상과 권한 목록, 여럿이면 개수 */
export function grantWhat(items: PgGrantItem[]): string {
  if (items.length === 1) return `${targetLabel(items[0].target)} ${privilegeList(items[0].privileges)}`;
  return `객체 ${items.length}개`;
}

/** 묶음의 요약 */
export const batchSummary = (count: number) => `변경 ${count}개`;

/** 변경 하나의 요약. 백엔드 pg::change::text::summary와 같은 글이다. 받는 역할 PUBLIC은 "모든 역할(PUBLIC)"로 쓴다. */
export function changeSummary(change: PgChange): string {
  switch (change.kind) {
    case "createRole":
      return `역할 만들기: ${change.name}`;
    case "membership": {
      const pair = `${change.member} → ${change.group}`;
      if (change.admin) return `ADMIN OPTION ${change.add ? "주기" : "빼기"}: ${pair}`;
      return `${change.add ? "그룹에 넣기" : "그룹에서 빼기"}: ${pair}`;
    }
    case "attributes":
      return `속성 바꾸기: ${change.role}`;
    case "password":
      return `비밀번호 재설정: ${change.role}`;
    case "grant":
      return `${change.add ? "권한 주기" : "권한 빼기"}: ${granteeLabel(change.grantee)} · ${grantWhat(change.items)}`;
    case "defaultPrivilege":
      return `${change.add ? "기본 권한 주기" : "기본 권한 빼기"}: ${change.creator} → ${granteeLabel(change.grantee)}`;
    case "dropRole":
      return `역할 삭제: ${change.role}`;
    case "terminate":
      return `세션 끊기: ${change.role} (pid ${change.pid})`;
  }
}
