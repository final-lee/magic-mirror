import { render, screen } from "@testing-library/react";
import { MyRules } from "./MyRules";
import { CORE_GROUP, WILDCARD } from "./text";

test("expands group x resource and maps core and wildcard", () => {
  render(
    <MyRules allNamespaces={false} rules={{ namespace: "d", incomplete: false, nonResourceRules: [], resourceRules: [{ verbs: ["get"], apiGroups: ["", "*"], resources: ["pods"], resourceNames: [] }] }} />,
  );
  expect(screen.getAllByRole("row")).toHaveLength(3);
  expect(screen.getByText(CORE_GROUP)).toBeInTheDocument();
  expect(screen.getAllByText(WILDCARD)).toHaveLength(3); // 이름 비어 있음 x2, 그룹 *
});
