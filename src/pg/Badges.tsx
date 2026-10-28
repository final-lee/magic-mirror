import type { PgBadge } from "./types";

/** 백엔드의 수준(high, medium, info)을 IAM 배지의 색 이름에 맞춘다. 모양은 IAM 배지(.iam-badge)를 그대로 쓴다. */
const LOOK: Record<PgBadge["level"], string> = { high: "danger", medium: "warn", info: "info" };

export function BadgeChip({ badge }: { badge: PgBadge }) {
  return (
    <span className={`iam-badge ${LOOK[badge.level]}`} data-kind={badge.kind}>
      {badge.label}
    </span>
  );
}

export function BadgeList({ badges }: { badges: PgBadge[] }) {
  if (badges.length === 0) return null;
  return (
    <span className="iam-badges">
      {badges.map((b) => (
        <BadgeChip key={b.kind} badge={b} />
      ))}
    </span>
  );
}
