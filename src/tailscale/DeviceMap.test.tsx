import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { ApiPeersView } from "./ApiPeersView";
import { devicesApi } from "./api";
import type { TsNode } from "./types";

vi.mock("./api", () => ({ devicesApi: { list: vi.fn(), changes: vi.fn() } }));
const node: TsNode = { cli: null, version: null, backendState: null, health: [], tailnet: null, magicDnsSuffix: null, user: null, self: null, prefs: null, peers: [] };

test("map follows search and opens a device before returning to its filtered table", async () => {
  vi.mocked(devicesApi.list).mockResolvedValue([
    { id: "a", name: "alpha.example", hostname: "alpha", tags: ["tag:team"], findings: ["stale"] },
    { id: "b", name: "beta.example", hostname: "beta", tags: ["tag:other"], findings: [] },
  ]);
  vi.mocked(devicesApi.changes).mockResolvedValue([]);
  renderWithClient(<ApiPeersView node={node} tailnet="example" />);
  await screen.findByLabelText("alpha.example 선택");
  fireEvent.change(screen.getByLabelText("기기 검색"), { target: { value: "alpha" } });
  fireEvent.click(screen.getByRole("button", { name: "지도" }));
  const map = screen.getByLabelText("지도");
  expect(within(map).getByText("tag:team (1)")).toBeInTheDocument();
  expect(within(map).queryByText("tag:other (1)")).not.toBeInTheDocument();
  fireEvent.click(within(map).getByRole("button", { name: "alpha.example" }));
  expect(screen.getByLabelText("기기 상세")).toHaveTextContent("alpha.example");
  fireEvent.click(screen.getByRole("button", { name: "표에서 보기" }));
  expect(screen.getByLabelText("alpha.example 선택")).toBeInTheDocument();
  expect(screen.queryByLabelText("beta.example 선택")).not.toBeInTheDocument();
});

test("the device detail closes by clicking the same device again, an empty spot of the map, or Esc", async () => {
  vi.mocked(devicesApi.list).mockResolvedValue([{ id: "a", name: "alpha.example", hostname: "alpha", tags: ["tag:team"], findings: [] }]);
  vi.mocked(devicesApi.changes).mockResolvedValue([]);
  renderWithClient(<ApiPeersView node={node} tailnet="example" />);
  await screen.findByLabelText("alpha.example 선택");
  fireEvent.click(screen.getByRole("button", { name: "지도" }));
  const map = screen.getByLabelText("지도");
  const chip = within(map).getByRole("button", { name: "alpha.example" });

  fireEvent.click(chip);
  expect(screen.getByLabelText("기기 상세")).toBeInTheDocument();
  fireEvent.click(chip);
  expect(screen.queryByLabelText("기기 상세")).not.toBeInTheDocument();

  fireEvent.click(chip);
  // 잡지 않았던 지도를 처음 누르면 잡기만 하고 상세는 그대로다
  fireEvent.mouseDown(map, { clientX: 10, clientY: 10 });
  fireEvent.click(map, { clientX: 10, clientY: 10 });
  expect(screen.getByLabelText("기기 상세")).toBeInTheDocument();
  fireEvent.mouseDown(map, { clientX: 10, clientY: 10 });
  fireEvent.click(map, { clientX: 10, clientY: 10 });
  expect(screen.queryByLabelText("기기 상세")).not.toBeInTheDocument();

  fireEvent.click(chip);
  // 끌어서 옮긴 뒤 떼는 것은 빈 곳 누르기가 아니다
  fireEvent.mouseDown(map, { clientX: 10, clientY: 10 });
  fireEvent.click(map, { clientX: 80, clientY: 60 });
  expect(screen.getByLabelText("기기 상세")).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByLabelText("기기 상세")).not.toBeInTheDocument();
});
