import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderWithClient } from "../test/utils";
import { iamApi } from "./api";
import { alice, appRole, bob, catalogActions, ciBot, deployPolicy, devTeam, sampleOverview, simulateResults, whoCanResult } from "./fixtures";
import type { WhoCanSearch } from "./route";
import { WhoCan } from "./WhoCan";

vi.mock("./api", () => ({ iamApi: { actions: vi.fn(), whoCan: vi.fn(), simulate: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(iamApi);

function setup(extra: Partial<React.ComponentProps<typeof WhoCan>> = {}) {
  const props = { onOpen: vi.fn(), onViewState: vi.fn() };
  const utils = renderWithClient(<WhoCan profile="prod" overview={sampleOverview()} {...props} {...extra} />);
  return { props, ...utils };
}

const actionBox = () => screen.getByRole("combobox", { name: "작업" });
const resourceBox = () => screen.getByRole("textbox", { name: "대상 ARN" });
const typeAction = (value: string) => fireEvent.change(actionBox(), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: "찾기" }));
const results = () => screen.findByRole("table", { name: "찾은 주체" });
async function searchFor(action = "s3:PutObject") {
  typeAction(action);
  submit();
  return results();
}
const rowOf = (name: string) => screen.getByRole("button", { name }).closest("tr") as HTMLElement;
/** 표의 네 번째 칸: AWS 정책 시뮬레이터가 알려 준 결과 */
const awsCell = (name: string) => within(rowOf(name)).getAllByRole("cell")[3];
const decisionOf = (name: string) => within(awsCell(name)).getByText(/^(허용|허용 안 됨|명시적 거부)$/).textContent;

beforeEach(() => {
  vi.clearAllMocks();
  m.actions.mockResolvedValue(catalogActions);
  m.whoCan.mockResolvedValue(whoCanResult());
  m.simulate.mockResolvedValue(simulateResults);
});

describe("search form", () => {
  test("picking a suggestion fills the action; 찾기 searches it without a resource", async () => {
    setup();
    typeAction("s3:put");
    fireEvent.click(await screen.findByRole("option", { name: "s3:PutObject" }));
    expect(actionBox()).toHaveValue("s3:PutObject");
    expect(m.whoCan).not.toHaveBeenCalled();

    submit();
    await results();
    expect(m.whoCan).toHaveBeenCalledWith("prod", "s3:PutObject", null);
  });

  test("↓ then Enter picks a suggestion and a second Enter searches", async () => {
    setup();
    typeAction("s3:get");
    await screen.findByRole("option", { name: "s3:GetObject" });
    fireEvent.keyDown(actionBox(), { key: "ArrowDown" });
    fireEvent.keyDown(actionBox(), { key: "ArrowDown" });
    fireEvent.keyDown(actionBox(), { key: "Enter" });
    expect(actionBox()).toHaveValue("s3:GetObjectAcl");
    expect(m.whoCan).not.toHaveBeenCalled();

    fireEvent.keyDown(actionBox(), { key: "Enter" });
    await results();
    expect(m.whoCan).toHaveBeenCalledWith("prod", "s3:GetObjectAcl", null);
  });

  test("the resource ARN is trimmed and sent along; Enter in its box searches too", async () => {
    setup();
    typeAction("s3:PutObject");
    fireEvent.change(resourceBox(), { target: { value: "  arn:aws:s3:::assets/a.txt  " } });
    fireEvent.keyDown(resourceBox(), { key: "Enter" });
    await results();
    expect(m.whoCan).toHaveBeenCalledWith("prod", "s3:PutObject", "arn:aws:s3:::assets/a.txt");
  });

  test("the typed action is trimmed", async () => {
    setup();
    await searchFor("  s3:PutObject ");
    expect(m.whoCan).toHaveBeenCalledWith("prod", "s3:PutObject", null);
  });

  test("pressing 찾기 again with the same condition asks again instead of doing nothing", async () => {
    setup();
    await searchFor();
    expect(m.whoCan).toHaveBeenCalledTimes(1);
    submit();
    await waitFor(() => expect(m.whoCan).toHaveBeenCalledTimes(2));
    await results();
  });

  test("찾기 stays disabled until there is an action to look for", () => {
    setup();
    expect(screen.getByRole("button", { name: "찾기" })).toBeDisabled();
    typeAction("   ");
    expect(screen.getByRole("button", { name: "찾기" })).toBeDisabled();
    fireEvent.keyDown(actionBox(), { key: "Enter" });
    expect(m.whoCan).not.toHaveBeenCalled();
    typeAction("s3:PutObject");
    expect(screen.getByRole("button", { name: "찾기" })).toBeEnabled();
  });

  test("still searches by typed name when the catalog cannot be read, and says why there are no suggestions", async () => {
    m.actions.mockRejectedValue({ kind: "network", message: "x" });
    setup();
    expect(await screen.findByText("작업 목록을 불러오지 못해서 자동 완성은 쓸 수 없어요")).toBeInTheDocument();
    await searchFor("s3:PutObject");
    expect(m.whoCan).toHaveBeenCalledWith("prod", "s3:PutObject", null);
  });
});

describe("results", () => {
  test("lists each principal with its kind, status chip and badges", async () => {
    setup();
    const table = within(await searchFor());
    const rows = table.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    const cells = (i: number) => within(rows[i]).getAllByRole("cell");

    expect(cells(0)[0]).toHaveTextContent("사용자");
    expect(cells(0)[0]).toHaveTextContent("alice");
    expect(cells(0)[1]).toHaveTextContent("허용");
    expect(cells(1)[0]).toHaveTextContent("역할");
    expect(cells(1)[0]).toHaveTextContent("app-role");
    expect(cells(1)[1]).toHaveTextContent("조건부");
    expect(cells(2)[1]).toHaveTextContent("경계로 차단");
    expect(cells(2)[0]).toHaveTextContent("관리자급"); // ci-bot의 배지
    expect(cells(3)[1]).toHaveTextContent("거부");
    expect(within(cells(0)[1]).getByText("허용")).toHaveClass("allowed");
    expect(within(cells(3)[1]).getByText("거부")).toHaveClass("denied");
  });

  test("shows where each grant comes from: policy, inheriting group, Sid or statement number, flags", async () => {
    setup();
    await searchFor();
    const aliceSources = within(rowOf("alice")).getByRole("list", { name: "근거" });
    expect(within(aliceSources).getByRole("button", { name: "app-deploy" })).toBeInTheDocument();
    expect(within(aliceSources).getByRole("button", { name: "dev-team" })).toBeInTheDocument();
    expect(aliceSources).toHaveTextContent("Deploy");

    const roleSources = within(rowOf("app-role")).getByRole("list", { name: "근거" });
    expect(roleSources).toHaveTextContent("문장 2"); // sid가 없으면 0부터 센 번호에 1을 더한다
    expect(roleSources).toHaveTextContent("조건 있음");

    expect(within(rowOf("ci-bot")).getByRole("list", { name: "근거" })).toHaveTextContent("권한 경계");

    const bobSources = within(rowOf("bob")).getByRole("list", { name: "근거" });
    expect(bobSources).toHaveTextContent("Deny");
    expect(bobSources).toHaveTextContent("NoPut");
  });

  test("echoes the action and resource that were searched, with the number of principals", async () => {
    m.whoCan.mockResolvedValue(whoCanResult({ resource: "arn:aws:s3:::assets/a.txt" }));
    setup();
    await searchFor();
    const summary = screen.getByTestId("who-can-summary");
    expect(summary).toHaveTextContent("s3:PutObject");
    expect(summary).toHaveTextContent("arn:aws:s3:::assets/a.txt");
    expect(summary).toHaveTextContent("4개");
  });

  test("shows the notes the backend sent", async () => {
    setup();
    await searchFor();
    expect(screen.getByText("사용자와 역할만 보여줘요. 그룹으로 받은 권한은 구성원에 합쳐서 계산해요")).toBeInTheDocument();
  });

  test("says so when nobody can, and there is nothing to confirm with AWS", async () => {
    m.whoCan.mockResolvedValue(whoCanResult({ hits: [] }));
    setup();
    typeAction("s3:PutObject");
    submit();
    expect(await screen.findByText("이 작업을 할 수 있는 사용자와 역할이 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "찾은 주체" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AWS로 확인" })).toBeDisabled();
  });

  test("shows a progress message while searching", async () => {
    let resolve!: (v: ReturnType<typeof whoCanResult>) => void;
    m.whoCan.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    typeAction("s3:PutObject");
    submit();
    expect(await screen.findByText("찾는 중…")).toBeInTheDocument();
    resolve(whoCanResult());
    await results();
    expect(screen.queryByText("찾는 중…")).not.toBeInTheDocument();
  });

  test("shows the error and retries", async () => {
    m.whoCan.mockRejectedValueOnce({ kind: "network", message: "timeout" });
    setup();
    typeAction("s3:PutObject");
    submit();
    expect(await screen.findByText("네트워크 오류: timeout")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await results();
    expect(m.whoCan).toHaveBeenCalledTimes(2);
  });
});

describe("navigation", () => {
  test("a principal opens its detail in the list matching its kind", async () => {
    const { props } = setup();
    await searchFor();
    fireEvent.click(screen.getByRole("button", { name: "alice" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "users", id: alice.arn });
    fireEvent.click(screen.getByRole("button", { name: "app-role" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "roles", id: appRole.arn });
  });

  test("a source opens its policy and the inheriting group opens the group", async () => {
    const { props } = setup();
    await searchFor();
    const sources = within(within(rowOf("alice")).getByRole("list", { name: "근거" }));
    fireEvent.click(sources.getByRole("button", { name: "app-deploy" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "policies", id: deployPolicy.id });
    fireEvent.click(sources.getByRole("button", { name: "dev-team" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "groups", id: devTeam.arn });
  });
});

describe("AWS로 확인", () => {
  test("simulates every listed principal with the searched action and merges the decision into each row", async () => {
    m.whoCan.mockResolvedValue(whoCanResult({ resource: "arn:aws:s3:::assets/a.txt" }));
    setup();
    await searchFor();
    expect(screen.queryByRole("columnheader", { name: "AWS 확인" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "AWS로 확인" }));
    expect(await screen.findByRole("columnheader", { name: "AWS 확인" })).toBeInTheDocument();
    expect(m.simulate).toHaveBeenCalledWith("prod", [alice.arn, appRole.arn, ciBot.arn, bob.arn], "s3:PutObject", "arn:aws:s3:::assets/a.txt");

    expect(["alice", "app-role", "ci-bot", "bob"].map(decisionOf)).toEqual(["허용", "허용", "허용 안 됨", "명시적 거부"]);
    expect(awsCell("app-role")).toHaveTextContent("aws:SourceIp"); // 시뮬레이터가 비어 있다고 알려 준 조건 키
    expect(awsCell("alice")).not.toHaveTextContent("aws:");
    expect(screen.getByRole("button", { name: "다시 확인" })).toBeEnabled();
  });

  test("matches decisions to rows by principal ARN, not by position", async () => {
    m.simulate.mockResolvedValue([...simulateResults].reverse().filter((r) => r.principalArn !== appRole.arn));
    setup();
    await searchFor();
    fireEvent.click(screen.getByRole("button", { name: "AWS로 확인" }));
    await screen.findByRole("columnheader", { name: "AWS 확인" });
    expect(decisionOf("alice")).toBe("허용");
    expect(decisionOf("bob")).toBe("명시적 거부");
    expect(awsCell("app-role")).toHaveTextContent("—"); // 결과가 없는 주체
  });

  test("shows progress while AWS answers and blocks a second click", async () => {
    let resolve!: (v: typeof simulateResults) => void;
    m.simulate.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    await searchFor();
    fireEvent.click(screen.getByRole("button", { name: "AWS로 확인" }));
    expect(await screen.findByText(/AWS 정책 시뮬레이터로 확인하는 중이에요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "확인하는 중…" })).toBeDisabled();
    resolve(simulateResults);
    await screen.findByRole("columnheader", { name: "AWS 확인" });
    expect(screen.queryByText(/확인하는 중이에요/)).not.toBeInTheDocument();
    expect(m.simulate).toHaveBeenCalledTimes(1);
  });

  test("a failed simulation shows the error and keeps the results", async () => {
    m.simulate.mockRejectedValue({ kind: "accessDenied", action: "iam:SimulatePrincipalPolicy" });
    setup();
    await searchFor();
    fireEvent.click(screen.getByRole("button", { name: "AWS로 확인" }));
    expect(await screen.findByText("권한 없음 (iam:SimulatePrincipalPolicy)")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "찾은 주체" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "AWS 확인" })).not.toBeInTheDocument();
  });

  test("a new search starts without the previous decisions", async () => {
    setup();
    await searchFor();
    fireEvent.click(screen.getByRole("button", { name: "AWS로 확인" }));
    await screen.findByRole("columnheader", { name: "AWS 확인" });

    m.whoCan.mockResolvedValue(whoCanResult({ action: "s3:GetObject", hits: [{ principal: alice, status: "allowed", sources: [] }] }));
    typeAction("s3:GetObject");
    submit();
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2));
    expect(screen.queryByRole("columnheader", { name: "AWS 확인" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AWS로 확인" })).toBeEnabled();
  });
});

describe("view state", () => {
  const search: WhoCanSearch = { action: "s3:PutObject", resource: "arn:aws:s3:::assets/*" };

  test("reports the search that was run so it can be restored later", async () => {
    const { props } = setup();
    typeAction("s3:PutObject");
    fireEvent.change(resourceBox(), { target: { value: "arn:aws:s3:::assets/*" } });
    expect(props.onViewState).not.toHaveBeenCalled();
    submit();
    await results();
    expect(props.onViewState).toHaveBeenLastCalledWith({ search });
  });

  test("an initial search fills the form and shows its results right away", async () => {
    setup({ initial: search });
    expect(actionBox()).toHaveValue("s3:PutObject");
    expect(resourceBox()).toHaveValue("arn:aws:s3:::assets/*");
    await results();
    expect(m.whoCan).toHaveBeenCalledWith("prod", "s3:PutObject", "arn:aws:s3:::assets/*");
  });

  test("coming back to the same search reuses the cached result and decisions", async () => {
    const { qc, rerender } = setup();
    await searchFor();
    fireEvent.click(screen.getByRole("button", { name: "AWS로 확인" }));
    await screen.findByRole("columnheader", { name: "AWS 확인" });

    const page = (node: ReactNode) => <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
    rerender(page(null));
    expect(screen.queryByRole("combobox", { name: "작업" })).not.toBeInTheDocument();
    rerender(page(<WhoCan profile="prod" overview={sampleOverview()} onOpen={vi.fn()} initial={{ action: "s3:PutObject", resource: "" }} />));
    await results();
    expect(screen.getByRole("columnheader", { name: "AWS 확인" })).toBeInTheDocument();
    expect(m.whoCan).toHaveBeenCalledTimes(1);
    expect(m.simulate).toHaveBeenCalledTimes(1);
  });
});
