import { act, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { SecretKeys } from "./SecretKeys";
import { SHOW_VALUE } from "./text";
import type { K8sSecretValue } from "./types";

const { stateUpdates } = vi.hoisted(() => ({ stateUpdates: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof React>();
  return {
    ...actual,
    useState: ((initial: unknown) => {
      const [state, setState] = actual.useState(initial);
      return [state, (value: unknown) => { stateUpdates(value); setState(value); }];
    }) as typeof actual.useState,
  };
});
vi.mock("./api", () => ({ k8sApi: { secretValue: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

test("a pending response never invokes a state setter after unmount", async () => {
  let resolve!: (value: K8sSecretValue) => void;
  vi.mocked(k8sApi.secretValue).mockReturnValueOnce(new Promise((r) => (resolve = r)));
  const view = render(withClientAndSso(
    <SecretKeys target={{ profile: "app", region: "r", cluster: "c" }} ssoProfile="prod-ro" namespace="web" name="db" keys={[{ key: "password", size: 7 }]} canRead="yes" />,
    newQueryClient(), ssoLoginStub(),
  ));
  fireEvent.click(screen.getByRole("button", { name: SHOW_VALUE }));
  view.unmount();
  stateUpdates.mockClear();
  await act(async () => resolve({ text: "late-secret", encoding: "utf8" }));
  expect(stateUpdates).not.toHaveBeenCalled();
});
