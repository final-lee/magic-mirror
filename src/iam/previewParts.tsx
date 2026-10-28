// 변경 미리보기 창(하나짜리, 묶음)이 함께 쓰는 조각: 경고, 호출, 영향받는 주체, 확인 문구 입력, 오류 안내.
import { KIND_LABEL, LEVEL_LABEL } from "./labels";
import type { Impact, PermDelta, PreviewWarning } from "./types";

/** 자세히 보여 주는 주체 수. 백엔드도 이만큼만 자세히 보내고 나머지는 수(impactsOmitted)만 보낸다 */
const MAX_IMPACTS = 30;

const DELTA = {
  gained: { className: "cp-gain", label: "얻는 권한", sign: "＋" },
  lost: { className: "cp-lose", label: "잃는 권한", sign: "－" },
  restricted: { className: "cp-cond", label: "조건부로 바뀜", sign: "～" },
} as const;

const WARN_LEVELS = ["block", "confirm", "warn"] as const;
const WARN_TITLE: Record<(typeof WARN_LEVELS)[number], string> = {
  block: "막혀서 적용할 수 없어요",
  confirm: "확인이 필요해요",
  warn: "주의하세요",
};

/** [적용]이 꺼진 이유 중 확인 문구 입력으로 풀 수 없는 것들의 안내 */
export const GATE_HINT = {
  blocked: "막힘 경고가 있어서 적용할 수 없어요",
  noText: "확인 문구를 받지 못해서 적용할 수 없어요",
} as const;

/** 경고를 막힘 → 확인 → 주의 순서로 묶어서 보여 준다. 경고가 없으면 아무것도 그리지 않는다 */
export function WarningList({ warnings }: { warnings: PreviewWarning[] }) {
  return (
    <>
      {WARN_LEVELS.map((level) => {
        const items = warnings.filter((w) => w.level === level);
        if (items.length === 0) return null;
        return (
          <div key={level} className={`cp-warn ${level}`} data-level={level} data-testid="cp-warnings" role={level === "block" ? "alert" : undefined}>
            <div className="cp-warn-title">{WARN_TITLE[level]}</div>
            <ul>
              {items.map((w, i) => (
                <li key={i}>{w.message}</li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}

/** 호출할 API와 인자 */
export function CallList({ calls }: { calls: { api: string; params: Record<string, string> }[] }) {
  return (
    <ul className="cp-calls" aria-label="호출할 API">
      {calls.map((c, i) => (
        <li key={i}>
          <b className="mono">{c.api}</b>
          {Object.entries(c.params).map(([k, v]) => (
            <div className="cp-param" key={k}>
              <span className="dim">{k}</span>
              <span className="cp-val mono">{v}</span>
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

/** 영향받는 주체. `omitted`는 백엔드가 자세히 보내지 않은 주체 수다 */
export function ImpactList({ impacts, omitted }: { impacts: Impact[]; omitted: number }) {
  const shown = impacts.slice(0, MAX_IMPACTS);
  const total = impacts.length + omitted;
  return (
    <>
      <h4>
        영향받는 주체 <span className="dim">{total}</span>
      </h4>
      {total === 0 ? (
        // 영향은 서비스·접근 수준 단위로 계산한다: 일부 리소스에만 걸린 변화(특정 ARN에 건 Deny 등)는 여기서 비어 보인다
        <p className="cp-none">서비스·접근 수준 단위로는 권한이 달라지는 주체가 없어요. 일부 리소스에만 걸리는 변화는 이 목록에 나오지 않아요</p>
      ) : (
        <ul className="cp-impacts" aria-label="영향받는 주체">
          {shown.map((impact) => (
            <ImpactItem key={impact.principal.arn} impact={impact} />
          ))}
          {total > shown.length && <li className="dim">외 {total - shown.length}명</li>}
        </ul>
      )}
    </>
  );
}

export function ImpactItem({ impact }: { impact: Impact }) {
  const restricted = impact.restricted ?? [];
  const unchanged = impact.gained.length === 0 && impact.lost.length === 0 && restricted.length === 0;
  return (
    <li data-testid={`impact-${impact.principal.arn}`}>
      <div className="cp-who">
        <b>{impact.principal.name}</b> <span className="iam-kind">{KIND_LABEL[impact.principal.kind]}</span>
      </div>
      {impact.gained.length > 0 && <Deltas kind="gained" deltas={impact.gained} omitted={impact.gainedOmitted ?? 0} />}
      {impact.lost.length > 0 && <Deltas kind="lost" deltas={impact.lost} omitted={impact.lostOmitted ?? 0} />}
      {restricted.length > 0 && <Deltas kind="restricted" deltas={restricted} omitted={impact.restrictedOmitted ?? 0} />}
      {unchanged && <div className="dim">권한 변화 없음</div>}
    </li>
  );
}

/** 한 방향의 증감 줄. 조건부로 바뀐 작업은 이름을 붙여 따로 보여 준다(잃은 것은 아니지만 조건이 맞지 않으면 막힌다) */
export function Deltas({ kind, deltas, omitted }: { kind: keyof typeof DELTA; deltas: PermDelta[]; omitted: number }) {
  const { className, label, sign } = DELTA[kind];
  return (
    <>
      {kind === "restricted" && <div className="cp-cap cp-cond">{label}</div>}
      <ul className={className} data-testid={kind} aria-label={label}>
        {deltas.map((d) => (
          <li key={`${d.prefix}|${d.level}`}>
            <span className="cp-sign" aria-hidden="true">
              {sign}
            </span>
            <b>{d.prefix}</b> · {LEVEL_LABEL[d.level]} {d.count}개
            {d.sample.length > 0 && <span className="mono dim"> {d.sample.join(", ")}</span>}
            {d.count > d.sample.length && <span className="dim"> 외 {d.count - d.sample.length}개</span>}
          </li>
        ))}
        {/* 줄마다 붙는 "외 N개"(그 줄의 작업 수)와 헷갈리지 않게, 빠진 것이 (서비스, 수준) 줄이라고 적는다 */}
        {omitted > 0 && <li className="dim">서비스·수준 {omitted}개 더</li>}
      </ul>
    </>
  );
}

/** 되돌릴 수 있는지. 되돌릴 수 없는 이유는 확인 경고가 말한다 */
export function ReversibleNote({ reversible }: { reversible: boolean }) {
  // 이 자격 증명이 되돌릴 권한을 잃는 경우에도 기록의 역변경은 남아서, 권한이 있는 다른 자격 증명으로는 되돌릴 수 있다.
  // 그래서 "변경 기록에서도"라고 하지 않는다
  return <p className={`cp-rev${reversible ? "" : " no"}`}>{reversible ? "되돌릴 수 있어요" : "되돌릴 수 없어요"}</p>;
}

/** 확인 문구 입력. 입력할 때마다 다시 그려지는 것은 이 칸과 버튼뿐이다 */
export function ConfirmField({ required, typed, onTyped, locked }: { required: string; typed: string; onTyped: (v: string) => void; locked: boolean }) {
  return (
    <label className="field cp-confirm">
      <span>확인하려면 {required}를 입력하세요</span>
      <input
        aria-label={`확인하려면 ${required}를 입력하세요`}
        value={typed}
        disabled={locked}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(e) => onTyped(e.target.value)}
        // Enter로는 아무것도 실행하지 않는다: 위험한 변경은 버튼을 직접 눌러야 한다
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
      />
      {/* 아직 입력하는 중(맞게 쓴 앞부분)일 때는 틀렸다고 하지 않는다 */}
      {!required.startsWith(typed) && <span className="err">입력한 이름이 달라요</span>}
    </label>
  );
}

/** 미리보기나 적용이 실패했을 때의 오류와 "미리보기를 다시 받아야 해요" 안내. 둘 다 없으면 그리지 않는다 */
export function PreviewAlerts({ error, stale }: { error: { kind: "preview" | "apply"; message: string } | null; stale: boolean }) {
  if (!error && !stale) return null;
  return (
    <div className="cp-alerts">
      {error && (
        <div className="cp-error" role="alert">
          <div>{error.kind === "preview" ? "미리보기를 만들지 못했어요" : "적용하지 못했어요"}</div>
          <div>{error.message}</div>
        </div>
      )}
      {stale && <p className="cp-stale">적용에 실패했어요. 상태가 바뀌었을 수 있어서 미리보기를 다시 받은 뒤에 적용할 수 있어요</p>}
    </div>
  );
}
