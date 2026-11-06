import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { tailscaleApi } from "./api";
import { SettingsView } from "./SettingsView";
import { useTailscaleApi } from "./useTailscaleApi";

vi.mock("./api", () => ({ tailscaleApi: { settings: vi.fn(), settingsSave: vi.fn(), contactSave: vi.fn() } }));
vi.mock("./useTailscaleApi", () => ({ useTailscaleApi: vi.fn() }));

test("only previews and patches the changed setting", async () => {
  vi.mocked(useTailscaleApi).mockReturnValue({ tailnet: "example.com", connected: true, isLoading: false });
  vi.mocked(tailscaleApi.settings).mockImplementation(async (_tailnet, contacts) => contacts ? {} : {
    devicesApprovalOn: false, usersApprovalOn: false,
  });
  vi.mocked(tailscaleApi.settingsSave).mockResolvedValue(null);
  renderWithClient(<SettingsView />);
  const heading = await screen.findByText("새 기기 승인 필요");
  fireEvent.click(within(heading.closest("tr")!).getByRole("button", { name: "켜기" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/PATCH/)).toHaveTextContent("/tailnet/-/settings");
  expect(within(dialog).getByText(/devicesApprovalOn/)).toHaveTextContent('"devicesApprovalOn": true');
  expect(tailscaleApi.settingsSave).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "적용" }));
  await waitFor(() => expect(tailscaleApi.settingsSave).toHaveBeenCalledWith("example.com", "devicesApprovalOn", false, true));
});
