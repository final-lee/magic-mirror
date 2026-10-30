import { fireEvent, screen } from "@testing-library/react";
import { api } from "../api/client";
import { eksService, makeResource, renderWithClient } from "../test/utils";
import { ClusterPicker } from "./ClusterPicker";
import { PICKER_EMPTY, PICKER_TITLE } from "./text";

vi.mock("../api/client", () => ({ api: { listResources: vi.fn(), ssoLogin: vi.fn() } }));

const cluster = (name: string, version: string, status: string) => makeResource(name, { name, version, status });

function setup(items: ReturnType<typeof cluster>[]) {
  vi.mocked(api.listResources).mockResolvedValue({ items, truncated: false });
  const onPick = vi.fn();
  const onClose = vi.fn();
  renderWithClient(<ClusterPicker service={eksService} profile="prod" region="ap-northeast-2" onPick={onPick} onClose={onClose} />);
  return { onPick, onClose };
}

test("lists the clusters of the region with version and status", async () => {
  setup([cluster("prod", "1.31", "ACTIVE"), cluster("dev", "1.30", "CREATING")]);
  expect(await screen.findByText("prod")).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: PICKER_TITLE })).toBeInTheDocument();
  expect(screen.getByText("1.31 · ACTIVE")).toBeInTheDocument();
  expect(screen.getByText("1.30 · CREATING")).toBeInTheDocument();
  expect(api.listResources).toHaveBeenCalledWith("prod", "ap-northeast-2", "eks", "clusters");
});

test("says so when the region has no cluster", async () => {
  setup([]);
  expect(await screen.findByText(PICKER_EMPTY)).toBeInTheDocument();
});

test("choosing a cluster reports its name", async () => {
  const { onPick } = setup([cluster("prod", "1.31", "ACTIVE")]);
  fireEvent.click(await screen.findByText("prod"));
  expect(onPick).toHaveBeenCalledWith("prod");
});

test("Escape and the close button close it", async () => {
  const { onClose } = setup([cluster("prod", "1.31", "ACTIVE")]);
  await screen.findByText("prod");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(onClose).toHaveBeenCalledTimes(2);
});
