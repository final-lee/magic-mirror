import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/client";
import type { Settings } from "../api/types";
import { renderWithClient } from "../test/utils";
import { argocdApi } from "./api";
import { ArgocdTab } from "./ArgocdTab";
import {
  ARGO_GROUP_BY, ARGO_NO_APPS, LOADING, RETRY, SERVER_ADD, SERVER_EDIT, SERVER_HELP, SERVER_LABEL, SERVER_NAME, SERVER_NEXT, SERVER_URL, STEPS_LABEL, STEP_SERVER, STEP_TOKEN,
  TOKEN_CANCEL, TOKEN_CHANGE, TOKEN_FORGET, TOKEN_HTTP_WARNING, TOKEN_INVALID, TOKEN_LABEL, TOKEN_MISSING, TOKEN_SUBMIT, serverRemoveLabel, tokenFor,
} from "./text";
import type { ArgoAppRow, ArgocdServer, ArgocdSession, ArgoViewState } from "./types";

vi.mock("../api/client", () => ({ api: { getSettings: vi.fn(), saveSettings: vi.fn() } }));
vi.mock("./api", () => ({ argocdApi: { session: vi.fn(), setToken: vi.fn(), forgetToken: vi.fn(), apps: vi.fn(), appsets: vi.fn(), app: vi.fn(), tree: vi.fn(), refresh: vi.fn(), sync: vi.fn() } }));
const a = vi.mocked(argocdApi);
const STG: ArgocdServer = { name: "stg", url: "https://stg.example" };
const OPS: ArgocdServer = { name: "ops", url: "http://ops.example" };
const DEV: ArgocdServer = { name: "dev", url: "https://dev.example" };
const EMPTY: Settings = { enabledServices: [], favorites: [], lastProfile: null, lastRegion: null };
/** 대부분의 시험은 서버 두 개를 넣어 둔 상태에서 시작한다 */
const SETTINGS: Settings = { ...EMPTY, argocdServers: [STG, OPS] };

const session = (url: string): ArgocdSession => ({ url, username: "admin", version: url === OPS.url ? "v3.3.6" : "v3.4.5" });
const row = (name: string): ArgoAppRow => ({ name, namespace: "argocd", resourceVersion: "1", values: { sync: "Synced", health: "Healthy", project: "default" }, labels: {} });
const serverSelect = () => screen.getByRole("combobox", { name: SERVER_LABEL });
const submitToken = (token: string) => {
  fireEvent.change(screen.getByLabelText(TOKEN_LABEL), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: TOKEN_SUBMIT }));
};

/** 토큰을 넣은 서버만 세션이 있다(키체인에 토큰이 있는 것처럼) */
let keychain: Set<string>;

beforeEach(() => {
  vi.resetAllMocks();
  keychain = new Set();
  vi.mocked(api.getSettings).mockResolvedValue(SETTINGS);
  vi.mocked(api.saveSettings).mockResolvedValue(undefined);
  a.session.mockImplementation(async (url) => (keychain.has(url) ? session(url) : null));
  a.setToken.mockImplementation(async (url) => {
    keychain.add(url);
    return session(url);
  });
  a.forgetToken.mockImplementation(async (url) => void keychain.delete(url));
  a.apps.mockImplementation(async (url) => [row(url === OPS.url ? "ops-app" : "stg-app")]);
  a.appsets.mockResolvedValue([]);
});

const currentStep = () => within(screen.getByRole("list", { name: STEPS_LABEL })).getByText((_, el) => el?.getAttribute("aria-current") === "step").textContent;

describe("first connection: server, then token", () => {
  test("with no servers the tab starts at step 1 and asks the server for nothing", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(EMPTY);
    renderWithClient(<ArgocdTab active />);
    expect(await screen.findByText(SERVER_HELP)).toBeInTheDocument();
    expect(currentStep()).toBe(STEP_SERVER);
    expect(screen.queryByLabelText(TOKEN_LABEL)).toBeNull();
    expect(screen.queryByRole("combobox", { name: SERVER_LABEL })).toBeNull();
    expect(a.session).not.toHaveBeenCalled();
  });

  test("the first server is saved and selected, then step 2 asks for that server's token, then the list", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(EMPTY);
    renderWithClient(<ArgocdTab active />);
    fireEvent.change(await screen.findByLabelText(SERVER_URL), { target: { value: "https://argocd.example.com/" } });
    fireEvent.click(screen.getByRole("button", { name: SERVER_NEXT }));
    // 이름을 비우면 주소의 호스트가 이름이 된다
    const added = { name: "argocd.example.com", url: "https://argocd.example.com" };
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ argocdServers: [added] })));
    expect(await screen.findByLabelText(TOKEN_LABEL)).toBeInTheDocument();
    expect(currentStep()).toBe(STEP_TOKEN);
    expect(screen.getByText(tokenFor(added.name, added.url))).toBeInTheDocument();
    expect(a.session).toHaveBeenCalledWith(added.url);
    submitToken("secret");
    expect(await screen.findByText("stg-app")).toBeInTheDocument();
    expect(a.setToken).toHaveBeenCalledWith(added.url, "secret");
  });

  test("a bad address stays at step 1 with a message and saves nothing", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(EMPTY);
    renderWithClient(<ArgocdTab active />);
    fireEvent.change(await screen.findByLabelText(SERVER_URL), { target: { value: "argocd.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: SERVER_NEXT }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(currentStep()).toBe(STEP_SERVER);
    expect(api.saveSettings).not.toHaveBeenCalled();
  });
});

describe("servers", () => {
  test("servers from settings are offered in order and the first is selected", async () => {
    renderWithClient(<ArgocdTab active />);
    await screen.findByLabelText(TOKEN_LABEL);
    expect(within(serverSelect()).getAllByRole("option").map((o) => [o.textContent, (o as HTMLOptionElement).value])).toEqual([
      ["stg", STG.url],
      ["ops", OPS.url],
    ]);
    expect(serverSelect()).toHaveValue(STG.url);
    expect(a.session).toHaveBeenCalledWith(STG.url);
  });

  test("adding a server from the editor saves it and goes to its token step", async () => {
    renderWithClient(<ArgocdTab active />);
    fireEvent.click(await screen.findByRole("button", { name: SERVER_EDIT }));
    fireEvent.change(screen.getByLabelText(SERVER_URL), { target: { value: "https://dev.example/" } });
    fireEvent.change(screen.getByLabelText(SERVER_NAME), { target: { value: "dev" } });
    fireEvent.click(screen.getByRole("button", { name: SERVER_ADD }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ argocdServers: [STG, OPS, DEV] })));
    expect(serverSelect()).toHaveValue(DEV.url);
    expect(await screen.findByText(tokenFor(DEV.name, DEV.url))).toBeInTheDocument();
    expect(a.session).toHaveBeenCalledWith(DEV.url);
  });

  test("removing a server saves the rest, forgets its token and its filters, and falls back to the first", async () => {
    const view: ArgoViewState = { sync: [], health: [], envs: [], clusters: [], projects: [], labels: [], groupBy: "env", thenBy: null };
    vi.mocked(api.getSettings).mockResolvedValue({ ...EMPTY, argocdServers: [STG, OPS, DEV], argocdViews: { [STG.url]: view, [DEV.url]: view } });
    renderWithClient(<ArgocdTab active />);
    await screen.findByLabelText(TOKEN_LABEL);
    fireEvent.change(serverSelect(), { target: { value: DEV.url } });
    fireEvent.click(screen.getByRole("button", { name: SERVER_EDIT }));
    fireEvent.click(screen.getByRole("button", { name: serverRemoveLabel("dev") }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ argocdServers: [STG, OPS], argocdViews: { [STG.url]: view } })));
    expect(a.forgetToken).toHaveBeenCalledWith(DEV.url);
    expect(within(serverSelect()).getAllByRole("option").map((o) => o.textContent)).toEqual(["stg", "ops"]);
    expect(serverSelect()).toHaveValue(STG.url);
  });

  test("removing the last server goes back to step 1", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...EMPTY, argocdServers: [DEV] });
    renderWithClient(<ArgocdTab active />);
    await screen.findByLabelText(TOKEN_LABEL);
    fireEvent.click(screen.getByRole("button", { name: SERVER_EDIT }));
    fireEvent.click(screen.getByRole("button", { name: serverRemoveLabel("dev") }));
    expect(await screen.findByText(SERVER_HELP)).toBeInTheDocument();
    expect(currentStep()).toBe(STEP_SERVER);
  });

  test("the server list editor opens and closes", async () => {
    renderWithClient(<ArgocdTab active />);
    const toggle = await screen.findByRole("button", { name: SERVER_EDIT });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByLabelText(SERVER_NAME)).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByLabelText(SERVER_NAME)).toBeNull();
  });
});

describe("token flow", () => {
  test("no token shows the form, not the list; setting one shows the list and who is connected", async () => {
    renderWithClient(<ArgocdTab active />);
    expect(screen.getByText(LOADING)).toBeInTheDocument();
    expect(await screen.findByLabelText(TOKEN_LABEL)).toHaveAttribute("type", "password");
    expect(a.apps).not.toHaveBeenCalled();
    submitToken("secret-token");
    expect(await screen.findByText("stg-app")).toBeInTheDocument();
    expect(a.setToken).toHaveBeenCalledWith(STG.url, "secret-token");
    expect(screen.queryByLabelText(TOKEN_LABEL)).toBeNull();
    expect(screen.getByText("admin · v3.4.5")).toBeInTheDocument();
  });

  test("an existing token goes straight to the list", async () => {
    keychain.add(STG.url);
    renderWithClient(<ArgocdTab active />);
    expect(await screen.findByText("stg-app")).toBeInTheDocument();
    expect(screen.queryByLabelText(TOKEN_LABEL)).toBeNull();
    expect(a.setToken).not.toHaveBeenCalled();
  });

  test("the token field is emptied the moment it is sent, and the token is nowhere else", async () => {
    let finish!: (s: ArgocdSession) => void;
    a.setToken.mockReturnValue(new Promise<ArgocdSession>((resolve) => (finish = resolve)));
    const { qc } = renderWithClient(<ArgocdTab active />);
    const input = await screen.findByLabelText(TOKEN_LABEL);
    submitToken("super-secret");
    expect(input).toHaveValue("");
    finish(session(STG.url));
    await screen.findByText("stg-app");
    expect(JSON.stringify(qc.getQueryCache().getAll().map((q) => q.state.data))).not.toContain("super-secret");
    expect(JSON.stringify(vi.mocked(api.saveSettings).mock.calls)).not.toContain("super-secret");
    expect(document.body.innerHTML).not.toContain("super-secret");
  });

  test("a rejected token shows why and leaves an empty form", async () => {
    a.setToken.mockRejectedValueOnce({ kind: "other", message: TOKEN_INVALID });
    renderWithClient(<ArgocdTab active />);
    await screen.findByLabelText(TOKEN_LABEL);
    submitToken("bad");
    expect(await screen.findByText(TOKEN_INVALID)).toBeInTheDocument();
    expect(screen.getByLabelText(TOKEN_LABEL)).toHaveValue("");
    expect(a.apps).not.toHaveBeenCalled();
    submitToken("good");
    expect(await screen.findByText("stg-app")).toBeInTheDocument();
    expect(screen.queryByText(TOKEN_INVALID)).toBeNull();
  });

  test("an http:// server warns that the token travels in plaintext; an https:// one does not", async () => {
    renderWithClient(<ArgocdTab active />);
    await screen.findByLabelText(TOKEN_LABEL);
    expect(screen.queryByText(TOKEN_HTTP_WARNING)).toBeNull();
    fireEvent.change(serverSelect(), { target: { value: OPS.url } });
    expect(await screen.findByText(TOKEN_HTTP_WARNING)).toBeInTheDocument();
  });

  test("TOKEN_INVALID from the applications query returns to the form with that message", async () => {
    keychain.add(STG.url);
    a.apps.mockRejectedValue({ kind: "other", message: TOKEN_INVALID });
    renderWithClient(<ArgocdTab active />);
    expect(await screen.findByLabelText(TOKEN_LABEL)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(TOKEN_INVALID);
  });

  test("TOKEN_INVALID from the ApplicationSet query returns to the form too", async () => {
    keychain.add(STG.url);
    a.appsets.mockRejectedValue({ kind: "other", message: TOKEN_INVALID });
    renderWithClient(<ArgocdTab active />);
    expect(await screen.findByLabelText(TOKEN_LABEL)).toBeInTheDocument();
    expect(screen.getByText(TOKEN_INVALID)).toBeInTheDocument();
  });

  test("TOKEN_MISSING from a query returns to the form as well", async () => {
    keychain.add(STG.url);
    a.apps.mockRejectedValue({ kind: "other", message: TOKEN_MISSING });
    renderWithClient(<ArgocdTab active />);
    expect(await screen.findByLabelText(TOKEN_LABEL)).toBeInTheDocument();
    expect(screen.getByText(TOKEN_MISSING)).toBeInTheDocument();
  });

  test("an expired token reported by the session check shows the form", async () => {
    a.session.mockRejectedValue({ kind: "other", message: TOKEN_INVALID });
    renderWithClient(<ArgocdTab active />);
    expect(await screen.findByLabelText(TOKEN_LABEL)).toBeInTheDocument();
    expect(screen.getByText(TOKEN_INVALID)).toBeInTheDocument();
  });

  test("after a new token the list is read again, without the old error", async () => {
    keychain.add(STG.url);
    a.apps.mockRejectedValueOnce({ kind: "other", message: TOKEN_INVALID });
    renderWithClient(<ArgocdTab active />);
    await screen.findByLabelText(TOKEN_LABEL);
    submitToken("fresh");
    expect(await screen.findByText("stg-app")).toBeInTheDocument();
    expect(screen.queryByText(TOKEN_INVALID)).toBeNull();
  });

  test("another kind of session failure shows its message with a Retry that checks again", async () => {
    a.session.mockRejectedValueOnce({ kind: "network", message: "ArgoCD 서버에 닿지 못했어요. Tailscale·VPN 연결을 확인해 주세요 (시간 초과)" });
    renderWithClient(<ArgocdTab active />);
    expect(await screen.findByText(/Tailscale·VPN 연결을 확인해 주세요/)).toBeInTheDocument();
    expect(screen.queryByLabelText(TOKEN_LABEL)).toBeNull();
    keychain.add(STG.url);
    fireEvent.click(screen.getByRole("button", { name: RETRY }));
    expect(await screen.findByText("stg-app")).toBeInTheDocument();
  });

  test("Change token opens the form (Cancel goes back); Forget clears the token and its data", async () => {
    keychain.add(STG.url);
    renderWithClient(<ArgocdTab active />);
    await screen.findByText("stg-app");
    fireEvent.click(screen.getByRole("button", { name: TOKEN_CHANGE }));
    expect(screen.getByLabelText(TOKEN_LABEL)).toBeInTheDocument();
    expect(screen.queryByText("stg-app")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: TOKEN_CANCEL }));
    expect(await screen.findByText("stg-app")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: TOKEN_FORGET }));
    expect(await screen.findByLabelText(TOKEN_LABEL)).toBeInTheDocument();
    expect(a.forgetToken).toHaveBeenCalledWith(STG.url);
    expect(screen.queryByText("stg-app")).toBeNull();
    expect(screen.queryByRole("button", { name: TOKEN_CANCEL })).toBeNull();
    expect(screen.queryByRole("button", { name: TOKEN_FORGET })).toBeNull();
  });
});

describe("switching servers", () => {
  test("each server keeps its own data and its own token state", async () => {
    renderWithClient(<ArgocdTab active />);
    await screen.findByLabelText(TOKEN_LABEL);
    submitToken("stg-token");
    expect(await screen.findByText("stg-app")).toBeInTheDocument();

    // ops는 토큰이 없다: 폼이 뜨고 stg의 목록은 보이지 않는다
    fireEvent.change(serverSelect(), { target: { value: OPS.url } });
    expect(await screen.findByLabelText(TOKEN_LABEL)).toHaveValue("");
    expect(screen.queryByText("stg-app")).toBeNull();
    submitToken("ops-token");
    expect(await screen.findByText("ops-app")).toBeInTheDocument();
    expect(screen.queryByText("stg-app")).toBeNull();
    expect(screen.getByText("admin · v3.3.6")).toBeInTheDocument();
    expect(a.setToken).toHaveBeenNthCalledWith(2, OPS.url, "ops-token");

    // 다시 stg로: 토큰을 다시 묻지 않고 stg의 목록이 보인다
    fireEvent.change(serverSelect(), { target: { value: STG.url } });
    expect(await screen.findByText("stg-app")).toBeInTheDocument();
    expect(screen.queryByText("ops-app")).toBeNull();
    expect(screen.queryByLabelText(TOKEN_LABEL)).toBeNull();
    expect(a.apps).toHaveBeenCalledWith(STG.url);
    expect(a.apps).toHaveBeenCalledWith(OPS.url);
  });

  test("each server remembers its own filters and grouping", async () => {
    const view = (groupBy: string): ArgoViewState => ({ sync: [], health: [], envs: [], clusters: [], projects: [], labels: [], groupBy, thenBy: null });
    vi.mocked(api.getSettings).mockResolvedValue({ ...SETTINGS, argocdViews: { [OPS.url]: view("project") } });
    keychain = new Set([STG.url, OPS.url]);
    renderWithClient(<ArgocdTab active />);
    await screen.findByText("stg-app");
    const groupSel = () => screen.getByRole("combobox", { name: ARGO_GROUP_BY });
    expect(groupSel()).toHaveValue("set");
    fireEvent.change(groupSel(), { target: { value: "env" } });
    await waitFor(() => expect(api.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ argocdViews: { [OPS.url]: view("project"), [STG.url]: { ...view("env"), thenBy: "none" } } })));

    fireEvent.change(serverSelect(), { target: { value: OPS.url } });
    await screen.findByText("ops-app");
    expect(groupSel()).toHaveValue("project");
    fireEvent.change(serverSelect(), { target: { value: STG.url } });
    await screen.findByText("stg-app");
    expect(groupSel()).toHaveValue("env");
  });

  test("a half-typed token does not follow you to another server", async () => {
    renderWithClient(<ArgocdTab active />);
    fireEvent.change(await screen.findByLabelText(TOKEN_LABEL), { target: { value: "half" } });
    fireEvent.change(serverSelect(), { target: { value: OPS.url } });
    await waitFor(() => expect(screen.getByLabelText(TOKEN_LABEL)).toHaveValue(""));
    fireEvent.change(serverSelect(), { target: { value: STG.url } });
    await waitFor(() => expect(screen.getByLabelText(TOKEN_LABEL)).toHaveValue(""));
  });

  test("a token error on one server does not send the other one to the form", async () => {
    keychain.add(STG.url);
    keychain.add(OPS.url);
    a.apps.mockImplementation(async (url) => {
      if (url === STG.url) throw { kind: "other", message: TOKEN_INVALID };
      return [row("ops-app")];
    });
    renderWithClient(<ArgocdTab active />);
    await screen.findByLabelText(TOKEN_LABEL);
    fireEvent.change(serverSelect(), { target: { value: OPS.url } });
    expect(await screen.findByText("ops-app")).toBeInTheDocument();
    expect(screen.queryByLabelText(TOKEN_LABEL)).toBeNull();
  });
});

describe("the tab around it", () => {
  test("an empty server shows the empty state", async () => {
    keychain.add(STG.url);
    a.apps.mockResolvedValue([]);
    renderWithClient(<ArgocdTab active />);
    expect(await screen.findByText(ARGO_NO_APPS)).toBeInTheDocument();
  });

  test("an inactive tab does not touch the server", async () => {
    renderWithClient(<ArgocdTab active={false} />);
    await screen.findByRole("combobox", { name: SERVER_LABEL });
    expect(a.session).not.toHaveBeenCalled();
    expect(a.apps).not.toHaveBeenCalled();
  });

  test("a settings failure is shown", async () => {
    vi.mocked(api.getSettings).mockRejectedValue({ kind: "other", message: "설정을 읽지 못했어요" });
    renderWithClient(<ArgocdTab active />);
    expect(await screen.findByText("설정을 읽지 못했어요")).toBeInTheDocument();
  });

  test("waits for settings before asking anything", () => {
    vi.mocked(api.getSettings).mockReturnValue(new Promise(() => {}));
    renderWithClient(<ArgocdTab active />);
    expect(screen.getByText(LOADING)).toBeInTheDocument();
    expect(a.session).not.toHaveBeenCalled();
  });
});
