import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Flow, flowGraph } from "./Flow";
import { sampleTopic, snsTarget, sqsSubscription } from "./fixtures";
import type { SnsPublisher } from "./types";

const publishers: SnsPublisher[] = [{ kind: "alarm", name: "alarm-a", arn: null, principal: "cloudwatch.amazonaws.com", configured: true }, { kind: "policy", name: "계정", arn: null, principal: null, configured: false }];
vi.mock("./queries", () => ({
  useSnsPublishers: (_target: unknown, deep: boolean) => ({ data: { publishers: deep ? [...publishers, { kind: "s3", name: "bucket-a", configured: true }] : publishers, errors: [], scanned: deep ? { buckets: 1, functions: 2 } : null }, isFetching: false, error: null, refetch: vi.fn() }),
  useSnsDiagnosis: () => ({ data: { metrics: { published: 8, delivered: 7, failed: 1 } } }),
}));

test("설정과 정책 발행자 및 구독과 DLQ를 구분한다", () => {
  const graph = flowGraph(sampleTopic(), publishers);
  expect(graph.edges.find(e => e.id === "pub:0")?.dashed).toBe(false);
  expect(graph.edges.find(e => e.id === "pub:1")?.dashed).toBe(true);
  expect(graph.edges.find(e => e.id === "endpoint-edge:0")?.label).toBe("필터 · raw");
  expect(graph.nodes.some(n => n.detail === "DLQ")).toBe(true);
});

test("엔드포인트로 이동하고 더 찾기 결과를 보여 준다", () => {
  const onOpen = vi.fn();
  render(<Flow topic={sampleTopic()} target={snsTarget} onOpen={onOpen} />);
  fireEvent.click(screen.getByRole("button", { name: /orders-queue.fifo sqs/ }));
  expect(onOpen).toHaveBeenCalledWith(sqsSubscription.key);
  fireEvent.click(screen.getByRole("button", { name: "더 찾기" }));
  expect(screen.getByText("버킷 1개 · 함수 2개 확인")).toBeTruthy();
  expect(screen.getAllByText("bucket-a").length).toBeGreaterThan(0);
});
