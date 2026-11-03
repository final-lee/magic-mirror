import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../../test/utils";
import { accessApi } from "./api";
import { grant, group, iam, user } from "./fixtures";
import { WhoCanTab } from "./WhoCanTab";
import { CHECK_BUTTON, CHECK_DENIED_TITLE, CHECK_SKIPPED, FIND, MISMATCH_TEXT, NO_RESULT, REQUEST_INVALID, checkSummary, resultsTruncated } from "./text";
import type { WhoCan } from "./types";

vi.mock("./api", () => ({ accessApi: { whoCan: vi.fn(), review: vi.fn() } }));
vi.mock("../../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(accessApi);
const T = { profile: "app", region: "r", cluster: "who" };

const entry = (subject: WhoCan["subject"], grants = [grant(null)]): WhoCan => ({ subject, label: null, grants });

function setup(over: { canReview?: "yes" | "no" | "unknown"; onOpenIam?: (arn: string) => void } = {}) {
  return render(
    withClientAndSso(
      <WhoCanTab target={T} context="ctx" ssoProfile="p" namespaces={["dev", "prod"]} canReview={over.canReview ?? "yes"} onOpenIam={over.onOpenIam} initial={{ verb: "get", resource: "", namespace: null }} />,
      newQueryClient(),
      ssoLoginStub(),
    ),
  );
}

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  m.whoCan.mockResolvedValue({ total: 2, entries: [entry(user("alice")), entry(group("devs"), [grant("dev", { via: { kind: "group", group: "devs" } }), grant("prod")])] });
  m.review.mockResolvedValue({ allowed: true, denied: false, reason: null });
});

test("the resource is typed the kubectl way and split into group, resource and subresource", async () => {
  setup();
  fill("리소스", "deployments.apps/scale");
  fill("동사", "patch");
  fill("네임스페이스", "dev");
  fill("이름(선택)", "web");
  fireEvent.click(screen.getByRole("button", { name: FIND }));
  await waitFor(() => expect(m.whoCan).toHaveBeenCalledWith(T, { verb: "patch", group: "apps", resource: "deployments", subresource: "scale", namespace: "dev", name: "web" }, "p"));
});

test("an empty resource is refused before anything is sent", () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: FIND }));
  expect(screen.getByText(REQUEST_INVALID)).toBeInTheDocument();
  expect(m.whoCan).not.toHaveBeenCalled();
});

test("a preset fills the form and asks right away", async () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Pod 접속(exec)" }));
  await waitFor(() => expect(m.whoCan).toHaveBeenCalledWith(T, expect.objectContaining({ verb: "create", resource: "pods", subresource: "exec", namespace: null }), "p"));
  expect(screen.getByLabelText("리소스")).toHaveValue("pods/exec");
});

test("subjects are listed with the first path and how many more there are; clicking one shows every path", async () => {
  setup();
  fill("리소스", "pods");
  fireEvent.click(screen.getByRole("button", { name: FIND }));
  const row = (await screen.findByText("devs")).closest("tr")!;
  expect(within(row).getByText("외 1개")).toBeInTheDocument();
  fireEvent.click(row);
  const pane = screen.getByRole("complementary", { name: "권한 상세" });
  expect(within(pane).getAllByRole("listitem")).toHaveLength(2);
  fireEvent.click(row);
  expect(screen.queryByRole("complementary", { name: "권한 상세" })).not.toBeInTheDocument();
});

test("no subject and a cut list are both said out loud", async () => {
  m.whoCan.mockResolvedValueOnce({ total: 0, entries: [] });
  setup();
  fill("리소스", "pods");
  fireEvent.click(screen.getByRole("button", { name: FIND }));
  expect(await screen.findByText(NO_RESULT)).toBeInTheDocument();
  m.whoCan.mockResolvedValueOnce({ total: 1500, entries: [entry(user("a"))] });
  fill("리소스", "secrets");
  fireEvent.click(screen.getByRole("button", { name: FIND }));
  expect(await screen.findByText(resultsTruncated(1, 1500))).toBeInTheDocument();
});

test("cross-checking sends one review per subject and marks the ones the cluster denies", async () => {
  m.review.mockImplementation(async (_t, _q, subject) => ({ allowed: subject.name !== "devs", denied: false, reason: null }));
  setup();
  fill("리소스", "pods");
  fireEvent.click(screen.getByRole("button", { name: FIND }));
  await screen.findByText("devs");
  fireEvent.click(screen.getByRole("button", { name: CHECK_BUTTON }));
  expect(await screen.findByText(checkSummary(1, 1, 0))).toBeInTheDocument();
  expect(m.review).toHaveBeenCalledTimes(2);
  expect(m.review).toHaveBeenCalledWith(T, expect.objectContaining({ resource: "pods" }), group("devs"), "p");
  const bad = screen.getByText("devs").closest("tr")!;
  expect(within(bad).getByText(new RegExp(MISMATCH_TEXT))).toBeInTheDocument();
});

test("a subject whose permission depends on the session name is not cross-checked, and one failing review does not stop the rest", async () => {
  const arn = "arn:aws:iam::1:role/ops";
  m.whoCan.mockResolvedValue({ total: 2, entries: [entry(iam(arn), [grant(null, { sessionDependent: true })]), entry(user("alice"))] });
  m.review.mockRejectedValue(new Error("boom"));
  setup();
  fill("리소스", "pods");
  fireEvent.click(screen.getByRole("button", { name: FIND }));
  await screen.findByText("alice");
  fireEvent.click(screen.getByRole("button", { name: CHECK_BUTTON }));
  expect(await screen.findByText(checkSummary(0, 0, 1))).toBeInTheDocument();
  expect(m.review).toHaveBeenCalledTimes(1);
  expect(screen.getByText(CHECK_SKIPPED)).toBeInTheDocument();
});

test("without permission to create reviews the button is disabled with the reason", async () => {
  setup({ canReview: "no" });
  fill("리소스", "pods");
  fireEvent.click(screen.getByRole("button", { name: FIND }));
  await screen.findByText("alice");
  const button = screen.getByRole("button", { name: CHECK_BUTTON });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("title", CHECK_DENIED_TITLE);
});

test("a new question throws away the previous cross-check", async () => {
  setup();
  fill("리소스", "pods");
  fireEvent.click(screen.getByRole("button", { name: FIND }));
  await screen.findByText("alice");
  fireEvent.click(screen.getByRole("button", { name: CHECK_BUTTON }));
  await screen.findByText(checkSummary(2, 0, 0));
  fill("리소스", "secrets");
  fireEvent.click(screen.getByRole("button", { name: FIND }));
  await waitFor(() => expect(screen.queryByText(checkSummary(2, 0, 0))).not.toBeInTheDocument());
});

test("an IAM subject's detail opens its role in IAM", async () => {
  const onOpenIam = vi.fn();
  m.whoCan.mockResolvedValue({ total: 1, entries: [entry(iam("arn:aws:iam::1:role/ops"))] });
  setup({ onOpenIam });
  fill("리소스", "pods");
  fireEvent.click(screen.getByRole("button", { name: FIND }));
  fireEvent.click((await screen.findByText("ops")).closest("tr")!);
  fireEvent.click(within(screen.getByRole("complementary", { name: "권한 상세" })).getByRole("button", { name: "IAM에서 열기" }));
  expect(onOpenIam).toHaveBeenCalledWith("arn:aws:iam::1:role/ops");
});
