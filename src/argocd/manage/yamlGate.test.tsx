import { fireEvent, render, screen } from "@testing-library/react";
import { typeYaml } from "../../test/codemirror";
import type { ArgoAppRow } from "../types";
import { YamlEditPane } from "./YamlEditPane";
import { appNamespaceOf, appTemplate, destinationsOf, gateCreate, withDestination, withProject } from "./newApp";
import { gateYaml } from "./yamlGate";
import { MANAGE_PREVIEW, MANAGE_YAML_LABEL } from "./text";

const row = (name: string, project: string, destination: string, destNamespace: string, namespace = "argocd"): ArgoAppRow => ({ name, namespace, resourceVersion: "1", labels: {}, values: { project, destination, destNamespace } });

test("a syntax error, an empty text, several documents or a list block the preview", () => {
  expect(gateYaml("a: b\n").ok).toBe(true);
  expect(gateYaml("a: [").ok).toBe(false);
  expect(gateYaml("a: [").reason).toMatch(/^1번째 줄/);
  expect(gateYaml("  \n").ok).toBe(false);
  expect(gateYaml("a: 1\n---\nb: 2\n").ok).toBe(false);
  expect(gateYaml("- a\n- b\n").ok).toBe(false);
  expect(gateYaml("just text").ok).toBe(false);
});

test("the YAML editor only previews a valid, changed spec", () => {
  const onPreview = vi.fn();
  render(<YamlEditPane spec={{ project: "default" }} onPreview={onPreview} />);
  const preview = screen.getByRole("button", { name: MANAGE_PREVIEW });
  expect(preview).toBeDisabled();

  typeYaml("project: [", MANAGE_YAML_LABEL);
  expect(preview).toBeDisabled();
  expect(screen.getByRole("alert")).toBeInTheDocument();

  typeYaml("project: team-a\n", MANAGE_YAML_LABEL);
  expect(preview).toBeEnabled();
  fireEvent.click(preview);
  expect(onPreview).toHaveBeenCalledWith("project: team-a\n");
});

test("a new app template is a valid Application for the busiest namespace", () => {
  const rows = [row("a", "team-a", "in-cluster", "web", "gitops"), row("b", "team-a", "in-cluster", "web", "gitops"), row("c", "default", "prod-eks", "api", "other")];
  expect(appNamespaceOf(rows)).toBe("gitops");
  expect(appNamespaceOf([])).toBe("argocd");
  const gate = gateCreate(appTemplate(rows), rows);
  expect(gate.ok).toBe(true);
  expect(gate.target).toMatchObject({ namespace: "gitops", name: "my-app", project: "default" });
});

test("create needs a name, an Application kind and a spec", () => {
  const rows: ArgoAppRow[] = [];
  expect(gateCreate("kind: Deployment\nmetadata:\n  name: x\nspec: {}\n", rows).ok).toBe(false);
  expect(gateCreate("kind: Application\nmetadata: {}\nspec: {}\n", rows).ok).toBe(false);
  expect(gateCreate("kind: Application\nmetadata:\n  name: x\n", rows).ok).toBe(false);
  expect(gateCreate("kind: Application\nmetadata:\n  name: x\nspec: {}\n", rows)).toMatchObject({ ok: true, target: { name: "x", namespace: "argocd", project: "default" } });
});

test("picking a project or destination rewrites only those fields and keeps the rest", () => {
  const text = appTemplate([]);
  const picked = withDestination(withProject(text, "team-b"), { cluster: "prod-eks", namespace: "api" });
  expect(picked).toContain("project: team-b");
  expect(picked).toContain("name: prod-eks");
  expect(picked).not.toContain("server:");
  expect(picked).toContain("namespace: api");
  expect(picked).toContain("CreateNamespace=true");
  expect(withDestination(text, { cluster: "https://k8s.example", namespace: "" })).toContain("server: https://k8s.example");
  // 구문이 틀린 글은 건드리지 않는다
  expect(withProject("a: [", "x")).toBe("a: [");
});

test("destination choices come from the rows, most used first, without duplicates", () => {
  const rows = [row("a", "p", "in-cluster", "web"), row("b", "p", "in-cluster", "web"), row("c", "p", "prod-eks", "api")];
  expect(destinationsOf(rows)).toEqual([
    { cluster: "in-cluster", namespace: "web" },
    { cluster: "prod-eks", namespace: "api" },
  ]);
});
