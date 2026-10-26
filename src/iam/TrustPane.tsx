import type { TrustEntry } from "./types";

const TRUST_LABEL: Record<TrustEntry["kind"], string> = {
  service: "서비스",
  account: "계정",
  federated: "연동",
  anyone: "누구나",
  principal: "주체",
};

/** 신뢰 탭(역할): 누가 이 역할을 맡을 수 있는지와 경고 */
export function TrustPane({ trust }: { trust: TrustEntry[] }) {
  if (trust.length === 0) return <div className="empty small">이 역할을 맡을 수 있는 대상이 없어요</div>;
  return (
    <ul className="iam-trust" aria-label="신뢰 관계">
      {trust.map((t, i) => (
        <li key={i} className={t.warning ? "warn" : undefined}>
          <div className="tr-top">
            <span className={`iam-chip trust-${t.kind}`}>{TRUST_LABEL[t.kind]}</span>
            <span className="mono tr-value">{t.value}</span>
            {t.external && <span className="iam-chip conditional">외부</span>}
            {t.conditional && <span className="iam-chip">조건 있음</span>}
          </div>
          <div className="tr-actions">
            {t.actions.map((a) => (
              <span key={a} className="mono dim">
                {a}
              </span>
            ))}
          </div>
          {t.warning && (
            <div className="tr-warning">
              <span aria-hidden="true">⚠</span> <span>{t.warning}</span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
