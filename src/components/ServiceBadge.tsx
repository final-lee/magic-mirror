/**
 * AWS 공식 Architecture Icons(서비스 아이콘 32px, 2026-07-31 릴리스, https://aws.amazon.com/architecture/icons/).
 * 파일 이름이 서비스 id다(비용 탭은 cost = Cost Explorer).
 */
const ICONS = import.meta.glob<string>("../assets/aws/*.svg", { eager: true, query: "?url", import: "default" });

/** 서비스 id의 공식 아이콘 주소. 없으면 undefined */
export const awsIconOf = (id: string): string | undefined => ICONS[`../assets/aws/${id}.svg`];

/** AWS 서비스 아이콘. 공식 아이콘이 없는 서비스는 이름 앞 두 글자 배지로 보인다 */
export function ServiceBadge({ service }: { service: { id: string; name: string } }) {
  const icon = awsIconOf(service.id);
  if (icon) {
    return <img className="badge badge-icon" src={icon} alt="" aria-hidden="true" />;
  }
  return (
    <span className="badge" style={{ background: "var(--badge-gray)", color: "var(--badge-text)" }} aria-hidden="true">
      {service.name.slice(0, 2).toUpperCase()}
    </span>
  );
}
