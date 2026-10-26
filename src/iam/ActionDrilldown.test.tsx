import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { ActionDrilldown } from "./ActionDrilldown";
import { iamApi } from "./api";
import { alice, deployPolicy, s3WriteGrants, scratchInline } from "./fixtures";

vi.mock("./api", () => ({ iamApi: { principalActions: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(iamApi);
const cellInfo = { prefix: "s3", name: "Amazon S3", level: "write" as const };

function handlers() {
  return { onClose: vi.fn(), onOpenPolicy: vi.fn(), onOpenGroup: vi.fn() };
}
function setup() {
  const props = handlers();
  const utils = renderWithClient(<ActionDrilldown profile="prod" arn={alice.arn} cell={cellInfo} {...props} />);
  return { props, ...utils };
}
const item = (action: string) => screen.getByText(action).closest("li") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  m.principalActions.mockResolvedValue(s3WriteGrants);
});

test("loads the actions of the chosen service and level", async () => {
  setup();
  expect(await screen.findByText("s3:PutObject")).toBeInTheDocument();
  expect(m.principalActions).toHaveBeenCalledWith("prod", alice.arn, "s3", "write");
  expect(screen.getByRole("heading", { name: "Amazon S3 · 쓰기" })).toBeInTheDocument();
});

test("shows a status chip per action and a summary of the statuses", async () => {
  setup();
  await screen.findByText("s3:PutObject");
  expect(within(item("s3:PutObject")).getByText("허용")).toHaveClass("allowed");
  expect(within(item("s3:PutBucketPolicy")).getByText("조건부")).toHaveClass("conditional");
  expect(within(item("s3:DeleteObject")).getByText("거부")).toHaveClass("denied");
  expect(within(item("s3:PutBucketAcl")).getByText("경계로 차단")).toHaveClass("boundary");
  expect(screen.getByText("작업 4개 · 허용 1 · 조건부 1 · 거부 1 · 경계로 차단 1")).toBeInTheDocument();
});

test("shows the resources and the dangerous-action reason", async () => {
  setup();
  await screen.findByText("s3:PutObject");
  expect(within(item("s3:PutObject")).getByText("arn:aws:s3:::assets/*")).toBeInTheDocument();
  expect(within(item("s3:PutBucketPolicy")).getByText("버킷 정책을 바꿔 외부에 공개할 수 있어요")).toBeInTheDocument();
  expect(within(item("s3:PutObject")).queryByText(/외부에 공개/)).not.toBeInTheDocument();
});

test("lists the sources: policy, inherited group, sid, condition, deny and boundary", async () => {
  setup();
  await screen.findByText("s3:PutObject");
  const put = within(item("s3:PutObject"));
  expect(put.getByRole("button", { name: "app-deploy" })).toBeInTheDocument();
  expect(put.getByRole("button", { name: "dev-team" })).toBeInTheDocument();
  expect(put.getByText("Deploy")).toBeInTheDocument();

  const policy = within(item("s3:PutBucketPolicy"));
  expect(policy.getByText("조건 있음")).toBeInTheDocument();
  expect(policy.getByText("문장 2")).toBeInTheDocument(); // sid가 없으면 번호로 표시(0부터 센 index + 1)

  const del = within(item("s3:DeleteObject"));
  expect(del.getByText("NoDelete")).toBeInTheDocument();
  expect(del.getByText("Deny")).toBeInTheDocument();

  expect(within(item("s3:PutBucketAcl")).getByText("권한 경계")).toBeInTheDocument();
});

test("clicking a policy or its group reports it", async () => {
  const { props } = setup();
  await screen.findByText("s3:PutObject");
  fireEvent.click(within(item("s3:PutObject")).getByRole("button", { name: "app-deploy" }));
  expect(props.onOpenPolicy).toHaveBeenCalledWith(deployPolicy.id);
  fireEvent.click(within(item("s3:PutBucketPolicy")).getByRole("button", { name: "s3-scratch" }));
  expect(props.onOpenPolicy).toHaveBeenLastCalledWith(scratchInline.id);
  fireEvent.click(within(item("s3:PutObject")).getByRole("button", { name: "dev-team" }));
  expect(props.onOpenGroup).toHaveBeenCalledWith("dev-team");
});

test("the close button calls onClose", async () => {
  const { props } = setup();
  await screen.findByText("s3:PutObject");
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(props.onClose).toHaveBeenCalled();
});

test("shows a loading message, then the error", async () => {
  m.principalActions.mockRejectedValue({ kind: "accessDenied", action: "iam:GetAccountAuthorizationDetails" });
  setup();
  expect(screen.getByText("작업 목록을 불러오는 중…")).toBeInTheDocument();
  expect(await screen.findByText("권한 없음 (iam:GetAccountAuthorizationDetails)")).toBeInTheDocument();
});

test("reloads when another cell is chosen and explains an empty result", async () => {
  const { props, qc, rerender } = setup();
  await screen.findByText("s3:PutObject");
  m.principalActions.mockResolvedValue([]);
  rerender(
    <QueryClientProvider client={qc}>
      <ActionDrilldown profile="prod" arn={alice.arn} cell={{ prefix: "s3", name: "Amazon S3", level: "read" }} {...props} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(m.principalActions).toHaveBeenLastCalledWith("prod", alice.arn, "s3", "read"));
  expect(await screen.findByText("해당하는 작업이 없어요")).toBeInTheDocument();
});
