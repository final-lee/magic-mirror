import { useState } from "react";
import { desktop } from "../api/desktop";
import { ErrorState } from "../components/ErrorState";
import { formatDateTime } from "./format";
import { useFindings } from "./queries";
import { routeForFocus, type IamRoute } from "./route";
import type { FindingGroup, FindingItem, FindingKind, IamChange, IamOverview, Level } from "./types";

interface Props {
  profile: string;
  /** 점검 대상(사용자·역할·정책)을 상세 화면으로 연결하는 데 쓴다 */
  overview: IamOverview;
  onOpen: (route: IamRoute) => void;
  /** 빠른 조치를 누르면 그 변경을 넘긴다. 없으면 조치 버튼은 꺼져 있다(변경 흐름이 연결되기 전) */
  onFix?: (change: IamChange) => void;
  /** 뒤로 가기로 돌아왔을 때 고른 카드를 되살린다 */
  initialKind?: string;
  onViewState?: (state: { tab: string }) => void;
}

const LEVEL_TEXT: Record<Level, string> = { danger: "위험", warn: "주의", info: "참고" };

/** 액세스 키 점검은 대상 사용자의 키 탭을 바로 열어서, 키 ID를 보고 조치할 수 있게 한다. */
const KEY_KINDS: FindingKind[] = ["oldAccessKey", "unusedAccessKey"];

function fixLabel(change: IamChange): string {
  switch (change.op) {
    case "setAccessKeyStatus":
      return change.status === "Inactive" ? "키 비활성화" : "키 활성화";
    case "deleteAccessKey":
      return "키 삭제";
    case "attachPolicy":
      return "정책 붙이기";
    case "detachPolicy":
      return "정책 떼기";
    case "addToGroup":
      return "그룹에 추가";
    case "removeFromGroup":
      return "그룹에서 빼기";
    case "putInlinePolicy":
      return "인라인 정책 저장";
    case "deleteInlinePolicy":
      return "인라인 정책 삭제";
    case "updateManagedPolicy":
      return "정책 수정";
  }
}

/** 대상 이름을 눌렀을 때 갈 곳. 루트 계정처럼 상세 화면이 없는 대상은 null이다. */
function targetRoute(overview: IamOverview, kind: FindingKind, item: FindingItem): IamRoute | null {
  const route = routeForFocus(overview, item.targetArn);
  return route && route.view === "users" && KEY_KINDS.includes(kind) ? { ...route, tab: "keys" } : route;
}

export function Findings({ profile, overview, onOpen, onFix, initialKind, onViewState }: Props) {
  const q = useFindings(profile);
  const [picked, setPicked] = useState<string | null>(initialKind ?? null);
  const data = q.data;

  if (!data) {
    return (
      <section className="center">
        {q.isError ? <ErrorState error={q.error} profile={profile} onRetry={() => void q.refetch()} /> : <div className="empty">점검하는 중…</div>}
      </section>
    );
  }

  // 고른 카드가 없거나 지금은 문제가 없으면 문제가 있는 첫 항목을 보여준다
  const current = data.groups.find((g) => g.kind === picked && g.items.length > 0) ?? data.groups.find((g) => g.items.length > 0) ?? null;
  const pick = (kind: FindingKind) => {
    setPicked(kind);
    onViewState?.({ tab: kind });
  };

  return (
    <section className="center fx">
      {q.isError && <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} />}
      {data.warnings.length > 0 && (
        <ul className="iam-warn" aria-label="점검 경고">
          {data.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {data.generatedAt && <div className="fx-time dim">기준 {formatDateTime(data.generatedAt)}</div>}
      <div className="fx-cards" role="group" aria-label="점검 항목">
        {data.groups.map((g) => (
          <Card key={g.kind} group={g} selected={g === current} onPick={() => pick(g.kind)} />
        ))}
      </div>
      {current ? (
        <Items group={current} overview={overview} onOpen={onOpen} onFix={onFix} />
      ) : (
        <div className="empty small">발견된 문제가 없어요</div>
      )}
    </section>
  );
}

function Card({ group, selected, onPick }: { group: FindingGroup; selected: boolean; onPick: () => void }) {
  const n = group.items.length;
  return (
    <button
      className={`fx-card ${group.level}${n === 0 ? " empty" : ""}${selected ? " on" : ""}`}
      data-kind={group.kind}
      aria-pressed={selected}
      disabled={n === 0}
      onClick={onPick}
    >
      <span className="fx-title">{group.title}</span>
      {n === 0 ? (
        <span className="fx-ok">문제 없음</span>
      ) : (
        <span className="fx-count">
          <b className="fx-n">
            {n}
            <small>건</small>
          </b>
          <span className={`iam-badge ${group.level}`}>{LEVEL_TEXT[group.level]}</span>
        </span>
      )}
    </button>
  );
}

function Items({ group, overview, onOpen, onFix }: { group: FindingGroup; overview: IamOverview } & Pick<Props, "onOpen" | "onFix">) {
  return (
    <div className="fx-items">
      <h3 className="fx-items-title">
        {group.title} <span className="dim">{group.items.length}건</span>
      </h3>
      <table aria-label="점검 대상">
        <thead>
          <tr>
            <th scope="col" className="nosort">대상</th>
            <th scope="col" className="nosort">내용</th>
            <th scope="col" className="nosort">조치</th>
          </tr>
        </thead>
        <tbody>
          {group.items.map((item, i) => {
            const route = targetRoute(overview, group.kind, item);
            return (
              <tr key={`${item.targetArn}|${i}`}>
                <td>
                  {route ? (
                    <button className="link" onClick={() => onOpen(route)}>
                      {item.targetName}
                    </button>
                  ) : (
                    <span>{item.targetName}</span>
                  )}
                </td>
                <td>
                  <div>{item.detail}</div>
                  {item.cli && <code className="fx-cli mono dim">{item.cli}</code>}
                </td>
                <td className="fx-act">
                  {item.cli && (
                    <button className="btn small" onClick={() => void desktop.copy(item.cli!)}>
                      CLI 복사
                    </button>
                  )}
                  {item.fix && (
                    <button className="btn small" disabled={!onFix} title={onFix ? undefined : "변경 기능은 곧 추가돼요"} onClick={() => onFix?.(item.fix!)}>
                      {fixLabel(item.fix)}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
