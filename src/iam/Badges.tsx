import type { Badge, BadgeKind } from "./types";

export function BadgeChip({ badge }: { badge: Badge }) {
  return (
    <span className={`iam-badge ${badge.level}`} data-kind={badge.kind}>
      {badge.label}
    </span>
  );
}

/** hide: 옆 칸이 이미 알려 주는 종류(예: 범위 칸이 있는 AWS 관리형)는 되풀이하지 않는다. */
export function BadgeList({ badges, hide }: { badges: Badge[]; hide?: BadgeKind[] }) {
  const shown = hide ? badges.filter((b) => !hide.includes(b.kind)) : badges;
  if (shown.length === 0) return null;
  return (
    <span className="iam-badges">
      {shown.map((b, i) => (
        <BadgeChip key={`${b.kind}-${i}`} badge={b} />
      ))}
    </span>
  );
}
