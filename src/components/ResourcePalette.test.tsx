import { fireEvent, screen } from "@testing-library/react";
import { api } from "../api/client";
import type { IndexedList, IndexedResource } from "../api/types";
import { renderWithClient, sampleServices } from "../test/utils";
import { PALETTE_TITLE, ResourcePalette } from "./ResourcePalette";

vi.mock("../api/client", () => ({ api: { resourceIndex: vi.fn() } }));
const m = vi.mocked(api);

const NOW = 1_800_000_000_000;
const item = (id: string, name = id): IndexedResource => ({ id, name, arn: null, values: { name, id }, tags: {} });
const list = (region: string, service: string, typeId: string, items: IndexedResource[], fetchedAt = NOW): IndexedList => ({ region, service, typeId, fetchedAt, truncated: false, items });
const ec2AndIam = sampleServices.filter((s) => s.id !== "s3");

function open(onPick = vi.fn()) {
  renderWithClient(<ResourcePalette profile="prod" services={ec2AndIam} ttlMs={15 * 60_000} onPick={onPick} onClose={() => {}} now={NOW} />);
  return onPick;
}
const search = (q: string) => fireEvent.change(screen.getByRole("searchbox", { name: PALETTE_TITLE }), { target: { value: q } });
const results = () => screen.queryAllByRole("option").map((o) => o.querySelector(".pk-name")?.textContent);

beforeEach(() => {
  m.resourceIndex.mockResolvedValue([
    list("ap-northeast-2", "ec2", "instances", [item("i-1", "web-1"), item("i-2", "batch")]),
    list("us-west-2", "ec2", "instances", [item("i-9", "web-west")], NOW - 3 * 3_600_000),
    list("global", "s3", "buckets", [item("web-assets")]),
    list("global", "iam", "users", [item("alice")]),
  ]);
});

test("searches every cached list of the profile across regions and types, skipping services turned off", async () => {
  open();
  expect(await screen.findByText(/읽어 둔 목록 3개, 리소스 4개/)).toBeInTheDocument();
  expect(m.resourceIndex).toHaveBeenCalledWith("prod");
  search("web");
  expect(results()).toEqual(["web-1", "web-west"]);
  expect(screen.getByText(/us-west-2/)).toBeInTheDocument();
  expect(screen.getByText("3시간 전")).toBeInTheDocument();
});

test("tokens can match the service, type and region as well as the resource", async () => {
  open();
  await screen.findByText(/읽어 둔 목록/);
  search("west web");
  expect(results()).toEqual(["web-west"]);
  search("users ali");
  expect(results()).toEqual(["alice"]);
});

test("arrows move the highlight and Enter picks that resource with its region and type", async () => {
  const onPick = open();
  await screen.findByText(/읽어 둔 목록/);
  search("web");
  const box = screen.getByRole("searchbox", { name: PALETTE_TITLE });
  fireEvent.keyDown(box, { key: "ArrowDown" });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onPick).toHaveBeenCalledWith({ region: "us-west-2", service: "ec2", type: "instances", id: "i-9" });
});

test("with nothing cached yet it says how to fill the cache", async () => {
  m.resourceIndex.mockResolvedValue([]);
  open();
  expect(await screen.findByText(/아직 읽어 둔 목록이 없어요/)).toBeInTheDocument();
});
