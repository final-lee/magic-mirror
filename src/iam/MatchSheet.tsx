import { useEffect, useMemo, useRef, useState } from "react";
import { matchPrincipal, policyName, type AssignmentTab } from "./assignments";
import { KIND_LABEL } from "./labels";
import { PickerSheet, type PickerOption } from "./PickerSheet";
import type { IamOverview, PrincipalSummary } from "./types";
import { useModal } from "./useModal";

const TITLE = "다른 주체와 같게";

/** 탭마다 달라지는 말: 붙일(넣을) 것과 뗄(뺄) 것 */
const SECTION: Record<AssignmentTab, { add: string; remove: string }> = {
  policies: { add: "붙일 것", remove: "뗄 것" },
  members: { add: "넣을 것", remove: "뺄 것" },
};

interface Props {
  overview: IamOverview;
  tab: AssignmentTab;
  /** 맞출 대상. 부르는 쪽이 ARN으로 지금의 개요에서 찾아 넘긴다 */
  target: PrincipalSummary;
  /** 원본으로 고를 수 있는 주체들(보여 줄 순서대로). 대상 자신은 빼고 보여 준다 */
  candidates: PrincipalSummary[];
  /** [담기]: 붙일(넣을) 열과, 체크한 뗄(뺄) 열 */
  onApply: (add: string[], remove: string[]) => void;
  onClose: () => void;
}

/**
 * "다른 주체와 같게": 먼저 원본을 고르고, 원본에만 있는 것(붙일 것)과 대상에만 있는 것(뗄 것)을 보여 준다.
 * 붙일 것은 늘 담기고, 뗄 것은 체크한 것만 담긴다. 처음에는 아무것도 체크하지 않는다.
 * 원본은 고른 순간의 객체가 아니라 ARN으로 들고, 그릴 때마다 지금의 후보에서 다시 찾는다: 시트가 열려 있는 동안 개요를 다시 읽으면
 * 주체의 정책과 그룹이 달라져 있을 수 있다. 원본이 개요에서 없어졌으면 시트를 닫는다.
 */
export function MatchSheet({ overview, tab, target, candidates, onApply, onClose }: Props) {
  const [sourceArn, setSourceArn] = useState<string | null>(null);
  const source = sourceArn ? candidates.find((p) => p.arn === sourceArn) : undefined;
  const gone = sourceArn !== null && !source;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (sourceArn === null) return <SourcePicker tab={tab} target={target} candidates={candidates} onPick={(picked) => setSourceArn(picked.arn)} onClose={onClose} />;
  if (!source) return null;
  return <MatchDiff overview={overview} tab={tab} target={target} source={source} onApply={onApply} onClose={onClose} />;
}

function SourcePicker({ tab, target, candidates, onPick, onClose }: Pick<Props, "tab" | "target" | "candidates" | "onClose"> & { onPick: (source: PrincipalSummary) => void }) {
  const [query, setQuery] = useState("");
  const options = useMemo<PickerOption[]>(() => {
    const f = query.trim().toLowerCase();
    return candidates
      .filter((p) => p.arn !== target.arn && (!f || p.name.toLowerCase().includes(f)))
      .map((p) => ({ id: p.arn, name: p.name, meta: tab === "policies" ? <span className="iam-chip">{KIND_LABEL[p.kind]}</span> : undefined }));
  }, [candidates, target.arn, query, tab]);

  return (
    <PickerSheet
      title="원본 고르기"
      intro={`같게 만들 대상: ${target.name}`}
      searchLabel="주체 검색"
      placeholder="이름으로 찾기"
      query={query}
      onQuery={setQuery}
      options={options}
      onPick={(arn) => {
        const picked = candidates.find((p) => p.arn === arn);
        if (picked) onPick(picked);
      }}
      onClose={onClose}
      empty="고를 수 있는 주체가 없어요"
    />
  );
}

function MatchDiff({ overview, tab, target, source, onApply, onClose }: Pick<Props, "overview" | "tab" | "target" | "onApply" | "onClose"> & { source: PrincipalSummary }) {
  const { add, extra } = useMemo(() => matchPrincipal(overview, tab, source, target), [overview, tab, source, target]);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const { sheetRef, trapTab } = useModal(onClose);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // 처음 초점은 취소에 둔다. 원본을 고르던 Enter가 그대로 [담기]를 누르지 않게
  useEffect(() => cancelRef.current?.focus(), []);

  const section = SECTION[tab];
  const nameOf = (id: string) => (tab === "policies" ? policyName(overview, id) : id);
  const toggle = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const remove = extra.filter((id) => ticked.has(id));

  return (
    <div className="modal">
      <div className="sheet pk asg-match" role="dialog" aria-modal="true" aria-label={TITLE} ref={sheetRef} onKeyDown={trapTab}>
        <h3>{TITLE}</h3>
        <p>{`대상 ${target.name} · 원본 ${source.name}`}</p>
        <h4>{section.add}</h4>
        <ul className="asg-match-list" aria-label={section.add}>
          {add.length === 0 ? (
            <li className="dim">없어요</li>
          ) : (
            add.map((id) => (
              <li key={id}>
                <span>{nameOf(id)}</span>
              </li>
            ))
          )}
        </ul>
        <h4>{section.remove}</h4>
        <ul className="asg-match-list" aria-label={section.remove}>
          {extra.length === 0 ? (
            <li className="dim">없어요</li>
          ) : (
            extra.map((id) => (
              <li key={id}>
                <label>
                  <input type="checkbox" checked={ticked.has(id)} onChange={() => toggle(id)} />
                  <span>{nameOf(id)}</span>
                </label>
              </li>
            ))
          )}
        </ul>
        <div className="foot">
          <button className="btn plain" ref={cancelRef} onClick={onClose}>
            취소
          </button>
          <button className="btn primary" disabled={add.length === 0 && remove.length === 0} onClick={() => onApply(add, remove)}>
            담기
          </button>
        </div>
      </div>
    </div>
  );
}
