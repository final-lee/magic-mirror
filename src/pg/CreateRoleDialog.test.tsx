import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import { CreateRoleDialog, PRESET_DELAY_MS } from "./CreateRoleDialog";
import { pgTarget, sampleDatabaseView, sampleOverview, samplePresetSuggestion, sampleTargetInfo } from "./fixtures";
import type { PgChange, PgPresetSuggestion } from "./types";

vi.mock("./api", () => ({ pgApi: { database: vi.fn(), preset: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(pgApi);
const overview = sampleOverview();

function setup(props: Partial<React.ComponentProps<typeof CreateRoleDialog>> = {}) {
  const handlers = { onPreview: vi.fn<(change: PgChange) => void>(), onClose: vi.fn() };
  const utils = renderWithClient(<CreateRoleDialog target={pgTarget} overview={overview} database="orders" {...handlers} {...props} />);
  return { ...handlers, ...utils };
}

const user = () => userEvent.setup();
const name = () => screen.getByRole("textbox", { name: "이름" });
const previewButton = () => screen.getByRole("button", { name: "미리보기" });
const type = async (text: string) => user().type(name(), text);
const pickPreset = (label: string) => user().click(screen.getByRole("radio", { name: new RegExp(`^${label}`) }));
const pickSchemas = async (...names: string[]) => {
  for (const n of names) await user().click(await screen.findByRole("checkbox", { name: n }));
};
const waitForSuggestion = () => waitFor(() => expect(m.preset).toHaveBeenCalled());

beforeEach(() => {
  vi.clearAllMocks();
  m.database.mockResolvedValue(sampleDatabaseView());
  m.preset.mockResolvedValue(samplePresetSuggestion());
});

const base = { kind: "createRole", login: true, groups: [], connectionLimit: -1, validUntil: null, preset: null } as const;

describe("the form", () => {
  test("is a dialog titled 역할 만들기 with the name focused and the preview off until a name is typed", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "역할 만들기" })).toHaveAttribute("aria-modal", "true");
    expect(name()).toHaveFocus();
    expect(previewButton()).toBeDisabled();
  });

  test("a plain user: the change has no groups, no limit, no expiry and no preset", async () => {
    const { onPreview } = setup();
    await type("carol");
    await user().click(previewButton());
    expect(onPreview).toHaveBeenCalledWith({ ...base, name: "carol" });
  });

  test("a group is created without LOGIN", async () => {
    const { onPreview } = setup();
    await type("auditors");
    await user().click(screen.getByRole("radio", { name: "그룹" }));
    await user().click(previewButton());
    expect(onPreview).toHaveBeenCalledWith({ ...base, name: "auditors", login: false });
  });

  test("the groups to join are the groups and the allowed system groups, in name order; the ones ticked are sent in that order", async () => {
    const { onPreview } = setup();
    const boxes = within(screen.getByRole("group", { name: "속할 그룹" })).getAllByRole("checkbox").map((c) => c.closest("label")!.textContent!.trim());
    expect(boxes).toEqual(["app_read", "app_write", "pg_read_all_data", "rds_iam", "rds_superuser"]);
    await type("carol");
    await user().click(screen.getByRole("checkbox", { name: "rds_iam" }));
    await user().click(screen.getByRole("checkbox", { name: "app_read" }));
    await user().click(previewButton());
    expect(onPreview).toHaveBeenCalledWith({ ...base, name: "carol", groups: ["app_read", "rds_iam"] });
  });

  test("a connection limit and an expiry date are sent as a number and as that day at 0:00 UTC", async () => {
    const { onPreview } = setup();
    await type("carol");
    await user().click(screen.getByRole("checkbox", { name: "제한 없음" }));
    await user().type(screen.getByLabelText("연결 수 제한"), "5");
    await user().click(screen.getByRole("checkbox", { name: "없음" }));
    fireEvent.change(screen.getByLabelText("만료일"), { target: { value: "2027-01-31" } });
    await user().click(previewButton());
    expect(onPreview).toHaveBeenCalledWith({ ...base, name: "carol", connectionLimit: 5, validUntil: "2027-01-31T00:00:00Z" });
  });

  test("a limit that is not a number, or an expiry date left empty, keeps the preview off", async () => {
    setup();
    await type("carol");
    await user().click(screen.getByRole("checkbox", { name: "제한 없음" }));
    expect(previewButton()).toBeDisabled();
    await user().type(screen.getByLabelText("연결 수 제한"), "5");
    expect(previewButton()).toBeEnabled();
    await user().click(screen.getByRole("checkbox", { name: "없음" }));
    expect(previewButton()).toBeDisabled();
  });

  test("취소 closes it", async () => {
    const { onClose } = setup();
    await user().click(screen.getByRole("button", { name: "취소" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("the name", () => {
  test.each([
    ["pg_custom", "역할 이름이 올바르지 않아요. 1~63바이트이고 pg_로 시작하지 않아야 해요"],
    ["a".repeat(64), "역할 이름이 올바르지 않아요. 1~63바이트이고 pg_로 시작하지 않아야 해요"],
    ["PUBLIC", "이 이름은 PostgreSQL이 예약해 둬서 쓸 수 없어요"],
    ["alice", "이미 있는 역할이에요: alice"],
  ])("%s is refused with the backend's text", async (typed, text) => {
    setup();
    await type(typed);
    expect(screen.getByRole("alert")).toHaveTextContent(text);
    expect(previewButton()).toBeDisabled();
  });

  test("nothing is said about a name that has not been typed yet", () => {
    setup();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("the presets", () => {
  test("lists them with their descriptions", () => {
    setup();
    const group = screen.getByRole("group", { name: "프리셋" });
    expect(within(group).getAllByRole("radio").map((r) => r.closest("label")!.textContent!.trim().replace(/\s+/g, " "))).toEqual([
      "없음",
      "읽기 전용 고른 스키마의 테이블과 시퀀스를 읽어요",
      "읽기·쓰기 읽기에 더해 테이블에 쓰고 시퀀스를 써요",
      "소유자(마이그레이션) 고른 스키마에 객체를 만들 수 있어요",
      "관리자 rds_superuser 구성원이 돼요",
    ]);
    expect(screen.getByRole("radio", { name: /^없음/ })).toBeChecked();
  });

  test("관리자 needs no database or schema and sends only the preset", async () => {
    const { onPreview } = setup();
    await type("root_ish");
    await pickPreset("관리자");
    expect(screen.queryByLabelText("데이터베이스")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "스키마" })).not.toBeInTheDocument();
    await user().click(previewButton());
    expect(onPreview).toHaveBeenCalledWith({ ...base, name: "root_ish", preset: { preset: "admin", database: null, schemas: [], creators: [], group: null, createGroup: false } });
    expect(m.preset).not.toHaveBeenCalled();
  });

  test("any other preset asks for a database (the tab's by default) and schemas from that database", async () => {
    setup({ database: "analytics" });
    await pickPreset("읽기 전용");
    expect(screen.getByLabelText("데이터베이스")).toHaveValue("analytics");
    expect(within(screen.getByLabelText("데이터베이스")).getAllByRole("option").map((o) => o.textContent)).toEqual(["analytics", "orders", "postgres"]);
    expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", false);
    const schemas = within(await screen.findByRole("group", { name: "스키마" }));
    expect(await schemas.findByRole("checkbox", { name: "app" })).toBeInTheDocument();
    expect(schemas.getByRole("checkbox", { name: "audit" })).toBeInTheDocument();
  });

  test("picking another database empties the schemas and lists that database's", async () => {
    setup();
    await pickPreset("읽기 전용");
    await pickSchemas("app");
    await user().selectOptions(screen.getByLabelText("데이터베이스"), "postgres");
    expect(m.database).toHaveBeenLastCalledWith(pgTarget, "postgres", false);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "app" })).not.toBeChecked());
  });

  test("pg_preset is called once, 300 ms after the last change to the database, preset or schemas", async () => {
    setup();
    await pickPreset("읽기 전용");
    await pickSchemas("app");
    await pickSchemas("audit");
    expect(PRESET_DELAY_MS).toBe(300);
    expect(m.preset).not.toHaveBeenCalled();
    await waitForSuggestion();
    expect(m.preset).toHaveBeenCalledTimes(1);
    expect(m.preset).toHaveBeenCalledWith(pgTarget, "orders", "readOnly", ["app", "audit"]);
  });

  test("while the suggestion is on its way the preview stays off, and an older suggestion is not used for the new choice", async () => {
    setup();
    await type("carol");
    await pickPreset("읽기 전용");
    await pickSchemas("app");
    expect(previewButton()).toBeDisabled();
    expect(screen.getByText("제안을 불러오는 중…")).toBeInTheDocument();
    await screen.findByRole("group", { name: "권한을 받을 그룹" });
    expect(previewButton()).toBeEnabled();
    await pickSchemas("audit");
    expect(previewButton()).toBeDisabled();
    await waitFor(() => expect(previewButton()).toBeEnabled());
  });

  test("without a schema there is nothing to ask and the preview stays off", async () => {
    setup();
    await type("carol");
    await pickPreset("소유자\\(마이그레이션\\)");
    expect(previewButton()).toBeDisabled();
    expect(m.preset).not.toHaveBeenCalled();
  });

  test("a failed suggestion says why", async () => {
    m.preset.mockRejectedValue({ kind: "other", message: "질의가 30초 안에 끝나지 않았어요" });
    setup();
    await type("carol");
    await pickPreset("읽기 전용");
    await pickSchemas("app");
    expect(await screen.findByText("질의가 30초 안에 끝나지 않았어요")).toBeInTheDocument();
    expect(previewButton()).toBeDisabled();
  });
});

async function readyUser(preset: string, suggestion: Partial<PgPresetSuggestion> = {}) {
  m.preset.mockResolvedValue(samplePresetSuggestion(suggestion));
  const utils = setup();
  await type("carol");
  await pickPreset(preset);
  await pickSchemas("app");
  await screen.findByRole("group", { name: "권한을 받을 그룹" });
  return utils;
}

const preset = (extra: object) => ({ database: "orders", schemas: ["app"], ...extra });

describe("the suggestion for a user", () => {
  test("with matching groups: the first is chosen, and the change only adds the membership (no creators)", async () => {
    const { onPreview } = await readyUser("읽기 전용", { matching: ["app_read", "viewers"] });
    expect(screen.getByRole("radio", { name: "같은 권한을 가진 그룹에 넣어요" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "같은 권한을 가진 그룹" })).toHaveValue("app_read");
    expect(screen.queryByText("기본 권한을 줄 역할")).not.toBeInTheDocument();
    await user().click(previewButton());
    expect(onPreview).toHaveBeenCalledWith({ ...base, name: "carol", preset: { preset: "readOnly", ...preset({ creators: [], group: "app_read", createGroup: false }) } });
  });

  test("another matching group can be chosen", async () => {
    const { onPreview } = await readyUser("읽기·쓰기", { matching: ["app_read", "viewers"] });
    await user().selectOptions(screen.getByRole("combobox", { name: "같은 권한을 가진 그룹" }), "viewers");
    await user().click(previewButton());
    expect(onPreview).toHaveBeenCalledWith({ ...base, name: "carol", preset: { preset: "readWrite", ...preset({ creators: [], group: "viewers", createGroup: false }) } });
  });

  test("a new group: named by the user, created in the same change, with the creators ticked", async () => {
    const { onPreview } = await readyUser("읽기 전용", { matching: ["app_read"] });
    await user().click(screen.getByRole("radio", { name: "새 그룹을 만들어요" }));
    const field = screen.getByRole("textbox", { name: "새 그룹 이름" });
    expect(field).toHaveValue("audit_read");
    await user().clear(field);
    await user().type(field, "orders_ro");
    expect(screen.getByRole("group", { name: "기본 권한을 줄 역할" })).toBeInTheDocument();
    await user().click(previewButton());
    expect(onPreview).toHaveBeenCalledWith({ ...base, name: "carol", preset: { preset: "readOnly", ...preset({ creators: ["app_owner"], group: "orders_ro", createGroup: true }) } });
  });

  test("without matching groups: only the new group, named with the proposed name", async () => {
    const { onPreview } = await readyUser("읽기 전용", { matching: [] });
    expect(screen.queryByRole("radio", { name: "같은 권한을 가진 그룹에 넣어요" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "새 그룹을 만들어요" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "새 그룹 이름" })).toHaveValue("audit_read");
    await user().click(previewButton());
    expect(onPreview).toHaveBeenCalledWith({ ...base, name: "carol", preset: { preset: "readOnly", ...preset({ creators: ["app_owner"], group: "audit_read", createGroup: true }) } });
  });

  test("a new group name goes through the name rules too", async () => {
    await readyUser("읽기 전용", { matching: [] });
    const field = screen.getByRole("textbox", { name: "새 그룹 이름" });
    await user().clear(field);
    await user().type(field, "app_read");
    expect(screen.getByText("이미 있는 역할이에요: app_read")).toBeInTheDocument();
    expect(previewButton()).toBeDisabled();
    await user().clear(field);
    expect(previewButton()).toBeDisabled();
  });

  test("the new group can not take the user's own name", async () => {
    await readyUser("읽기 전용", { matching: [] });
    const field = screen.getByRole("textbox", { name: "새 그룹 이름" });
    await user().clear(field);
    await user().type(field, "carol");
    expect(screen.getByText("이미 있는 역할이에요: carol")).toBeInTheDocument();
    expect(previewButton()).toBeDisabled();
  });

  test("the owner preset has no creators but the group choice is the same", async () => {
    const { onPreview } = await readyUser("소유자\\(마이그레이션\\)", { matching: [] });
    expect(screen.queryByRole("group", { name: "기본 권한을 줄 역할" })).not.toBeInTheDocument();
    await user().click(previewButton());
    expect(onPreview).toHaveBeenCalledWith({ ...base, name: "carol", preset: { preset: "owner", ...preset({ creators: [], group: "audit_read", createGroup: true }) } });
  });
});

describe("the creators", () => {
  test("start ticked, blocked ones start unticked and disabled with their reason, and unticking leaves a creator out", async () => {
    const { onPreview } = await readyUser("읽기·쓰기", { matching: [], creators: ["app_owner", "legacy"] });
    const box = within(screen.getByRole("group", { name: "기본 권한을 줄 역할" }));
    expect(box.getByText("앞으로 이 역할들이 만드는 테이블과 시퀀스에도 같은 권한을 줘요")).toBeInTheDocument();
    expect(box.getByRole("checkbox", { name: "app_owner" })).toBeChecked();
    expect(box.getByRole("checkbox", { name: /^postgres/ })).not.toBeChecked();
    expect(box.getByRole("checkbox", { name: /^postgres/ })).toBeDisabled();
    expect(box.getByText("postgres 역할의 기본 권한을 바꿀 수 없어요. 로그인한 역할이 postgres 역할의 권한을 물려받아야 해요")).toBeInTheDocument();
    await user().click(box.getByRole("checkbox", { name: "legacy" }));
    await user().click(previewButton());
    expect(onPreview).toHaveBeenCalledWith({ ...base, name: "carol", preset: { preset: "readWrite", ...preset({ creators: ["app_owner"], group: "audit_read", createGroup: true }) } });
  });
});

describe("the suggestion for a group", () => {
  async function readyGroup(suggestion: Partial<PgPresetSuggestion>) {
    m.preset.mockResolvedValue(samplePresetSuggestion(suggestion));
    const utils = setup();
    await type("auditors");
    await user().click(screen.getByRole("radio", { name: "그룹" }));
    await pickPreset("읽기 전용");
    await pickSchemas("app");
    await waitForSuggestion();
    return utils;
  }

  test("tells that such groups exist and takes the privileges itself (group null), with the creators", async () => {
    const { onPreview } = await readyGroup({ matching: ["app_read", "viewers"] });
    expect(await screen.findByText("같은 권한을 가진 그룹이 이미 있어요: app_read, viewers")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "새 그룹을 만들어요" })).not.toBeInTheDocument();
    await user().click(previewButton());
    expect(onPreview).toHaveBeenCalledWith({ ...base, name: "auditors", login: false, preset: { preset: "readOnly", ...preset({ creators: ["app_owner"], group: null, createGroup: false }) } });
  });

  test("says nothing when there is no such group", async () => {
    await readyGroup({ matching: [] });
    await screen.findByRole("group", { name: "기본 권한을 줄 역할" });
    expect(screen.queryByText(/같은 권한을 가진 그룹이 이미 있어요/)).not.toBeInTheDocument();
  });
});

describe("fix round 1", () => {
  test("a new suggestion without matching groups resets the choice to the new group, so the change never carries group null with creators for a user", async () => {
    const { onPreview } = await readyUser("읽기 전용", { matching: ["app_read"] });
    // 이미 선택된 라디오는 눌러도 바뀌지 않으니, 새 그룹을 거쳐 사용자가 직접 고른 것으로 만든다
    await user().click(screen.getByRole("radio", { name: "새 그룹을 만들어요" }));
    await user().click(screen.getByRole("radio", { name: "같은 권한을 가진 그룹에 넣어요" }));
    expect(screen.getByRole("radio", { name: "같은 권한을 가진 그룹에 넣어요" })).toBeChecked();
    m.preset.mockResolvedValue(samplePresetSuggestion({ matching: [] }));
    await pickSchemas("audit");
    expect(await screen.findByRole("radio", { name: "새 그룹을 만들어요" })).toBeChecked();
    expect(screen.queryByRole("radio", { name: "같은 권한을 가진 그룹에 넣어요" })).not.toBeInTheDocument();
    await waitFor(() => expect(previewButton()).toBeEnabled());
    await user().click(previewButton());
    expect(onPreview).toHaveBeenCalledWith({ ...base, name: "carol", preset: { preset: "readOnly", database: "orders", schemas: ["app", "audit"], creators: ["app_owner"], group: "audit_read", createGroup: true } });
  });

  test("the schemas are in name order in the pg_preset call and in the change, whatever order they were ticked in", async () => {
    m.database.mockResolvedValue(sampleDatabaseView({ schemas: [{ name: "zeta", owner: "x", tableCount: 1 }, { name: "Alpha", owner: "x", tableCount: 1 }, { name: "beta", owner: "x", tableCount: 1 }] }));
    const { onPreview } = setup();
    await type("carol");
    await pickPreset("읽기 전용");
    await pickSchemas("zeta", "beta", "Alpha");
    await waitForSuggestion();
    expect(m.preset).toHaveBeenCalledWith(pgTarget, "orders", "readOnly", ["Alpha", "beta", "zeta"]);
    await waitFor(() => expect(previewButton()).toBeEnabled());
    await user().click(previewButton());
    expect((onPreview.mock.calls[0][0] as { preset: { schemas: string[] } }).preset.schemas).toEqual(["Alpha", "beta", "zeta"]);
  });

  test("switching between presets that pick schemas keeps the ticked schemas; to or from 관리자 or 없음 clears them", async () => {
    setup();
    await pickPreset("읽기 전용");
    await pickSchemas("app");
    await pickPreset("읽기·쓰기");
    expect(screen.getByRole("checkbox", { name: "app" })).toBeChecked();
    await pickPreset("관리자");
    await pickPreset("읽기 전용");
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "app" })).not.toBeChecked());
    await pickSchemas("app");
    await pickPreset("없음");
    await pickPreset("소유자\\(마이그레이션\\)");
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "app" })).not.toBeChecked());
  });

  test("미리보기 honours the block reason while open", async () => {
    setup({ overview: sampleOverview({ target: sampleTargetInfo({ readReplica: true }) }) });
    await type("carol");
    expect(previewButton()).toBeDisabled();
    expect(previewButton()).toHaveAttribute("title", "읽기 전용 복제본이라 바꿀 수 없어요");
  });
});
