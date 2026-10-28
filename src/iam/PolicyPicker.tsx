import { useEffect, useMemo, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { BadgeList } from "./Badges";
import { PickerSheet, type PickerOption } from "./PickerSheet";
import { SCOPE_LABEL } from "./PolicyList";
import { usePolicyRefs } from "./queries";
import type { PolicyRef } from "./types";

/** 백엔드가 한 번에 돌려주는 최대 개수(계약: 최대 100) */
const MAX_RESULTS = 100;
const SEARCH_DELAY_MS = 250;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

interface Props {
  profile: string;
  /** 정책을 붙일 사용자·그룹·역할의 이름. 있으면 제목 아래에 대상을 알리는 안내를 보여 준다 */
  targetName?: string;
  /** 창 제목. 기본은 "정책 붙이기" */
  title?: string;
  /** 이미 붙어 있는 정책 ARN. 목록에는 보이지만 고를 수 없다 */
  attachedArns: string[];
  /** 고를 수 없는 정책 옆에 보이는 이유. 기본은 "이미 붙어 있어요" */
  disabledReason?: string;
  onPick: (policy: PolicyRef) => void;
  onClose: () => void;
}

/** 정책 붙이기 선택 창. 이름 일부를 입력하면 고객 관리형·AWS 관리형 정책에서 찾는다. */
export function PolicyPicker({ profile, targetName, title = "정책 붙이기", attachedArns, disabledReason = "이미 붙어 있어요", onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const term = useDebounced(query.trim(), SEARCH_DELAY_MS);
  const q = usePolicyRefs(profile, term);
  const refs = q.data;

  const options = useMemo<PickerOption[]>(() => {
    const attached = new Set(attachedArns);
    return (refs ?? []).map((p) => ({
      id: p.arn,
      name: p.name,
      meta: (
        <>
          <span className="iam-chip">{SCOPE_LABEL[p.scope]}</span>
          {/* 범위 칸이 이미 알려 주는 AWS 관리형은 되풀이하지 않는다 */}
          <BadgeList badges={p.badges} hide={["awsManaged"]} />
        </>
      ),
      detail: p.description,
      disabledReason: attached.has(p.arn) ? disabledReason : undefined,
    }));
  }, [refs, attachedArns, disabledReason]);

  const status = q.isError ? (
    <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} />
  ) : !refs ? (
    <div className="empty small">정책을 불러오는 중…</div>
  ) : undefined;

  return (
    <PickerSheet
      title={title}
      intro={targetName === undefined ? undefined : `붙일 정책을 고르세요 (대상: ${targetName})`}
      searchLabel="정책 검색"
      placeholder="정책 이름으로 찾기"
      query={query}
      onQuery={setQuery}
      options={options}
      onPick={(arn) => {
        const policy = refs?.find((p) => p.arn === arn);
        if (policy) onPick(policy);
      }}
      onClose={onClose}
      status={status}
      empty="조건에 맞는 정책이 없어요"
      footnote={refs && refs.length >= MAX_RESULTS ? `최대 ${MAX_RESULTS}개까지만 보여줘요. 이름을 더 입력해 좁혀 보세요` : undefined}
    />
  );
}
