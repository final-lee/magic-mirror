import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import type { Resource, ServiceInfo } from "../api/types";

export function renderWithClient(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { qc, ...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>) };
}

export function makeResource(id: string, values: Record<string, string>, extra: Partial<Resource> = {}): Resource {
  return { id, name: values.name ?? id, arn: null, values, tags: {}, fields: [], raw: "", consoleUrl: null, ...extra };
}

export const sampleServices: ServiceInfo[] = [
  {
    id: "ec2",
    name: "EC2",
    global: false,
    types: [
      {
        id: "instances",
        name: "Instances",
        columns: [
          { key: "name", label: "Name", kind: "text" },
          { key: "id", label: "Instance ID", kind: "mono" },
          { key: "state", label: "State", kind: "state" },
        ],
      },
      { id: "volumes", name: "Volumes", columns: [{ key: "name", label: "Name", kind: "text" }] },
    ],
  },
  {
    id: "s3",
    name: "S3",
    global: true,
    types: [
      {
        id: "buckets",
        name: "Buckets",
        columns: [
          { key: "name", label: "Bucket name", kind: "text" },
          { key: "region", label: "Region", kind: "text" },
        ],
      },
    ],
  },
  { id: "iam", name: "IAM", global: true, types: [{ id: "users", name: "Users", columns: [{ key: "name", label: "Name", kind: "text" }] }] },
];
