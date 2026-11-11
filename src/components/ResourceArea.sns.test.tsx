import { fireEvent, screen, within } from "@testing-library/react";
import { api } from "../api/client";
import type { ServiceInfo } from "../api/types";
import { snsApi } from "../sns/api";
import { column, makeResource, renderWithClient } from "../test/utils";
import { ResourceArea } from "./ResourceArea";

vi.mock("../api/client", () => ({ api: { listResources: vi.fn(), ssoLogin: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));
vi.mock("../sns/api", () => ({ snsApi: { topic: vi.fn(), subscriptionsAll: vi.fn(), subscribedTopics: vi.fn() } }));

const sns: ServiceInfo = {
  id: "sns",
  name: "SNS",
  global: false,
  types: [
    { id: "topics", name: "Topics", columns: [column("name", "Name")] },
    { id: "subscriptions", name: "Subscriptions", columns: [column("name", "Topic"), column("protocol", "Protocol"), column("endpoint", "Endpoint")] },
  ],
};
const sqs: ServiceInfo = { id: "sqs", name: "SQS", global: false, types: [{ id: "queues", name: "Queues", columns: [column("name", "Name")] }] };
const lambda: ServiceInfo = { id: "lambda", name: "Lambda", global: false, types: [{ id: "functions", name: "Functions", columns: [column("name", "Name")] }] };

const REGION = "ap-northeast-2";
const ACCOUNT = "123456789012";
const TOPIC_ARN = `arn:aws:sns:${REGION}:${ACCOUNT}:orders-events`;
const QUEUE_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT}:orders-queue`;
const QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/orders-queue`;
const FUNCTION_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:order-processor`;
const props = { profile: "prod", region: REGION, account: ACCOUNT, onOpenBucket: vi.fn(), onRefresh: vi.fn(), active: true };

beforeEach(() => vi.clearAllMocks());

describe("opening the SNS tab", () => {
  test("double-clicking a topic opens its tab by ARN and name", async () => {
    vi.mocked(api.listResources).mockResolvedValue({ items: [makeResource(TOPIC_ARN, { name: "orders-events" }, { arn: TOPIC_ARN })], truncated: false });
    const onOpenSns = vi.fn();
    renderWithClient(<ResourceArea {...props} onOpenSns={onOpenSns} service={sns} type={sns.types[0]} />);
    fireEvent.doubleClick(await screen.findByText("orders-events"));
    expect(onOpenSns).toHaveBeenCalledTimes(1);
    expect(onOpenSns).toHaveBeenCalledWith({ profile: "prod", region: REGION, topicArn: TOPIC_ARN, topicName: "orders-events" });
  });

  test("double-clicking a subscription opens its topic's tab on that subscription", async () => {
    const key = `${TOPIC_ARN}:1111-aaaa`;
    vi.mocked(api.listResources).mockResolvedValue({
      items: [makeResource(key, { name: "orders-events", topicArn: TOPIC_ARN, protocol: "sqs", endpoint: QUEUE_ARN }, { arn: key })],
      truncated: false,
    });
    const onOpenSns = vi.fn();
    renderWithClient(<ResourceArea {...props} onOpenSns={onOpenSns} service={sns} type={sns.types[1]} />);
    fireEvent.doubleClick(await screen.findByText("orders-events"));
    expect(onOpenSns).toHaveBeenCalledWith({ profile: "prod", region: REGION, topicArn: TOPIC_ARN, topicName: "orders-events" }, { view: "subscription", subscription: key });
  });

  test("a pending subscription opens by its pending key", async () => {
    const key = `${TOPIC_ARN}#pending#9f86d081884c`;
    vi.mocked(api.listResources).mockResolvedValue({
      items: [makeResource(key, { name: "orders-events", topicArn: TOPIC_ARN, protocol: "email", endpoint: "o***@example.com" })],
      truncated: false,
    });
    const onOpenSns = vi.fn();
    renderWithClient(<ResourceArea {...props} onOpenSns={onOpenSns} service={sns} type={sns.types[1]} />);
    fireEvent.doubleClick(await screen.findByText("orders-events"));
    expect(onOpenSns).toHaveBeenCalledWith(expect.objectContaining({ topicArn: TOPIC_ARN }), { view: "subscription", subscription: key });
  });
});

describe("이 리소스를 구독한 주제", () => {
  const section = () => within(screen.getByRole("region", { name: "이 리소스를 구독한 주제" }));

  test("an SQS queue's detail lists the topics that subscribe it, asking by the queue's ARN (the row id is its URL)", async () => {
    vi.mocked(api.listResources).mockResolvedValue({ items: [makeResource(QUEUE_URL, { name: "orders-queue" }, { arn: QUEUE_ARN })], truncated: false });
    vi.mocked(snsApi.subscribedTopics).mockResolvedValue([TOPIC_ARN, "arn:aws:sns:ap-northeast-2:999999999999:partner-topic"]);
    const onOpenSns = vi.fn();
    renderWithClient(<ResourceArea {...props} onOpenSns={onOpenSns} service={sqs} type={sqs.types[0]} />);
    fireEvent.click(await screen.findByText("orders-queue"));
    expect(await section().findByText("orders-events")).toBeInTheDocument();
    expect(snsApi.subscribedTopics).toHaveBeenCalledWith("prod", REGION, QUEUE_ARN);

    const button = section().getByRole("button", { name: "주제 열기" });
    expect(button).toHaveClass("tone-nav");
    fireEvent.click(button);
    expect(onOpenSns).toHaveBeenCalledWith({ profile: "prod", region: REGION, topicArn: TOPIC_ARN, topicName: "orders-events" });

    // 다른 계정의 주제는 ARN 글뿐이다
    expect(section().getByText("arn:aws:sns:ap-northeast-2:999999999999:partner-topic")).toBeInTheDocument();
    expect(section().getAllByRole("button")).toHaveLength(1);
  });

  test("a Lambda function's detail has the same section, keyed by the function ARN", async () => {
    vi.mocked(api.listResources).mockResolvedValue({ items: [makeResource("order-processor", { name: "order-processor" }, { arn: FUNCTION_ARN })], truncated: false });
    vi.mocked(snsApi.subscribedTopics).mockResolvedValue([TOPIC_ARN]);
    renderWithClient(<ResourceArea {...props} service={lambda} type={lambda.types[0]} />);
    fireEvent.click(await screen.findByText("order-processor"));
    expect(await section().findByText("orders-events")).toBeInTheDocument();
    expect(snsApi.subscribedTopics).toHaveBeenCalledWith("prod", REGION, FUNCTION_ARN);
  });

  test("no subscribing topic is said so", async () => {
    vi.mocked(api.listResources).mockResolvedValue({ items: [makeResource(QUEUE_URL, { name: "orders-queue" }, { arn: QUEUE_ARN })], truncated: false });
    vi.mocked(snsApi.subscribedTopics).mockResolvedValue([]);
    renderWithClient(<ResourceArea {...props} service={sqs} type={sqs.types[0]} />);
    fireEvent.click(await screen.findByText("orders-queue"));
    expect(await section().findByText("이 리소스를 구독한 주제가 없어요")).toBeInTheDocument();
  });

  test("a read failure is shown in the section", async () => {
    vi.mocked(api.listResources).mockResolvedValue({ items: [makeResource(QUEUE_URL, { name: "orders-queue" }, { arn: QUEUE_ARN })], truncated: false });
    vi.mocked(snsApi.subscribedTopics).mockRejectedValue({ kind: "accessDenied", action: "sns:ListSubscriptions" });
    renderWithClient(<ResourceArea {...props} service={sqs} type={sqs.types[0]} />);
    fireEvent.click(await screen.findByText("orders-queue"));
    expect(await section().findByText("권한 없음 (sns:ListSubscriptions)")).toBeInTheDocument();
  });

  test("a row without an ARN has no section and asks nothing", async () => {
    vi.mocked(api.listResources).mockResolvedValue({ items: [makeResource(QUEUE_URL, { name: "orders-queue" })], truncated: false });
    renderWithClient(<ResourceArea {...props} service={sqs} type={sqs.types[0]} />);
    fireEvent.click(await screen.findByText("orders-queue"));
    expect(screen.queryByRole("region", { name: "이 리소스를 구독한 주제" })).toBeNull();
    expect(snsApi.subscribedTopics).not.toHaveBeenCalled();
  });

  test("other resource types do not get the section", async () => {
    vi.mocked(api.listResources).mockResolvedValue({ items: [makeResource(TOPIC_ARN, { name: "orders-events" }, { arn: TOPIC_ARN })], truncated: false });
    renderWithClient(<ResourceArea {...props} service={sns} type={sns.types[0]} />);
    fireEvent.click(await screen.findByText("orders-events"));
    expect(screen.queryByRole("region", { name: "이 리소스를 구독한 주제" })).toBeNull();
  });
});
