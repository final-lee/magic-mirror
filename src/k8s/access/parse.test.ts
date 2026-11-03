import { buildQuery, parseResource } from "./parse";

test("a plain resource is a core resource", () => {
  expect(parseResource("pods")).toEqual({ group: "", resource: "pods", subresource: null });
});

test("the group is everything after the first dot, even for custom groups", () => {
  expect(parseResource("deployments.apps")).toEqual({ group: "apps", resource: "deployments", subresource: null });
  expect(parseResource("widgets.mm.example.com")).toEqual({ group: "mm.example.com", resource: "widgets", subresource: null });
});

test("a subresource follows a slash and may be combined with a group", () => {
  expect(parseResource("pods/exec")).toEqual({ group: "", resource: "pods", subresource: "exec" });
  expect(parseResource(" deployments.apps/scale ")).toEqual({ group: "apps", resource: "deployments", subresource: "scale" });
});

test("empty or nameless input is not a resource", () => {
  expect(parseResource("")).toBeNull();
  expect(parseResource("   ")).toBeNull();
  expect(parseResource(".apps")).toBeNull();
});

test("a query needs a verb and a resource; blank namespace and name become null", () => {
  expect(buildQuery("get", "secrets", "", " ")).toEqual({ verb: "get", group: "", resource: "secrets", subresource: null, namespace: null, name: null });
  expect(buildQuery("get", "configmaps", "dev", "app")).toMatchObject({ namespace: "dev", name: "app" });
  expect(buildQuery("", "pods", "", "")).toBeNull();
  expect(buildQuery("get", "", "", "")).toBeNull();
});
