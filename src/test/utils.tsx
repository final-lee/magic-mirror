import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import type { Column, Resource, ServiceInfo } from "../api/types";

export function renderWithClient(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { qc, ...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>) };
}

export function makeResource(id: string, values: Record<string, string>, extra: Partial<Resource> = {}): Resource {
  return { id, name: values.name ?? id, arn: null, values, tags: {}, fields: [], raw: "", consoleUrl: null, ...extra };
}

/** 표의 텍스트 열. 라벨을 생략하면 키를 쓴다. */
export const column = (key: string, label = key): Column => ({ key, label, kind: "text" });

/** RDS 서비스 정의(유형 이름은 백엔드 어댑터와 같다). 목록의 행은 dbRow로 만든다. */
export const rdsService: ServiceInfo = {
  id: "rds",
  name: "RDS",
  global: false,
  types: [
    { id: "db-instances", name: "DB Instances", columns: [column("name", "Identifier"), column("engine", "Engine")] },
    { id: "db-clusters", name: "DB Clusters", columns: [column("name", "Identifier"), column("engine", "Engine")] },
  ],
};

/** RDS 목록의 행. 클러스터에 속한 인스턴스는 extra로 `{ cluster }`를 준다. */
export const dbRow = (id: string, engine: string, extra: Record<string, string> = {}): Resource => makeResource(id, { name: id, engine, ...extra });

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
