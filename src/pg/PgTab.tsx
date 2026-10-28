import type { PgTarget } from "./types";

interface Props {
  target: PgTarget;
  title: string;
  active: boolean;
  /** 툴바 필터. 이 탭이 활성일 때만 값이 온다. */
  filter: string;
}

/** PostgreSQL 사용자 관리 탭. 연결과 화면은 다음 작업(PF2)에서 채우고, 지금은 제목만 보인다. */
export function PgTab({ title }: Props) {
  return (
    <section className="center">
      <div className="empty">{title}</div>
    </section>
  );
}
