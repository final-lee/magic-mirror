import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../../test/utils";
import { manageApi } from "./api";
import { NotificationsPane } from "./NotificationsPane";
import { MANAGE_NOTIFY_ADD, MANAGE_NOTIFY_RECIPIENTS, MANAGE_NOTIFY_SERVICE, MANAGE_NOTIFY_TRIGGER, MANAGE_NOTIFY_UNAVAILABLE } from "./text";

vi.mock("./api", () => ({ manageApi: { notificationCatalog: vi.fn() } }));
const api = vi.mocked(manageApi);
const KEY = "notifications.argoproj.io/subscribe.on-sync-failed.slack";

beforeEach(() => {
  vi.resetAllMocks();
  api.notificationCatalog.mockResolvedValue({ services: ["slack"], triggers: ["on-sync-failed"], templates: [] });
});

test("existing subscriptions are listed, removed with a null annotation and added from the form", async () => {
  const onPatch = vi.fn();
  renderWithClient(<NotificationsPane url="https://argo.test" annotations={{ [KEY]: "alerts", other: "x" }} onPatch={onPatch} />);
  expect(await screen.findByText("alerts")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /삭제/ }));
  expect(onPatch).toHaveBeenLastCalledWith({ metadata: { annotations: { [KEY]: null } } });

  const add = screen.getByRole("button", { name: MANAGE_NOTIFY_ADD });
  expect(add).toBeDisabled();
  fireEvent.change(screen.getByLabelText(MANAGE_NOTIFY_TRIGGER), { target: { value: "on-deployed" } });
  fireEvent.change(screen.getByLabelText(MANAGE_NOTIFY_SERVICE), { target: { value: "email" } });
  fireEvent.change(screen.getByLabelText(MANAGE_NOTIFY_RECIPIENTS), { target: { value: "me@example.com" } });
  expect(add).toBeEnabled();
  fireEvent.click(add);
  expect(onPatch).toHaveBeenLastCalledWith({ metadata: { annotations: { "notifications.argoproj.io/subscribe.on-deployed.email": "me@example.com" } } });
});

test("when the server's notification setup cannot be read the names are typed by hand", async () => {
  api.notificationCatalog.mockRejectedValue({ kind: "other", message: "no notifications" });
  renderWithClient(<NotificationsPane url="https://argo.test" annotations={{}} onPatch={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(MANAGE_NOTIFY_UNAVAILABLE)).toBeInTheDocument());
  expect(screen.getByLabelText(MANAGE_NOTIFY_TRIGGER)).toBeEnabled();
});
