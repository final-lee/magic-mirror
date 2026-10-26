import { useMemo, useState } from "react";
import { BadgeList } from "./Badges";
import { PickerSheet, type PickerOption } from "./PickerSheet";
import type { PrincipalSummary } from "./types";

function matches(p: PrincipalSummary, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  return !f || p.name.toLowerCase().includes(f) || p.path.toLowerCase().includes(f);
}

const byName = (a: PrincipalSummary, b: PrincipalSummary) => a.name.localeCompare(b.name, "ko", { sensitivity: "base" });

interface PrincipalPickerProps {
  title: string;
  intro: string;
  searchLabel: string;
  /** 고를 수 있는 후보(개요에 있는 목록). 이름순으로 보여준다 */
  items: PrincipalSummary[];
  /** 이미 속해 있어 고를 수 없는 이름들 */
  taken: string[];
  takenReason: string;
  detail: (p: PrincipalSummary) => string;
  empty: { none: string; noMatch: string };
  onPick: (p: PrincipalSummary) => void;
  onClose: () => void;
}

function PrincipalPicker({ title, intro, searchLabel, items, taken, takenReason, detail, empty, onPick, onClose }: PrincipalPickerProps) {
  const [query, setQuery] = useState("");
  const sorted = useMemo(() => [...items].sort(byName), [items]);
  const takenSet = new Set(taken);
  const options: PickerOption[] = sorted
    .filter((p) => matches(p, query))
    .map((p) => ({
      id: p.name,
      name: p.name,
      meta: <BadgeList badges={p.badges} />,
      detail: detail(p),
      disabledReason: takenSet.has(p.name) ? takenReason : undefined,
    }));

  return (
    <PickerSheet
      title={title}
      intro={intro}
      searchLabel={searchLabel}
      placeholder="이름으로 찾기"
      query={query}
      onQuery={setQuery}
      options={options}
      onPick={(name) => {
        const found = items.find((p) => p.name === name);
        if (found) onPick(found);
      }}
      onClose={onClose}
      empty={items.length === 0 ? empty.none : empty.noMatch}
    />
  );
}

interface GroupPickerProps {
  groups: PrincipalSummary[];
  /** 사용자가 이미 속한 그룹 이름 */
  memberOf: string[];
  userName: string;
  onPick: (group: PrincipalSummary) => void;
  onClose: () => void;
}

/** 사용자를 넣을 그룹을 고른다. 후보는 개요에 있는 그룹이다. */
export function GroupPicker({ groups, memberOf, userName, onPick, onClose }: GroupPickerProps) {
  return (
    <PrincipalPicker
      title="그룹에 추가"
      intro={`넣을 그룹을 고르세요 (사용자: ${userName})`}
      searchLabel="그룹 검색"
      items={groups}
      taken={memberOf}
      takenReason="이미 소속돼 있어요"
      detail={(g) => `구성원 ${g.memberCount ?? 0}명 · 정책 ${g.policyCount}개`}
      empty={{ none: "그룹이 없어요", noMatch: "조건에 맞는 그룹이 없어요" }}
      onPick={onPick}
      onClose={onClose}
    />
  );
}

interface UserPickerProps {
  users: PrincipalSummary[];
  /** 그룹의 현재 구성원 이름 */
  members: string[];
  groupName: string;
  onPick: (user: PrincipalSummary) => void;
  onClose: () => void;
}

/** 그룹에 넣을 사용자를 고른다. 후보는 개요에 있는 사용자다. */
export function UserPicker({ users, members, groupName, onPick, onClose }: UserPickerProps) {
  return (
    <PrincipalPicker
      title="사용자 추가"
      intro={`넣을 사용자를 고르세요 (그룹: ${groupName})`}
      searchLabel="사용자 검색"
      items={users}
      taken={members}
      takenReason="이미 구성원이에요"
      detail={(u) => `정책 ${u.policyCount}개`}
      empty={{ none: "사용자가 없어요", noMatch: "조건에 맞는 사용자가 없어요" }}
      onPick={onPick}
      onClose={onClose}
    />
  );
}
