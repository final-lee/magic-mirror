import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../../test/utils";
import { accessApi } from "./api";
import { accessView, grant, iam, mapping, sa, user } from "./fixtures";
import { MatrixTab, PAGE_SIZE } from "./MatrixTab";
import { CELL_LABELS, CLUSTER_WIDE, COLUMNS_LIMIT, NAMESPACES_LABEL, NEXT, NO_ROWS, PREV, cellLabel } from "./text";
import type { CellDetail, MatrixPage, MatrixQuery } from "./types";
import { findFor, findInputs } from "../testFind";

vi.mock("./api", () => ({ accessApi: { matrix: vi.fn(), cell: vi.fn() } }));
vi.mock("../../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(accessApi);
const T = { profile: "app", region: "r", cluster: "matrix" };
const ARN = "arn:aws:iam::1:role/ops";

const page = (rows: MatrixPage["rows"], total = rows.length): MatrixPage => ({ total, rows });
const lastQuery = (): MatrixQuery => m.matrix.mock.calls[m.matrix.mock.calls.length - 1][1];

const detail: CellDetail = {
  subject: user("alice"),
  namespace: "dev",
  cell: "write",
  level: 1,
  probes: [
    { query: { verb: "create", group: "", resource: "pods", subresource: null, namespace: "dev", name: null }, allowed: true, namesOnly: false, direct: true, grants: [grant("dev")] },
    { query: { verb: "delete", group: "", resource: "pods", subresource: null, namespace: "dev", name: null }, allowed: false, namesOnly: false, direct: true, grants: [] },
  ],
};

function setup(over: { namespace?: string | null; initialText?: string; onOpenIam?: (arn: string) => void } = {}) {
  const view = accessView({ namespaces: ["default", "dev", "prod"], mappings: [mapping(ARN, { username: "ops:{{SessionName}}", groups: ["devs"] })] });
  const qc = newQueryClient();
  return render(
    withClientAndSso(<MatrixTab target={T} context="ctx" ssoProfile="p" live view={view} namespace={"namespace" in over ? over.namespace! : "dev"} initialText={over.initialText} onOpenIam={over.onOpenIam} />, qc, ssoLoginStub()),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  m.matrix.mockResolvedValue(page([{ subject: user("alice"), label: null, levels: [[0, 0, 0, 0, 0, 0, 0], [2, 1, 0, 0, 0, 0, 0]] }]));
  m.cell.mockResolvedValue(detail);
});

test("the first columns are the cluster-wide column and the chosen namespace, and each cell says its level", async () => {
  setup();
  expect(await screen.findByRole("button", { name: cellLabel("alice", "dev", "read", 2) })).toBeInTheDocument();
  expect(lastQuery()).toMatchObject({ namespaces: [null, "dev"], kinds: [], text: "", offset: 0, limit: PAGE_SIZE });
  expect(screen.getByRole("button", { name: cellLabel("alice", "dev", "write", 1) })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: cellLabel("alice", CLUSTER_WIDE, "escalate", 0) })).toBeInTheDocument();
});

test("the escalation cell speaks of indirect and direct paths instead of some and all", async () => {
  m.matrix.mockResolvedValue(page([{ subject: user("alice"), label: null, levels: [[0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 2]] }]));
  setup();
  expect(await screen.findByRole("button", { name: cellLabel("alice", CLUSTER_WIDE, "escalate", 1) })).toHaveAccessibleName(/간접 경로/);
  expect(screen.getByRole("button", { name: cellLabel("alice", "dev", "escalate", 2) })).toHaveAccessibleName(/직접 경로/);
});

test("with all namespaces chosen the columns start from the first few namespaces", async () => {
  setup({ namespace: null });
  await screen.findByRole("table");
  expect(lastQuery().namespaces).toEqual([null, "default", "dev", "prod"]);
});

test("subject kind chips and the ⌘F name find narrow the query and go back to the first page", async () => {
  m.matrix.mockResolvedValue(page([{ subject: user("alice"), label: null, levels: [[0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]] }], 60));
  setup();
  await screen.findByRole("table");
  fireEvent.click(screen.getByRole("button", { name: NEXT }));
  await waitFor(() => expect(lastQuery().offset).toBe(PAGE_SIZE));
  fireEvent.click(screen.getByLabelText("ServiceAccount"));
  await waitFor(() => expect(lastQuery()).toMatchObject({ kinds: ["serviceAccount"], offset: 0 }));
  expect(findInputs()).toHaveLength(0);
  findFor(" ops ");
  await waitFor(() => expect(lastQuery().text).toBe("ops"));
});

test("a long list is paged, and the pager stops at both ends", async () => {
  m.matrix.mockResolvedValue(page([{ subject: user("alice"), label: null, levels: [[0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]] }], PAGE_SIZE + 5));
  setup();
  await screen.findByRole("table");
  expect(screen.getByRole("button", { name: PREV })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: NEXT }));
  await waitFor(() => expect(lastQuery().offset).toBe(PAGE_SIZE));
  expect(screen.getByRole("button", { name: NEXT })).toBeDisabled();
  expect(screen.getByText(`${PAGE_SIZE + 1}–${PAGE_SIZE + 5} / ${PAGE_SIZE + 5}`)).toBeInTheDocument();
});

test("a short list has no pager and an empty result says so", async () => {
  m.matrix.mockResolvedValue(page([]));
  setup();
  expect(await screen.findByText(NO_ROWS)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: NEXT })).not.toBeInTheDocument();
});

test("clicking a cell opens its detail with the paths, clicking it again or an empty spot closes it", async () => {
  setup();
  fireEvent.click(await screen.findByRole("button", { name: cellLabel("alice", "dev", "write", 1) }));
  await waitFor(() => expect(m.cell).toHaveBeenCalledWith(T, user("alice"), "write", "dev", "p"));
  const pane = await screen.findByRole("complementary", { name: "권한 상세" });
  expect(within(pane).getByText(CELL_LABELS.write)).toBeInTheDocument();
  expect(within(pane).getByText("RoleBinding dev/b")).toBeInTheDocument();
  expect(within(pane).getByText("허용")).toBeInTheDocument();
  expect(within(pane).getByText("없음", { selector: ".acc-badge" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: cellLabel("alice", "dev", "write", 1) }));
  expect(screen.queryByRole("complementary", { name: "권한 상세" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: cellLabel("alice", "dev", "read", 2) }));
  await screen.findByRole("complementary", { name: "권한 상세" });
  fireEvent.click(screen.getByRole("table").parentElement!);
  expect(screen.queryByRole("complementary", { name: "권한 상세" })).not.toBeInTheDocument();
});

test("an IAM cell detail shows the Kubernetes identity and opens the role in IAM", async () => {
  const onOpenIam = vi.fn();
  m.matrix.mockResolvedValue(page([{ subject: iam(ARN), label: "ops", levels: [[0, 0, 0, 0, 0, 0, 0], [2, 0, 0, 0, 0, 0, 0]] }]));
  setup({ onOpenIam });
  fireEvent.click(await screen.findByRole("button", { name: cellLabel(ARN, "dev", "read", 2) }));
  const pane = await screen.findByRole("complementary", { name: "권한 상세" });
  expect(await within(pane).findByText("ops:{{SessionName}} · devs")).toBeInTheDocument();
  fireEvent.click(within(pane).getByRole("button", { name: "IAM에서 열기" }));
  expect(onOpenIam).toHaveBeenCalledWith(ARN);
});

test("the namespace picker searches, caps the number of columns and can reset them", async () => {
  m.matrix.mockResolvedValue(page([{ subject: sa("dev", "x"), label: null, levels: [[0, 0, 0, 0, 0, 0, 0]] }]));
  setup({ namespace: null });
  await screen.findByRole("table");
  fireEvent.click(screen.getByRole("button", { name: /네임스페이스 \d개/ }));
  const pop = screen.getByRole("dialog", { name: NAMESPACES_LABEL });
  fireEvent.change(within(pop).getByLabelText("네임스페이스 찾기"), { target: { value: "pro" } });
  expect(within(pop).getAllByRole("checkbox")).toHaveLength(2); // 클러스터 전체 + prod
  fireEvent.click(within(pop).getByLabelText("prod"));
  await waitFor(() => expect(lastQuery().namespaces).not.toContain("prod"));
  fireEvent.click(within(pop).getByRole("button", { name: "모두 빼기" }));
  await waitFor(() => expect(lastQuery().namespaces).toEqual([null]));
  expect(COLUMNS_LIMIT).toBeGreaterThan(2);
});
