import { act, fireEvent, screen, within } from "@testing-library/react";
import { desktop } from "../api/desktop";
import { renderWithClient } from "../test/utils";
import { iamApi } from "./api";
import {
  bob,
  deactivateBobKey,
  finding,
  findingGroups,
  orphanPolicy,
  partnerRole,
  sampleFindings,
  sampleOverview,
} from "./fixtures";
import { Findings } from "./Findings";
import type { FindingKind, Findings as FindingsData } from "./types";

vi.mock("./api", () => ({ iamApi: { findings: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));

const m = vi.mocked(iamApi);

function setup(extra: Partial<React.ComponentProps<typeof Findings>> = {}) {
  const props = { onOpen: vi.fn(), onFix: vi.fn(), onViewState: vi.fn() };
  const utils = renderWithClient(<Findings profile="prod" overview={sampleOverview()} {...props} {...extra} />);
  return { props, ...utils };
}

const cardGroup = () => screen.findByRole("group", { name: "점검 항목" });
const card = (kind: FindingKind) =>
  within(screen.getByRole("group", { name: "점검 항목" }))
    .getAllByRole("button")
    .find((b) => b.getAttribute("data-kind") === kind) as HTMLElement;
const rows = () => within(screen.getByRole("table", { name: "점검 대상" })).getAllByRole("row").slice(1);

beforeEach(() => {
  vi.clearAllMocks();
  m.findings.mockResolvedValue(sampleFindings());
});

describe("loading", () => {
  test("shows a message until the check arrives", async () => {
    let resolve!: (v: FindingsData) => void;
    m.findings.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    expect(screen.getByText("점검하는 중…")).toBeInTheDocument();
    await act(async () => resolve(sampleFindings()));
    expect(await cardGroup()).toBeInTheDocument();
    expect(m.findings).toHaveBeenCalledWith("prod");
  });

  test("shows the error and retries", async () => {
    m.findings.mockRejectedValueOnce({ kind: "network", message: "timeout" });
    setup();
    expect(await screen.findByText("네트워크 오류: timeout")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await cardGroup()).toBeInTheDocument();
  });
});

describe("cards", () => {
  test("one card per check in the given order, with counts; checks without problems say so", async () => {
    setup();
    await cardGroup();
    const cards = within(screen.getByRole("group", { name: "점검 항목" })).getAllByRole("button");
    expect(cards.map((c) => c.getAttribute("data-kind"))).toEqual([
      "rootAccessKey",
      "rootNoMfa",
      "consoleNoMfa",
      "oldAccessKey",
      "unusedAccessKey",
      "inactiveUser",
      "inactiveRole",
      "adminPrincipal",
      "privescPrincipal",
      "externalTrust",
      "unattachedPolicy",
    ]);

    expect(card("rootNoMfa")).toHaveTextContent("루트 MFA 없음");
    expect(card("rootNoMfa")).toHaveTextContent("1건");
    expect(card("rootNoMfa")).toBeEnabled();
    expect(card("rootAccessKey")).toHaveTextContent("루트 액세스 키");
    expect(card("rootAccessKey")).toHaveTextContent("문제 없음");
    expect(card("rootAccessKey")).toHaveClass("empty");
    expect(card("rootAccessKey")).toBeDisabled();
    expect(screen.getAllByText("문제 없음")).toHaveLength(7);
  });

  test("a card carries the level of its check", async () => {
    m.findings.mockResolvedValue(
      sampleFindings({
        groups: findingGroups({
          rootNoMfa: [finding("arn:aws:iam::123456789012:root", "루트 계정", "MFA가 없어요")],
          oldAccessKey: [finding(bob.arn, "bob", "오래됐어요")],
          inactiveRole: [finding(partnerRole.arn, "partner-access", "90일 넘게 안 썼어요")],
        }),
      }),
    );
    setup();
    await cardGroup();
    expect(card("rootNoMfa")).toHaveClass("danger");
    expect(card("rootNoMfa")).toHaveTextContent("위험");
    expect(card("oldAccessKey")).toHaveClass("warn");
    expect(card("oldAccessKey")).toHaveTextContent("주의");
    expect(card("inactiveRole")).toHaveClass("info");
    expect(card("inactiveRole")).toHaveTextContent("참고");
  });

  test("opens on the first check that has problems", async () => {
    setup();
    await cardGroup();
    expect(card("rootNoMfa")).toHaveAttribute("aria-pressed", "true");
    expect(card("consoleNoMfa")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("heading", { name: /루트 MFA 없음/ })).toBeInTheDocument();
    expect(rows()).toHaveLength(1);
  });

  test("choosing a card lists its items with target and detail", async () => {
    setup();
    await cardGroup();
    fireEvent.click(card("oldAccessKey"));
    expect(card("oldAccessKey")).toHaveAttribute("aria-pressed", "true");
    expect(card("rootNoMfa")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("heading", { name: /오래된 액세스 키/ })).toBeInTheDocument();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("bob");
    expect(rows()[0]).toHaveTextContent("AKIAIOSFODNN7EXAMPLE 키를 만든 지 289일 지났어요");
  });

  test("lists every item of a check, even several for the same target", async () => {
    m.findings.mockResolvedValue(
      sampleFindings({
        groups: findingGroups({
          oldAccessKey: [finding(bob.arn, "bob", "첫 번째 키가 오래됐어요"), finding(bob.arn, "bob", "두 번째 키가 오래됐어요")],
        }),
      }),
    );
    setup();
    await cardGroup();
    expect(card("oldAccessKey")).toHaveTextContent("2건");
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining("첫 번째 키"), expect.stringContaining("두 번째 키")]);
  });

  test("says so when no check found anything", async () => {
    m.findings.mockResolvedValue(sampleFindings({ groups: findingGroups() }));
    setup();
    expect(await screen.findByText("발견된 문제가 없어요")).toBeInTheDocument();
    expect(screen.getAllByText("문제 없음")).toHaveLength(11);
    expect(screen.queryByRole("table", { name: "점검 대상" })).not.toBeInTheDocument();
  });
});

describe("items", () => {
  test("a user or role target opens its detail; the root account is plain text", async () => {
    const { props } = setup();
    await cardGroup();
    expect(rows()[0]).toHaveTextContent("루트 계정");
    expect(within(rows()[0]).queryByRole("button", { name: "루트 계정" })).not.toBeInTheDocument();

    fireEvent.click(card("consoleNoMfa"));
    fireEvent.click(within(rows()[0]).getByRole("button", { name: "bob" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "users", id: bob.arn });

    fireEvent.click(card("externalTrust"));
    fireEvent.click(within(rows()[0]).getByRole("button", { name: "partner-access" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "roles", id: partnerRole.arn });
  });

  test("an access key finding opens the user on the access keys tab", async () => {
    const { props } = setup();
    await cardGroup();
    fireEvent.click(card("oldAccessKey"));
    fireEvent.click(within(rows()[0]).getByRole("button", { name: "bob" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "users", id: bob.arn, tab: "keys" });
  });

  test("an unattached policy target opens the policy", async () => {
    m.findings.mockResolvedValue(
      sampleFindings({ groups: findingGroups({ unattachedPolicy: [finding(orphanPolicy.arn, "legacy-unused", "붙은 곳이 없어요")] }) }),
    );
    const { props } = setup();
    await cardGroup();
    fireEvent.click(within(rows()[0]).getByRole("button", { name: "legacy-unused" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "policies", id: orphanPolicy.id });
  });

  test("shows the CLI command and copies it", async () => {
    setup();
    await cardGroup();
    fireEvent.click(card("consoleNoMfa"));
    expect(within(rows()[0]).getByText("aws iam list-mfa-devices --user-name bob")).toBeInTheDocument();
    fireEvent.click(within(rows()[0]).getByRole("button", { name: "CLI 복사" }));
    expect(desktop.copy).toHaveBeenCalledWith("aws iam list-mfa-devices --user-name bob");
  });

  test("an item without a CLI command has no copy button", async () => {
    setup();
    await cardGroup();
    expect(rows()[0]).toHaveTextContent("루트 계정에 MFA가 없어요");
    expect(within(rows()[0]).queryByRole("button", { name: "CLI 복사" })).not.toBeInTheDocument();
  });

  test("a quick-fix button hands the item's change to onFix", async () => {
    const { props } = setup();
    await cardGroup();
    fireEvent.click(card("oldAccessKey"));
    fireEvent.click(within(rows()[0]).getByRole("button", { name: "키 비활성화" }));
    expect(props.onFix).toHaveBeenCalledTimes(1);
    expect(props.onFix).toHaveBeenCalledWith(deactivateBobKey);
  });

  test("an item without a fix has no quick-fix button", async () => {
    setup();
    await cardGroup();
    fireEvent.click(card("consoleNoMfa"));
    expect(within(rows()[0]).getAllByRole("button").map((b) => b.textContent)).toEqual(["bob", "CLI 복사"]);
  });

  test("quick fixes are disabled while no change handler is connected", async () => {
    setup({ onFix: undefined });
    await cardGroup();
    fireEvent.click(card("oldAccessKey"));
    expect(within(rows()[0]).getByRole("button", { name: "키 비활성화" })).toBeDisabled();
  });
});

describe("report time and warnings", () => {
  test("shows when the data is from and the warnings the backend collected", async () => {
    m.findings.mockResolvedValue(sampleFindings({ warnings: ["자격 증명 보고서를 불러오지 못했어요: 권한이 없어요"] }));
    setup();
    expect(await screen.findByText("자격 증명 보고서를 불러오지 못했어요: 권한이 없어요")).toBeInTheDocument();
    expect(screen.getByText(/기준 2026/)).toBeInTheDocument();
  });

  test("claims no time when the backend gave none", async () => {
    m.findings.mockResolvedValue(sampleFindings({ generatedAt: null }));
    setup();
    await cardGroup();
    expect(screen.queryByText(/기준/)).not.toBeInTheDocument();
  });
});

describe("view state", () => {
  test("restores the remembered card and reports a new choice", async () => {
    const { props } = setup({ initialKind: "externalTrust" });
    await cardGroup();
    expect(card("externalTrust")).toHaveAttribute("aria-pressed", "true");
    expect(props.onViewState).not.toHaveBeenCalled();
    fireEvent.click(card("oldAccessKey"));
    expect(props.onViewState).toHaveBeenLastCalledWith({ tab: "oldAccessKey" });
  });

  test("falls back to the first check with problems when the remembered one is empty or unknown", async () => {
    const { unmount } = setup({ initialKind: "inactiveRole" });
    await cardGroup();
    expect(card("rootNoMfa")).toHaveAttribute("aria-pressed", "true");
    unmount();

    setup({ initialKind: "not-a-check" });
    await cardGroup();
    expect(card("rootNoMfa")).toHaveAttribute("aria-pressed", "true");
  });
});
