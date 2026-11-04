import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../../test/utils";
import { k8sApi } from "../api";
import { AccessScreen } from "./AccessScreen";
import { accessApi } from "./api";
import { accessView, grant, mapping } from "./fixtures";
import { MY_PERMISSIONS, RBAC_MISSING, REFRESH, SCOPE_NOTE, TAB_IDENTITIES, TAB_MATRIX, TAB_WHO_CAN, TAB_WORKLOAD } from "./text";
import { findInput } from "../testFind";

vi.mock("./api", () => ({ accessApi: { access: vi.fn(), matrix: vi.fn(), cell: vi.fn(), whoCan: vi.fn(), review: vi.fn(), workloadIdentity: vi.fn() } }));
vi.mock("../api", () => ({ k8sApi: { rules: vi.fn() } }));
vi.mock("../../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(accessApi);
const T = { profile: "app", region: "r", cluster: "screen" };
const CI = "arn:aws:iam::1:role/ci";

function setup(over: { onOpenMyRules?: () => void } = {}) {
  const qc = newQueryClient();
  return render(withClientAndSso(<AccessScreen target={T} context="ctx" ssoProfile="p" live namespace="dev" onOpenMyRules={over.onOpenMyRules ?? (() => {})} />, qc, ssoLoginStub()));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.access.mockResolvedValue(accessView({ mappings: [mapping(CI)] }));
  m.matrix.mockResolvedValue({ total: 0, rows: [] });
  m.workloadIdentity.mockResolvedValue({ items: [], oidcIssuer: null, truncated: false, gaps: [] });
  vi.mocked(k8sApi.rules).mockResolvedValue({ namespace: "default", resourceRules: [], nonResourceRules: [], incomplete: false });
});

test("the scope of what is computed is always written at the top, on every tab", async () => {
  setup();
  expect(await screen.findByText(CI)).toBeInTheDocument();
  expect(screen.getByRole("note")).toHaveTextContent(SCOPE_NOTE);
  for (const tab of [TAB_MATRIX, TAB_WHO_CAN, TAB_WORKLOAD, TAB_IDENTITIES]) {
    fireEvent.click(screen.getByRole("tab", { name: tab }));
    expect(screen.getByRole("note")).toHaveTextContent(SCOPE_NOTE);
  }
});

test("the identity tab is the first and the access data is read once for all tabs", async () => {
  setup();
  expect(screen.getByRole("tab", { name: TAB_IDENTITIES })).toHaveAttribute("aria-selected", "true");
  await screen.findByText(CI);
  fireEvent.click(screen.getByRole("tab", { name: TAB_MATRIX }));
  fireEvent.click(screen.getByRole("tab", { name: TAB_IDENTITIES }));
  expect(m.access).toHaveBeenCalledTimes(1);
  expect(m.access).toHaveBeenCalledWith(T, false);
});

test("opening a subject from the identities jumps to the matrix filtered by that name", async () => {
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "권한 표" }));
  expect(screen.getByRole("tab", { name: TAB_MATRIX })).toHaveAttribute("aria-selected", "true");
  await waitFor(() => expect(m.matrix).toHaveBeenCalledWith(T, expect.objectContaining({ text: CI }), "p"));
  expect(findInput()).toHaveValue(CI);
});

test("my permissions is one click away", async () => {
  const onOpenMyRules = vi.fn();
  setup({ onOpenMyRules });
  fireEvent.click(await screen.findByRole("button", { name: MY_PERMISSIONS }));
  expect(onOpenMyRules).toHaveBeenCalled();
});

test("refreshing reads again with force and replaces what is shown", async () => {
  setup();
  await screen.findByText(CI);
  m.access.mockResolvedValue(accessView({ mappings: [mapping("arn:aws:iam::1:role/new")] }));
  fireEvent.click(screen.getByRole("button", { name: REFRESH }));
  expect(await screen.findByText("arn:aws:iam::1:role/new")).toBeInTheDocument();
  expect(m.access).toHaveBeenLastCalledWith(T, true);
});

test("a read failure is shown, but the workload tab does not depend on it", async () => {
  m.access.mockRejectedValue({ kind: "other", message: "RBAC을 읽지 못했어요" });
  setup();
  expect(await screen.findByText("RBAC을 읽지 못했어요")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: TAB_WORKLOAD }));
  await waitFor(() => expect(m.workloadIdentity).toHaveBeenCalled());
  expect(screen.queryByText("RBAC을 읽지 못했어요")).not.toBeInTheDocument();
});

test("without the RBAC objects the other tabs warn that only access policies are reflected", async () => {
  m.access.mockResolvedValue(accessView({ rbacAvailable: false }));
  setup();
  await screen.findByRole("tab", { name: TAB_MATRIX });
  await waitFor(() => expect(screen.getAllByText(RBAC_MISSING).length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole("tab", { name: TAB_MATRIX }));
  expect(screen.getAllByText(RBAC_MISSING)).toHaveLength(1);
});

test("who-can cross-check is disabled when this identity may not create access reviews", async () => {
  vi.mocked(k8sApi.rules).mockResolvedValue({ namespace: "default", resourceRules: [{ verbs: ["get"], apiGroups: [""], resources: ["pods"], resourceNames: [] }], nonResourceRules: [], incomplete: false });
  m.whoCan.mockResolvedValue({ total: 1, entries: [{ subject: { kind: "user", name: "alice", namespace: null }, label: null, grants: [grant(null)] }] });
  setup();
  fireEvent.click(await screen.findByRole("tab", { name: TAB_WHO_CAN }));
  fireEvent.change(screen.getByLabelText("리소스"), { target: { value: "pods" } });
  fireEvent.click(screen.getByRole("button", { name: "찾기" }));
  await screen.findByText("alice");
  await waitFor(() => expect(screen.getByRole("button", { name: /SubjectAccessReview/ })).toBeDisabled());
});
