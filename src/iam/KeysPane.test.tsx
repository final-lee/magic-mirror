import { fireEvent, screen, within } from "@testing-library/react";
import { findFor, pressFindKey } from "../test/find";
import { renderWithClient } from "../test/utils";
import { iamApi } from "./api";
import { bobKeys } from "./fixtures";
import { KeysPane } from "./KeysPane";

vi.mock("./api", () => ({ iamApi: { accessKeys: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(iamApi);
const keyRows = () => within(screen.getByRole("table", { name: "액세스 키" })).getAllByRole("row").slice(1);

beforeEach(() => {
  vi.clearAllMocks();
  m.accessKeys.mockResolvedValue(bobKeys);
});

test("nothing before ⌘F; ⌘F filters only the keys by id, status or service; Esc clears and closes", async () => {
  renderWithClient(<KeysPane profile="prod" userName="bob" onFix={vi.fn()} />);
  await screen.findByRole("table", { name: "액세스 키" });
  expect(screen.queryByRole("search")).toBeNull();
  expect(keyRows()).toHaveLength(3);
  const input = findFor("inactive");
  expect(input).toHaveFocus();
  expect(keyRows()).toHaveLength(1);
  expect(within(keyRows()[0]).getByText("AKIAI44QH8DHBEXAMPLE")).toBeInTheDocument();
  findFor("s3");
  expect(within(keyRows()[0]).getByText("AKIAIOSFODNN7EXAMPLE")).toBeInTheDocument();
  findFor("zzzz");
  expect(screen.getByText("조건에 맞는 키가 없어요")).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("search")).toBeNull();
  expect(keyRows()).toHaveLength(3);
});

test("with no keys there is nothing to find in", async () => {
  m.accessKeys.mockResolvedValue([]);
  renderWithClient(<KeysPane profile="prod" userName="bob" onFix={vi.fn()} />);
  await screen.findByText("액세스 키가 없어요");
  expect(pressFindKey()).toBe(false);
});
