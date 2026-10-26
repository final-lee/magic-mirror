import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { desktop } from "../api/desktop";
import { renderWithClient } from "../test/utils";
import { iamApi } from "./api";
import { alice, deployPolicy, readOnlyPolicy, sampleLastAccessed, scratchInline } from "./fixtures";
import type { LastAccessed } from "./types";
import { UnusedPermissions } from "./UnusedPermissions";

vi.mock("./api", () => ({ iamApi: { lastAccessed: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));

const m = vi.mocked(iamApi);

type Props = React.ComponentProps<typeof UnusedPermissions>;
const element = (props: Partial<Props>) => <UnusedPermissions profile="prod" arn={alice.arn} onOpenPolicy={vi.fn()} onOpenGroup={vi.fn()} onFix={vi.fn()} {...props} />;

function setup(extra: Partial<Props> = {}) {
  const props = { onOpenPolicy: vi.fn(), onOpenGroup: vi.fn(), onFix: vi.fn() };
  const utils = renderWithClient(element({ ...props, ...extra }));
  return { props, ...utils };
}

const loadButton = () => screen.getByRole("button", { name: "불러오기" });
const servicesTable = () => screen.findByRole("table", { name: "서비스별 마지막 사용" });
async function load() {
  fireEvent.click(loadButton());
  return servicesTable();
}
const policyRow = (name: string) => screen.getByRole("button", { name }).closest("tr") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  m.lastAccessed.mockResolvedValue(sampleLastAccessed());
});
afterEach(() => vi.useRealTimers());

describe("loading", () => {
  test("asks nothing of AWS until the button is pressed, and says it can take a while", () => {
    setup();
    expect(m.lastAccessed).not.toHaveBeenCalled();
    expect(screen.getByText(/10~30초/)).toBeInTheDocument();
    expect(loadButton()).toBeEnabled();
  });

  test("shows progress while AWS collects the data, then the result", async () => {
    let resolve!: (v: LastAccessed) => void;
    m.lastAccessed.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    fireEvent.click(loadButton());
    expect(await screen.findByText(/마지막 사용 시각을 모으는 중이에요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "불러오는 중…" })).toBeDisabled();
    expect(m.lastAccessed).toHaveBeenCalledWith("prod", alice.arn);

    await act(async () => resolve(sampleLastAccessed()));
    expect(await servicesTable()).toBeInTheDocument();
    expect(screen.queryByText(/모으는 중이에요/)).not.toBeInTheDocument();
  });

  test("shows the error; a retryable one can be retried from the banner", async () => {
    m.lastAccessed.mockRejectedValueOnce({ kind: "network", message: "timeout" });
    setup();
    fireEvent.click(loadButton());
    expect(await screen.findByText("네트워크 오류: timeout")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await servicesTable()).toBeInTheDocument();
    expect(m.lastAccessed).toHaveBeenCalledTimes(2);
  });

  test("a missing permission is explained and the button can try again later", async () => {
    m.lastAccessed.mockRejectedValueOnce({ kind: "accessDenied", action: "iam:GenerateServiceLastAccessedDetails" });
    setup();
    fireEvent.click(loadButton());
    expect(await screen.findByText("권한 없음 (iam:GenerateServiceLastAccessedDetails)")).toBeInTheDocument();
    expect(loadButton()).toBeEnabled();
  });

  test("a loaded result is still there after leaving the tab and coming back", async () => {
    const { qc, rerender } = setup();
    await load();
    const page = (node: ReactNode) => <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
    rerender(page(null));
    rerender(page(element({})));
    expect(await servicesTable()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "불러오기" })).not.toBeInTheDocument();
    expect(m.lastAccessed).toHaveBeenCalledTimes(1);
  });

  test("reloading keeps the old result on screen until the new one arrives", async () => {
    setup();
    await load();
    let resolve!: (v: LastAccessed) => void;
    m.lastAccessed.mockReturnValue(new Promise((r) => (resolve = r)));
    fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
    expect(await screen.findByRole("button", { name: "불러오는 중…" })).toBeDisabled();
    expect(screen.getByRole("table", { name: "서비스별 마지막 사용" })).toBeInTheDocument();
    await act(async () => resolve(sampleLastAccessed({ services: [{ prefix: "kms", name: "AWS KMS", lastUsed: null, actions: null }] })));
    expect(await screen.findByText("AWS KMS")).toBeInTheDocument();
    expect(screen.queryByText("Amazon S3")).not.toBeInTheDocument();
  });
});

describe("services", () => {
  test("never-used services come first, then the oldest use; never-used ones show the tracking period", async () => {
    setup();
    const table = within(await load());
    const rows = table.getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual([
      expect.stringContaining("Amazon SQS"),
      expect.stringContaining("IAM"),
      expect.stringContaining("Amazon EC2"),
      expect.stringContaining("Amazon S3"),
    ]);
    expect(within(rows[0]).getByText("사용 안 함 (400일)")).toBeInTheDocument();
    expect(within(rows[1]).getByText("사용 안 함 (400일)")).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent("2026-02-01");
    expect(rows[3]).toHaveTextContent("2026-10-20");
    expect(within(rows[3]).queryByText(/사용 안 함/)).not.toBeInTheDocument();
  });

  test("the label follows the tracking period AWS reports", async () => {
    m.lastAccessed.mockResolvedValue(sampleLastAccessed({ trackingDays: 365 }));
    setup();
    await load();
    expect(screen.getAllByText("사용 안 함 (365일)")).toHaveLength(2);
  });

  test("shows the tracking period and when AWS finished collecting", async () => {
    setup();
    await load();
    expect(screen.getByText(/최근 400일/)).toBeInTheDocument();
    expect(screen.getByText(/집계 2026/)).toBeInTheDocument();
  });

  test("says so when the principal is allowed no services", async () => {
    m.lastAccessed.mockResolvedValue(sampleLastAccessed({ services: [], unusedPolicies: [], draft: null, draftNotes: [] }));
    setup();
    fireEvent.click(loadButton());
    expect(await screen.findByText("허용된 서비스가 없어요")).toBeInTheDocument();
  });
});

describe("policies that are not used at all", () => {
  test("lists them with the reason and opens the policy", async () => {
    const { props } = setup();
    await load();
    const table = screen.getByRole("table", { name: "통째로 안 쓰는 정책" });
    expect(within(table).getAllByRole("row").slice(1)).toHaveLength(2);
    expect(policyRow("ReadOnlyAccess")).toHaveTextContent("허용하는 서비스를 400일 동안 하나도 안 썼어요");
    fireEvent.click(screen.getByRole("button", { name: "ReadOnlyAccess" }));
    expect(props.onOpenPolicy).toHaveBeenCalledWith(readOnlyPolicy.id);
  });

  test("[떼기] hands a detach change for this principal to onFix", async () => {
    const { props } = setup();
    await load();
    fireEvent.click(within(policyRow("ReadOnlyAccess")).getByRole("button", { name: "떼기" }));
    expect(props.onFix).toHaveBeenCalledTimes(1);
    expect(props.onFix).toHaveBeenCalledWith({ op: "detachPolicy", target: alice.arn, policyArn: readOnlyPolicy.id });
  });

  test("a policy inherited from a group cannot be detached here: disabled, with a hint and a link to the group", async () => {
    const { props } = setup();
    await load();
    const row = policyRow("app-deploy");
    expect(within(row).getByRole("button", { name: "떼기" })).toBeDisabled();
    expect(row).toHaveTextContent("그룹 dev-team에서 떼야 해요");
    fireEvent.click(within(row).getByRole("button", { name: "dev-team" }));
    expect(props.onOpenGroup).toHaveBeenCalledWith("dev-team");
    expect(props.onFix).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "app-deploy" }));
    expect(props.onOpenPolicy).toHaveBeenCalledWith(deployPolicy.id);
  });

  test("an inline policy is deleted rather than detached", async () => {
    m.lastAccessed.mockResolvedValue(
      sampleLastAccessed({ unusedPolicies: [{ policyId: scratchInline.id, name: "s3-scratch", via: null, reason: "쓰지 않는 서비스만 허용해요" }] }),
    );
    const { props } = setup();
    await load();
    const row = policyRow("s3-scratch");
    expect(within(row).queryByRole("button", { name: "떼기" })).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "삭제" }));
    expect(props.onFix).toHaveBeenCalledWith({ op: "deleteInlinePolicy", target: alice.arn, name: "s3-scratch" });
  });

  test("the buttons are plain action buttons: no 'coming soon' placeholder state", async () => {
    setup();
    await load();
    const button = within(policyRow("ReadOnlyAccess")).getByRole("button", { name: "떼기" });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("title");
  });

  test("says so when every policy is in use", async () => {
    m.lastAccessed.mockResolvedValue(sampleLastAccessed({ unusedPolicies: [] }));
    setup();
    await load();
    expect(screen.getByText("통째로 안 쓰는 정책이 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "통째로 안 쓰는 정책" })).not.toBeInTheDocument();
  });
});

describe("reduced policy draft", () => {
  const pretty = (doc: string) => JSON.stringify(JSON.parse(doc), null, 2);

  test("shows the draft indented, with the notes about what was dropped", async () => {
    setup();
    await load();
    const draft = sampleLastAccessed().draft!;
    expect(screen.getByTestId("draft-json").textContent).toBe(pretty(draft));
    expect(screen.getByText("조건(Condition)은 초안에 넣지 않았어요")).toBeInTheDocument();
    expect(screen.getByText("작업 단위 기록이 없는 서비스는 서비스 전체(예: ec2:*)로 남겼어요")).toBeInTheDocument();
  });

  test("[복사] copies the draft as shown", async () => {
    setup();
    await load();
    fireEvent.click(screen.getByRole("button", { name: "초안 복사" }));
    expect(desktop.copy).toHaveBeenCalledWith(pretty(sampleLastAccessed().draft!));
  });

  test("[인라인 정책으로 저장] hands a named inline policy with the draft to onFix", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 26, 10, 30));
    const { props } = setup();
    await load();
    fireEvent.click(screen.getByRole("button", { name: "인라인 정책으로 저장" }));
    expect(props.onFix).toHaveBeenCalledTimes(1);
    expect(props.onFix).toHaveBeenCalledWith({
      op: "putInlinePolicy",
      target: alice.arn,
      name: "least-privilege-20261026",
      document: pretty(sampleLastAccessed().draft!),
    });
  });

  test("warns that saving does not remove the broader policies and that rarely used permissions may be missing", async () => {
    setup();
    await load();
    expect(screen.getByText(/저장해도 지금 붙어 있는 정책은 그대로예요/)).toBeInTheDocument();
    expect(screen.getByText(/사용 기록이 없는 권한은 빠져 있어요/)).toBeInTheDocument();
  });

  test("the save button is a plain action button: no 'coming soon' placeholder state", async () => {
    setup();
    await load();
    expect(screen.getByRole("button", { name: "인라인 정책으로 저장" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "인라인 정책으로 저장" })).not.toHaveAttribute("title");
  });

  test("without a draft there is nothing to copy or save, but the notes still show", async () => {
    m.lastAccessed.mockResolvedValue(sampleLastAccessed({ draft: null, draftNotes: ["사용 기록이 없어서 초안을 만들지 못했어요"] }));
    setup();
    await load();
    expect(screen.getByText("만들 수 있는 초안이 없어요")).toBeInTheDocument();
    expect(screen.getByText("사용 기록이 없어서 초안을 만들지 못했어요")).toBeInTheDocument();
    expect(screen.queryByTestId("draft-json")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "인라인 정책으로 저장" })).not.toBeInTheDocument();
  });

  test("a draft that is not valid JSON is shown as received", async () => {
    m.lastAccessed.mockResolvedValue(sampleLastAccessed({ draft: "{not json" }));
    setup();
    await load();
    expect(screen.getByTestId("draft-json").textContent).toBe("{not json");
  });
});

describe("principals that cannot be changed", () => {
  const reason = "서비스 연결 역할은 AWS가 관리해서 바꿀 수 없어요";

  test("떼기, 삭제 and 저장 are off with the reason, and nothing is handed to onFix", async () => {
    m.lastAccessed.mockResolvedValue(
      sampleLastAccessed({
        unusedPolicies: [
          { policyId: readOnlyPolicy.id, name: "ReadOnlyAccess", via: null, reason: "안 썼어요" },
          { policyId: scratchInline.id, name: "s3-scratch", via: null, reason: "안 썼어요" },
        ],
      }),
    );
    const { props } = setup({ blockedReason: reason });
    await load();
    expect(screen.getByText(reason)).toBeInTheDocument();
    for (const [row, name] of [
      [policyRow("ReadOnlyAccess"), "떼기"],
      [policyRow("s3-scratch"), "삭제"],
    ] as const) {
      const button = within(row).getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", reason);
      fireEvent.click(button);
    }
    const save = screen.getByRole("button", { name: "인라인 정책으로 저장" });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("title", reason);
    fireEvent.click(save);
    expect(props.onFix).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "초안 복사" })).toBeEnabled();
  });

  test("without a reason nothing is disabled and no reason is shown", async () => {
    setup({ blockedReason: null });
    await load();
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
    expect(within(policyRow("ReadOnlyAccess")).getByRole("button", { name: "떼기" })).toBeEnabled();
  });
});
