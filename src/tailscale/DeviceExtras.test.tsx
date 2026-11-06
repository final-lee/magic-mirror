import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { devicesApi } from "./api";
import { DeviceExtras } from "./DeviceExtras";

vi.mock("./api", () => ({ devicesApi: { extraList: vi.fn(), extraApply: vi.fn() } }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(devicesApi.extraList).mockImplementation(async (_tailnet, _id, invites) => invites ? [] : { attributes: {}, expiries: {} });
  vi.mocked(devicesApi.extraApply).mockResolvedValue(null);
});

test("previews custom posture attributes before the batch PATCH", async () => {
  renderWithClient(<DeviceExtras tailnet="example.com" ids={["d1"]} close={() => {}} />);
  const key = await screen.findByLabelText("속성 이름 (custom:)");
  await waitFor(() => expect(screen.getByRole("button", { name: "속성 설정" })).toBeEnabled());
  fireEvent.change(key, { target: { value: "custom:trust" } });
  fireEvent.change(screen.getByLabelText("값 (JSON 문자열·숫자·불리언)"), { target: { value: "true" } });
  fireEvent.click(screen.getByRole("button", { name: "속성 설정" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/PATCH \/tailnet\/-\/device-attributes/)).toBeInTheDocument();
  expect(devicesApi.extraApply).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "적용" }));
  await waitFor(() => expect(devicesApi.extraApply).toHaveBeenCalledWith(expect.objectContaining({
    action: "attributes", body: { nodes: { d1: { "custom:trust": { value: true } } } },
  })));
});

test("previews a device share invitation before creating it", async () => {
  renderWithClient(<DeviceExtras tailnet="example.com" ids={["d1"]} close={() => {}} />);
  fireEvent.change(await screen.findByPlaceholderText("email"), { target: { value: "peer@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "공유 초대 만들기" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/POST \/device\/d1\/device-invites/)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "적용" }));
  await waitFor(() => expect(devicesApi.extraApply).toHaveBeenCalledWith(expect.objectContaining({
    action: "createInvite", id: "d1", body: { email: "peer@example.com", allowExitNode: false, multiUse: false },
  })));
});

test("empty space and Escape close the details panel", async () => {
  const close = vi.fn();
  renderWithClient(<div className="argowf-list"><DeviceExtras tailnet="example.com" ids={["d1"]} close={close} /></div>);
  await screen.findByText("기기 포스처와 공유");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(close).toHaveBeenCalledTimes(1);
  fireEvent.mouseDown(screen.getByText("기기 포스처와 공유").closest(".argowf-list")!);
  expect(close).toHaveBeenCalledTimes(2);
});
