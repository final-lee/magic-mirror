import { useState } from "react";
import { BadgeList } from "./Badges";
import { GroupPicker, UserPicker } from "./GroupPicker";
import { principalRoute, type IamRoute } from "./route";
import type { IamChange, IamOverview, PrincipalSummary } from "./types";

interface Props {
  /** groups: 사용자의 소속 그룹 · members: 그룹의 구성원 */
  kind: "groups" | "members";
  summary: PrincipalSummary;
  names: string[];
  overview: IamOverview;
  onOpen: (route: IamRoute) => void;
  onFix: (change: IamChange) => void;
}

/**
 * 사용자의 그룹 탭과 그룹의 구성원 탭. 이름을 누르면 상세로 가고, [빼기]와 [그룹에 추가]/[사용자 추가]는
 * addToGroup·removeFromGroup 변경을 변경 흐름에 넘긴다.
 */
export function MembershipPane({ kind, summary, names, overview, onOpen, onFix }: Props) {
  const [picking, setPicking] = useState(false);
  const ofUser = kind === "groups";
  const find = (name: string) => (ofUser ? overview.groups : overview.users).find((p) => p.name === name);
  const pair = (other: string) => (ofUser ? { userName: summary.name, groupName: other } : { userName: other, groupName: summary.name });

  return (
    <>
      <div className="pol-bar">
        <button className="btn small" onClick={() => setPicking(true)}>
          {ofUser ? "그룹에 추가" : "사용자 추가"}
        </button>
      </div>
      {names.length === 0 ? (
        <div className="empty small">{ofUser ? "소속된 그룹이 없어요" : "구성원이 없어요"}</div>
      ) : (
        <ul className="iam-names" aria-label={ofUser ? "소속 그룹" : "구성원"}>
          {names.map((name) => {
            const p = find(name);
            return (
              <li key={name}>
                {p ? (
                  <button className="link" onClick={() => onOpen(principalRoute(p.kind, p.arn))}>
                    {name}
                  </button>
                ) : (
                  <span>{name}</span>
                )}
                {p && <BadgeList badges={p.badges} />}
                <button className="btn small row-end" aria-label={`${name} 빼기`} onClick={() => onFix({ op: "removeFromGroup", ...pair(name) })}>
                  빼기
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {picking &&
        (ofUser ? (
          <GroupPicker
            groups={overview.groups}
            memberOf={names}
            userName={summary.name}
            onClose={() => setPicking(false)}
            onPick={(group) => {
              setPicking(false);
              onFix({ op: "addToGroup", ...pair(group.name) });
            }}
          />
        ) : (
          <UserPicker
            users={overview.users}
            members={names}
            groupName={summary.name}
            onClose={() => setPicking(false)}
            onPick={(user) => {
              setPicking(false);
              onFix({ op: "addToGroup", ...pair(user.name) });
            }}
          />
        ))}
    </>
  );
}
