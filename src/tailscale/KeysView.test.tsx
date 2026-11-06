import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { tailscaleApi } from "./api";
import { KeysView } from "./KeysView";
import type { TsKey, TsKeyDeletePreview, TsKeys, TsLock } from "./keyTypes";
import * as k from "./keysText";
import * as t from "./text";
import type { TsNode } from "./types";
import { useTailscaleApi } from "./useTailscaleApi";

vi.mock("./api", () => ({ tailscaleApi: { keys: vi.fn(), keyDeletePreview: vi.fn(), keyDelete: vi.fn(), lockStatus: vi.fn() } }));
vi.mock("./useTailscaleApi", () => ({ useTailscaleApi: vi.fn() }));

const a = vi.mocked(tailscaleApi);
const node = { cli: null } as TsNode;

const key = (id: string, kind: TsKey["kind"], rest: Partial<TsKey> = {}): TsKey => ({
  id, kind, description: "", created: "2026-01-01T00:00:00Z", expires: null, scopes: [], tags: [], reusable: false, ephemeral: false, preauthorized: false, invalid: false, userId: null, ...rest,
});

const data: TsKeys = {
  keys: [
    key("kCI", "auth", { description: "ci runner", expires: "2026-11-10T00:00:00Z", reusable: true, preauthorized: true, tags: ["tag:ci"] }),
    key("kOLD", "auth", { description: "old key", expires: "2026-01-01T00:00:00Z" }),
    key("kCLIENT", "client", { description: "deploy bot", scopes: ["all"], tags: ["tag:ci"] }),
    key("kTOKEN", "api", { description: "my token", expires: "2027-01-01T00:00:00Z", scopes: ["all"] }),
  ],
  findings: [
    { keyId: "kCI", kind: "expiring", days: 5 },
    { keyId: "kCI", kind: "reusablePreauthorized", days: null },
    { keyId: "kOLD", kind: "expired", days: 300 },
    { keyId: "kOLD", kind: "noTags", days: null },
    { keyId: "kCLIENT", kind: "allScope", days: null },
  ],
};

const lock: TsLock = { enabled: true, publicKey: "tlpub:me", nodeKeySigned: true, thisKeyTrusted: true, trustedKeys: 2, needsSignature: [{ name: "build-1", nodeKey: "nodekey:abc" }] };

const preview = (id: string): TsKeyDeletePreview => ({
  key: data.keys.find((item) => item.id === id)!,
  calls: [{ method: "DELETE", path: `/tailnet/-/keys/${id}`, scope: "oauth_keys" }],
  confirmName: id,
  warnings: ["이 OAuth 클라이언트로 받은 토큰이 모두 못 쓰게 돼요."],
  reversible: false,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useTailscaleApi).mockReturnValue({ tailnet: "example.com", connected: true, isLoading: false });
  a.keys.mockResolvedValue(data);
  a.lockStatus.mockResolvedValue(null);
});

const open = async () => {
  renderWithClient(<KeysView node={node} />);
  await screen.findByRole("table");
};

/** 점검 결과 목록에도 키 이름이 나와서 표 안에서만 찾는다 */
const table = () => within(screen.getByRole("table"));

const rowOf = (name: string) => screen.getAllByRole("row").find((row) => within(row).queryByText(name, { selector: "strong" }))!;

test("연결하지 않았으면 연결 탭으로 안내하고 키를 읽지 않아요", () => {
  vi.mocked(useTailscaleApi).mockReturnValue({ tailnet: null, connected: false, isLoading: false });
  renderWithClient(<KeysView node={node} />);
  expect(screen.getByText(t.API_REQUIRED)).toBeInTheDocument();
  expect(a.keys).not.toHaveBeenCalled();
});

test("키를 종류별로 보이고 지적을 풀어서 써요", async () => {
  await open();
  expect(a.keys).toHaveBeenCalledWith("example.com");
  const findings = within(screen.getByRole("region", { name: k.FINDINGS_TITLE }));
  expect(findings.getByText(/5일 안에 만료돼요/)).toBeInTheDocument();
  expect(findings.getByText(/재사용 \+ 사전 승인 키예요/)).toBeInTheDocument();
  expect(findings.getByText(/만료됐어요 \(300일 전\)/)).toBeInTheDocument();
  expect(findings.getByText(/태그가 없어요/)).toBeInTheDocument();
  expect(findings.getByText(/all 스코프예요/)).toBeInTheDocument();

  const ci = within(rowOf("ci runner"));
  expect(ci.getByText("auth key")).toBeInTheDocument();
  expect(ci.getByText("2026-11-10")).toBeInTheDocument();
  for (const chip of [k.REUSABLE, k.PREAUTHORIZED, "tag:ci", k.findingShort.expiring]) expect(ci.getByText(chip)).toBeInTheDocument();
  const client = within(rowOf("deploy bot"));
  expect(client.getByText("OAuth 클라이언트")).toBeInTheDocument();
  expect(client.getByText("all")).toBeInTheDocument();
  expect(client.getByText(k.NO_EXPIRY)).toBeInTheDocument();
});

test("종류 필터, 지적 있는 키, 검색으로 좁혀요", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: /^OAuth 클라이언트 1$/ }));
  expect(table().queryByText("ci runner", { selector: "strong" })).not.toBeInTheDocument();
  expect(table().getByText("deploy bot", { selector: "strong" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /^지적 있는 키 3$/ }));
  expect(table().queryByText("my token", { selector: "strong" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /^모두 4$/ }));
  fireEvent.change(screen.getByLabelText(k.SEARCH), { target: { value: "kTOKEN" } });
  expect(table().getByText("my token", { selector: "strong" })).toBeInTheDocument();
  expect(table().queryByText("ci runner", { selector: "strong" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(k.SEARCH), { target: { value: "zzzz" } });
  expect(screen.getByText(k.NO_MATCH)).toBeInTheDocument();
});

test("키 목록을 못 읽으면 오류를 보이고 Tailnet Lock은 그대로 보여요", async () => {
  a.keys.mockRejectedValue({ kind: "other", message: "이 자격 증명에 all:read 권한이 없어요" });
  a.lockStatus.mockResolvedValue(lock);
  renderWithClient(<KeysView node={node} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("이 자격 증명에 all:read 권한이 없어요");
  expect(await screen.findByRole("region", { name: k.LOCK_TITLE })).toBeInTheDocument();
});

describe("Tailnet Lock", () => {
  test("CLI가 없으면(null) 패널을 숨겨요", async () => {
    await open();
    await waitFor(() => expect(a.lockStatus).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: k.LOCK_TITLE })).not.toBeInTheDocument();
  });

  test("켜져 있으면 서명 노드 여부, 신뢰 키 수, 서명이 필요한 기기를 보여요", async () => {
    a.lockStatus.mockResolvedValue(lock);
    await open();
    const panel = within(await screen.findByRole("region", { name: k.LOCK_TITLE }));
    expect(panel.getByText(k.LOCK_ON)).toBeInTheDocument();
    expect(panel.getByText("tlpub:me")).toBeInTheDocument();
    expect(panel.getByText(k.LOCK_TRUSTED)).toBeInTheDocument();
    expect(panel.getByText(k.LOCK_SIGNED)).toBeInTheDocument();
    expect(panel.getByText("2")).toBeInTheDocument();
    expect(panel.getByText("build-1")).toBeInTheDocument();
  });

  test("꺼져 있으면 꺼짐과 안내만 보여요", async () => {
    a.lockStatus.mockResolvedValue({ enabled: false, publicKey: "tlpub:me", nodeKeySigned: null, thisKeyTrusted: null, trustedKeys: 0, needsSignature: [] });
    await open();
    const panel = within(await screen.findByRole("region", { name: k.LOCK_TITLE }));
    expect(panel.getByText(k.LOCK_OFF)).toBeInTheDocument();
    expect(panel.getByText(k.LOCK_DISABLED_NOTE)).toBeInTheDocument();
    expect(panel.queryByText(k.LOCK_TRUSTED_COUNT)).not.toBeInTheDocument();
  });
});

describe("키 삭제", () => {
  const startDelete = async (id: string, name: string) => {
    a.keyDeletePreview.mockResolvedValue(preview(id));
    fireEvent.click(within(rowOf(name)).getByRole("button", { name: k.deleteLabel(name) }));
    return screen.findByRole("dialog", { name: k.DELETE_PREVIEW });
  };

  test("미리보기에 정확한 호출과 스코프가 나오고 키 ID를 쳐야 삭제가 켜져요", async () => {
    await open();
    const dialog = within(await startDelete("kCLIENT", "deploy bot"));
    expect(a.keyDeletePreview).toHaveBeenCalledWith("example.com", "kCLIENT");
    expect(await dialog.findByText("DELETE /tailnet/-/keys/kCLIENT")).toBeInTheDocument();
    expect(dialog.getByText("oauth_keys")).toBeInTheDocument();
    expect(dialog.getByText(k.NOT_UNDOABLE)).toBeInTheDocument();
    expect(dialog.getByText(/토큰이 모두 못 쓰게 돼요/)).toBeInTheDocument();

    const remove = dialog.getByRole("button", { name: k.APPLY });
    expect(remove).toBeDisabled();
    fireEvent.change(dialog.getByLabelText(k.CONFIRM_LABEL("kCLIENT")), { target: { value: "kclient" } });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(a.keyDelete).not.toHaveBeenCalled();
    fireEvent.change(dialog.getByLabelText(k.CONFIRM_LABEL("kCLIENT")), { target: { value: "kCLIENT" } });
    expect(remove).toBeEnabled();
  });

  test("삭제하면 결과를 보이고 목록을 다시 읽어요", async () => {
    a.keyDelete.mockResolvedValue({ logged: true });
    await open();
    const dialog = within(await startDelete("kCLIENT", "deploy bot"));
    fireEvent.change(await dialog.findByLabelText(k.CONFIRM_LABEL("kCLIENT")), { target: { value: "kCLIENT" } });
    fireEvent.click(dialog.getByRole("button", { name: k.APPLY }));
    expect(await dialog.findByText(k.deleted("deploy bot"))).toBeInTheDocument();
    expect(a.keyDelete).toHaveBeenCalledWith("example.com", "kCLIENT", "kCLIENT");
    expect(dialog.queryByText(k.NOT_LOGGED)).not.toBeInTheDocument();
    await waitFor(() => expect(a.keys).toHaveBeenCalledTimes(2));
    fireEvent.click(dialog.getByRole("button", { name: k.CLOSE }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("변경 기록을 못 남겼으면 그 사실을 알려요", async () => {
    a.keyDelete.mockResolvedValue({ logged: false });
    await open();
    const dialog = within(await startDelete("kCLIENT", "deploy bot"));
    fireEvent.change(await dialog.findByLabelText(k.CONFIRM_LABEL("kCLIENT")), { target: { value: "kCLIENT" } });
    fireEvent.click(dialog.getByRole("button", { name: k.APPLY }));
    expect(await dialog.findByText(k.NOT_LOGGED)).toBeInTheDocument();
  });

  test("삭제가 실패하면 오류를 보이고 미리보기를 다시 받기 전에는 삭제할 수 없어요", async () => {
    a.keyDelete.mockRejectedValue({ kind: "other", message: "이 자격 증명에 oauth_keys 권한이 없어요" });
    await open();
    const dialog = within(await startDelete("kCLIENT", "deploy bot"));
    fireEvent.change(await dialog.findByLabelText(k.CONFIRM_LABEL("kCLIENT")), { target: { value: "kCLIENT" } });
    fireEvent.click(dialog.getByRole("button", { name: k.APPLY }));
    expect(await dialog.findByText("이 자격 증명에 oauth_keys 권한이 없어요")).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: k.APPLY })).toBeDisabled();
    expect(a.keys).toHaveBeenCalledTimes(1);

    fireEvent.click(dialog.getByRole("button", { name: "미리보기 다시 받기" }));
    await waitFor(() => expect(a.keyDeletePreview).toHaveBeenCalledTimes(2));
    expect(await dialog.findByLabelText(k.CONFIRM_LABEL("kCLIENT"))).toHaveValue("");
  });

  test("미리보기를 못 만들면 오류를 보이고 삭제할 수 없어요", async () => {
    a.keyDeletePreview.mockRejectedValue({ kind: "other", message: "이미 없는 키예요. 목록을 다시 읽어 주세요" });
    await open();
    fireEvent.click(within(rowOf("deploy bot")).getByRole("button", { name: k.deleteLabel("deploy bot") }));
    const dialog = within(await screen.findByRole("dialog", { name: k.DELETE_PREVIEW }));
    expect(await dialog.findByText("이미 없는 키예요. 목록을 다시 읽어 주세요")).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: k.APPLY })).toBeDisabled();
  });

  test("취소하면 아무것도 지우지 않고 닫혀요", async () => {
    await open();
    const dialog = within(await startDelete("kCLIENT", "deploy bot"));
    await dialog.findByText("DELETE /tailnet/-/keys/kCLIENT");
    fireEvent.click(dialog.getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(a.keyDelete).not.toHaveBeenCalled();
  });
});
