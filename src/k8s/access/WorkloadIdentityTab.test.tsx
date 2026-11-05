import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../../test/utils";
import { accessApi } from "./api";
import { WorkloadIdentityTab } from "./WorkloadIdentityTab";
import { NO_WORKLOADS, ONLY_BROKEN, STATUS_BROKEN, STATUS_UNKNOWN, STATUS_WORKS, WORKLOAD_TRUNCATED, gapText, podsMore } from "./text";
import type { Check, WorkloadIdentity, WorkloadView } from "./types";
import { findFor } from "../testFind";

vi.mock("./api", () => ({ accessApi: { workloadIdentity: vi.fn() } }));
vi.mock("../../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(accessApi);
const T = { profile: "app", region: "r", cluster: "wl" };
const ROLE = "arn:aws:iam::1:role/team/payments";

const item = (over: Partial<WorkloadIdentity>): WorkloadIdentity => ({ namespace: "payments", serviceAccount: "api", exists: true, irsa: null, podIdentity: null, pods: [], podCount: 0, notes: [], ...over });
const view = (items: WorkloadIdentity[], over: Partial<WorkloadView> = {}): WorkloadView => ({ items, oidcIssuer: "https://oidc.example/id/X", truncated: false, gaps: [], ...over });

function setup(onOpenIam?: (arn: string) => void) {
  return render(withClientAndSso(<WorkloadIdentityTab target={T} context="ctx" ssoProfile="p" live onOpenIam={onOpenIam} />, newQueryClient(), ssoLoginStub()));
}

const WORKS: Check = { kind: "works" };
const BROKEN: Check = { kind: "broken", reasons: ["sub 조건이 없어요"] };

test("each service account shows its IRSA and Pod Identity roles with the result of the trust check", async () => {
  m.workloadIdentity.mockResolvedValue(
    view([
      item({ serviceAccount: "api", irsa: { roleArn: ROLE, audience: "sts.amazonaws.com", check: WORKS }, podCount: 3 }),
      item({ serviceAccount: "worker", irsa: { roleArn: "arn:aws:iam::1:role/w", audience: "sts.amazonaws.com", check: BROKEN } }),
      item({ namespace: "ops", serviceAccount: "etl", exists: false, podIdentity: { associationId: "a-1", roleArn: "arn:aws:iam::1:role/etl", targetRoleArn: null, check: { kind: "unknown", message: "권한 없음 (iam:GetRole)" } } }),
    ]),
  );
  setup();
  const api = (await screen.findByText("payments/api")).closest("tr")!;
  expect(within(api).getByText(STATUS_WORKS)).toBeInTheDocument();
  expect(within(api).getByText("3")).toBeInTheDocument();
  const worker = screen.getByText("payments/worker").closest("tr")!;
  const broken = within(worker).getByText(STATUS_BROKEN);
  expect(broken).toHaveAttribute("title", "sub 조건이 없어요");
  const etl = screen.getByText("ops/etl").closest("tr")!;
  expect(within(etl).getByText(STATUS_UNKNOWN)).toHaveAttribute("title", "권한 없음 (iam:GetRole)");
  expect(within(etl).getByText("ServiceAccount 없음")).toBeInTheDocument();
});

test("vim keys select workload identities and open their detail", async () => {
  m.workloadIdentity.mockResolvedValue(view([item({ serviceAccount: "api" }), item({ serviceAccount: "worker" })]));
  setup();
  const row = (await screen.findByText("payments/api")).closest("tr")!;
  const host = row.closest(".tbl")!;
  fireEvent.keyDown(host, { key: "j" });
  expect(row).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("complementary", { name: "워크로드 신원 상세" })).toHaveTextContent("payments/api");
  fireEvent.keyDown(host, { key: "G", shiftKey: true });
  expect(screen.getByRole("complementary", { name: "워크로드 신원 상세" })).toHaveTextContent("payments/worker");
});

test("only broken connections can be filtered, and ⌘F matches names and roles", async () => {
  m.workloadIdentity.mockResolvedValue(
    view([
      item({ serviceAccount: "api", irsa: { roleArn: ROLE, audience: "a", check: WORKS } }),
      item({ serviceAccount: "worker", irsa: { roleArn: "arn:aws:iam::1:role/w", audience: "a", check: BROKEN } }),
    ]),
  );
  setup();
  await screen.findByText("payments/api");
  fireEvent.click(screen.getByLabelText(ONLY_BROKEN));
  expect(screen.queryByText("payments/api")).not.toBeInTheDocument();
  expect(screen.getByText("payments/worker")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(ONLY_BROKEN));
  findFor("TEAM/PAY");
  expect(screen.getByText("payments/api")).toBeInTheDocument();
  expect(screen.queryByText("payments/worker")).not.toBeInTheDocument();
});

test("a role name opens the role in IAM without selecting the row", async () => {
  const onOpenIam = vi.fn();
  m.workloadIdentity.mockResolvedValue(view([item({ irsa: { roleArn: ROLE, audience: "a", check: WORKS } })]));
  setup(onOpenIam);
  fireEvent.click(await screen.findByRole("button", { name: /payments/ }));
  expect(onOpenIam).toHaveBeenCalledWith(ROLE);
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});

test("the detail lists why it does not work, the audience, the notes and the pods (cut after the shown ones)", async () => {
  m.workloadIdentity.mockResolvedValue(
    view([item({ irsa: { roleArn: ROLE, audience: "other.example.com", check: { kind: "broken", reasons: ["sub 조건이 없어요", "aud 조건이 맞지 않아요"] } }, pods: ["p-1", "p-2"], podCount: 45, notes: ["IRSA와 Pod Identity가 모두 있어요"] })]),
  );
  setup();
  const row = (await screen.findByText("payments/api")).closest("tr")!;
  fireEvent.click(row);
  const pane = screen.getByRole("complementary", { name: "워크로드 신원 상세" });
  expect(within(pane).getByText("sub 조건이 없어요")).toBeInTheDocument();
  expect(within(pane).getByText("aud 조건이 맞지 않아요")).toBeInTheDocument();
  expect(within(pane).getByText("other.example.com")).toBeInTheDocument();
  expect(within(pane).getByText("IRSA와 Pod Identity가 모두 있어요")).toBeInTheDocument();
  expect(within(pane).getByText(podsMore(2, 45))).toBeInTheDocument();
  fireEvent.click(row);
  expect(screen.queryByRole("complementary", { name: "워크로드 신원 상세" })).not.toBeInTheDocument();
});

test("unread parts and cut lists are reported while the rest is shown", async () => {
  m.workloadIdentity.mockResolvedValue(view([], { truncated: true, gaps: [{ section: "podIdentity", error: { kind: "other", message: "눈에 띄는 오류" } }] }));
  setup();
  expect(await screen.findByText(gapText("Pod Identity 연결"))).toBeInTheDocument();
  expect(screen.getByText("눈에 띄는 오류")).toBeInTheDocument();
  expect(screen.getByText(WORKLOAD_TRUNCATED)).toBeInTheDocument();
  expect(screen.getByText(NO_WORKLOADS)).toBeInTheDocument();
});

test("a failing read shows the error instead of an empty list", async () => {
  m.workloadIdentity.mockRejectedValue({ kind: "other", message: "연결이 끊겼어요" });
  setup();
  await waitFor(() => expect(screen.getByText("연결이 끊겼어요")).toBeInTheDocument());
});
