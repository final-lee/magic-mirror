import { ErrorState } from "../components/ErrorState";
import { LEVEL_LABEL, STATUS_LABEL } from "./labels";
import { usePrincipalActions } from "./queries";
import type { MatrixCell } from "./route";
import type { ActionGrant, GrantSource } from "./types";

interface Props {
  profile: string;
  arn: string;
  cell: MatrixCell;
  onClose: () => void;
  onOpenPolicy: (policyId: string) => void;
  onOpenGroup: (name: string) => void;
}

const MAX_RESOURCES = 5;
const STATUSES = ["allowed", "conditional", "denied", "boundary"] as const;

function summarize(grants: ActionGrant[]): string {
  const parts = [`작업 ${grants.length}개`];
  for (const status of STATUSES) {
    const n = grants.filter((g) => g.status === status).length;
    if (n > 0) parts.push(`${STATUS_LABEL[status]} ${n}`);
  }
  return parts.join(" · ");
}

/** 작업 하나의 근거 한 줄(정책, 상속한 그룹, Sid, 조건). 누가 할 수 있나 화면의 근거 칸도 같은 모양을 쓴다. */
export function Source({ s, onOpenPolicy, onOpenGroup }: { s: GrantSource } & Pick<Props, "onOpenPolicy" | "onOpenGroup">) {
  return (
    <li className="dr-s">
      <button className="link" onClick={() => onOpenPolicy(s.policyId)}>
        {s.policyName}
      </button>
      {s.via && (
        <span className="dim">
          {" "}
          · 그룹{" "}
          <button className="link" onClick={() => onOpenGroup(s.via!)}>
            {s.via}
          </button>
        </span>
      )}
      {s.effect === "Deny" && <span className="iam-chip denied">Deny</span>}
      {/* 문장 번호는 0부터 센 index라 사람이 읽을 때는 1을 더한다 */}
      <span className="dr-sid mono dim">{s.sid ?? `문장 ${s.statementIndex + 1}`}</span>
      {s.conditional && <span className="iam-chip conditional">조건 있음</span>}
      {s.boundary && <span className="iam-chip">권한 경계</span>}
    </li>
  );
}

function Grant({ g, onOpenPolicy, onOpenGroup }: { g: ActionGrant } & Pick<Props, "onOpenPolicy" | "onOpenGroup">) {
  const shown = g.resources.slice(0, MAX_RESOURCES);
  return (
    <li className="dr-item">
      <div className="dr-top">
        <span className="mono dr-action">{g.action}</span>
        <span className={`iam-chip ${g.status}`}>{STATUS_LABEL[g.status]}</span>
      </div>
      {g.danger && (
        <div className="dr-danger">
          <span aria-hidden="true">⚠</span> <span>{g.danger}</span>
        </div>
      )}
      <div className="dr-res">
        <span className="dim">대상</span>
        {shown.map((r) => (
          <span key={r} className="mono dr-r">
            {r}
          </span>
        ))}
        {g.resources.length > shown.length && <span className="dim">외 {g.resources.length - shown.length}개</span>}
      </div>
      <ul className="dr-src" aria-label="근거">
        {g.sources.map((s, i) => (
          <Source key={i} s={s} onOpenPolicy={onOpenPolicy} onOpenGroup={onOpenGroup} />
        ))}
      </ul>
    </li>
  );
}

/** 권한 표에서 고른 칸의 실제 작업 목록. 작업마다 상태, 대상 리소스, 근거(정책·그룹·Sid·조건)를 보여준다. */
export function ActionDrilldown({ profile, arn, cell, onClose, onOpenPolicy, onOpenGroup }: Props) {
  const q = usePrincipalActions(profile, arn, cell.prefix, cell.level);
  const grants = q.data;

  return (
    <aside className="detail iam-drill" aria-label="작업 상세">
      <div className="dr-head">
        <h3>
          {cell.name} · {LEVEL_LABEL[cell.level]}
        </h3>
        <button className="icon" aria-label="닫기" onClick={onClose}>
          ✕
        </button>
      </div>
      {q.isError && <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} />}
      {!grants ? (
        !q.isError && <div className="empty small">작업 목록을 불러오는 중…</div>
      ) : grants.length === 0 ? (
        <div className="empty small">해당하는 작업이 없어요</div>
      ) : (
        <>
          <div className="sub">{summarize(grants)}</div>
          <ul className="dr-list" aria-label="작업 목록">
            {grants.map((g) => (
              <Grant key={g.action} g={g} onOpenPolicy={onOpenPolicy} onOpenGroup={onOpenGroup} />
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
