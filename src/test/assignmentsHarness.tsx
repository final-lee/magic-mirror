// 시험용: 할당 화면을 IamTab 없이 띄우는 틀과, 표를 읽는 질의 모음.
// 틀은 진짜 장바구니 훅과, 툴바 필터를 흉내 내는 입력 상자를 가진다.
import { screen, within } from "@testing-library/react";
import { useState } from "react";
import type { AssignmentTab } from "../iam/assignments";
import { Assignments } from "../iam/AssignmentsScreen";
import type { IamRoute } from "../iam/route";
import type { IamChange, IamOverview } from "../iam/types";
import { useAssignmentDraft } from "../iam/useAssignmentDraft";

interface Props {
  /** 렌더마다 같은 객체여야 한다(react-query의 data처럼) */
  overview: IamOverview;
  profile?: string;
  initialTab?: AssignmentTab;
  onOpen?: (route: IamRoute) => void;
  onPreview?: (changes: IamChange[]) => void;
}

export function AssignmentsHarness({ overview, profile = "prod", initialTab = "policies", onOpen = () => {}, onPreview = () => {} }: Props) {
  const draft = useAssignmentDraft(profile, overview);
  const [tab, setTab] = useState<AssignmentTab>(initialTab);
  const [filter, setFilter] = useState("");
  // IAM 안의 다른 화면으로 갔다 돌아오는 일: 화면은 사라졌다 다시 생기고, 장바구니(draft)는 IamTab처럼 그대로다
  const [shown, setShown] = useState(true);
  return (
    <>
      <input aria-label="툴바 필터" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <button onClick={() => setShown((s) => !s)}>화면 전환</button>
      {shown && <Assignments key={profile} profile={profile} overview={overview} draft={draft} tab={tab} onTab={setTab} onOpen={onOpen} onPreview={onPreview} filter={filter} />}
    </>
  );
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 칸 버튼. 상태는 바뀌므로 이름의 앞부분(행 · 열: )만으로 찾는다 */
export const cellOf = (row: string, column: string) => screen.getByRole("button", { name: new RegExp(`^${esc(row)} · ${esc(column)}: `) });
export const grid = () => screen.getByRole("grid", { name: "할당 표" });
/** 아래쪽 막대의 요약 글. 장바구니가 비어 있으면 null */
export const tray = () => screen.queryByText(/^변경 \d+개 · /)?.textContent ?? null;
/** 표의 행 머리를 위에서부터: 종류 머리는 "사용자 3"처럼, 주체는 이름으로 */
export const rowHeads = () => within(grid()).getAllByRole("rowheader").map((h) => within(h).queryAllByRole("button")[0]?.textContent ?? h.textContent);
/** 주체 한 명의 행 */
export const rowOf = (name: string) => screen.getByRole("button", { name }).closest("tr") as HTMLElement;
