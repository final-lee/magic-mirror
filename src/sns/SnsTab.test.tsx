import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/client";
import type { ResourceMetrics } from "../api/types";
import { findFor } from "../test/find";
import { renderWithClient } from "../test/utils";
import { snsApi } from "./api";
import { DLQ_ARN, lambdaSubscription, PARTNER_QUEUE_ARN, QUEUE_URL, REGION, sampleTopic, snsTarget, sqsSubscription, TOPIC_ARN } from "./fixtures";
import { snsSubscriptionRoute } from "./route";
import { SnsTab } from "./SnsTab";

vi.mock("./api", () => ({ snsApi: { topic: vi.fn(), subscriptionsAll: vi.fn(), subscribedTopics: vi.fn(), diagnose: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { resourceMetrics: vi.fn(), ssoLogin: vi.fn() } }));
vi.mock("../explorer/api", () => ({ onMouseNav: vi.fn(async () => () => {}) }));

const m = vi.mocked(snsApi);

function setup(props: Partial<Parameters<typeof SnsTab>[0]> = {}) {
  return renderWithClient(<SnsTab target={snsTarget} active={true} {...props} />);
}

const loaded = () => screen.findByText("FIFO · KMS(alias/orders) · 구독 4 (대기 1)");
const menu = () => within(screen.getByRole("navigation", { name: "SNS 메뉴" }));
const openMenu = (label: string) => fireEvent.click(menu().getByRole("button", { name: new RegExp(`^${label}$`) }));
const section = (name: string) => within(screen.getByRole("region", { name }));
const table = () => screen.getByRole("table", { name: "구독 목록" });
const rows = () => within(table()).getAllByRole("row").slice(1);
const openSub = (endpoint: string) => fireEvent.click(within(table()).getByRole("button", { name: endpoint }));

beforeEach(() => {
  vi.clearAllMocks();
  m.topic.mockResolvedValue(sampleTopic());
  m.diagnose.mockResolvedValue({ topicChecks: [], subscriptions: [], failures: [], metrics: { failed: null, filteredInvalidAttributes: null, filteredInvalidBody: null, redrivenToDlq: null, delivered: null, published: null } });
});

describe("header and overview", () => {
  test("the header line carries kind, key and subscription counts; the tab asks for the topic by ARN", async () => {
    setup();
    await loaded();
    expect(m.topic).toHaveBeenCalledWith("personal", REGION, TOPIC_ARN);
    expect(screen.getByRole("group", { name: "주제 정보" })).toHaveTextContent("orders-events.fifo");
  });

  test("a standard, unencrypted topic says so and omits the pending count when there is none", async () => {
    m.topic.mockResolvedValue(sampleTopic({ fifo: false, overview: { ...sampleTopic().overview, fifo: false, kmsKey: null, pendingCount: 0, archiveRetentionDays: null } }));
    setup();
    expect(await screen.findByText("표준 · 암호화 안 됨 · 구독 3")).toBeInTheDocument();
    expect(screen.getByText("표준 주제예요. 순서와 중복 제거를 보장하지 않아요")).toBeInTheDocument();
    expect(screen.getByText("저장된 메시지를 암호화하지 않아요(서버 측 암호화 꺼짐)")).toBeInTheDocument();
    // FIFO·아카이브 문장은 FIFO 주제에만 있다
    expect(screen.queryByRole("region", { name: "FIFO" })).toBeNull();
    expect(screen.queryByRole("region", { name: "아카이브" })).toBeNull();
  });

  test("the overview writes the attributes out as sentences", async () => {
    setup();
    await loaded();
    expect(section("암호화").getByText("고객 관리 키 alias/orders로 암호화해요")).toBeInTheDocument();
    expect(section("FIFO").getByText(/내용 기반 중복 제거가 켜져 있어요/)).toBeInTheDocument();
    expect(section("FIFO").getByText("메시지 그룹마다 처리량 한도를 걸어요(높은 처리량 모드)")).toBeInTheDocument();
    expect(section("아카이브").getByText("발행한 메시지를 30일 동안 보관해요")).toBeInTheDocument();
    expect(section("아카이브").getByText(/^보관은 .*부터 시작됐어요$/)).toBeInTheDocument();
    expect(section("서명·추적").getByText("서명 버전은 1이에요(SHA1)")).toBeInTheDocument();
    expect(section("서명·추적").getByText("X-Ray 추적이 켜져 있어요(Active)")).toBeInTheDocument();
    expect(section("기본").getByText("구독은 확인됨 3개, 확인 대기 1개, 해지됨 0개예요")).toBeInTheDocument();
  });

  test("an AWS managed key comes with the note that service publishers cannot use it", async () => {
    m.topic.mockResolvedValue(sampleTopic({ overview: { ...sampleTopic().overview, kmsKey: "alias/aws/sns", awsManagedKey: true } }));
    setup();
    expect(await screen.findByText("FIFO · KMS(alias/aws/sns) · 구독 4 (대기 1)")).toBeInTheDocument();
    expect(section("암호화").getByText(/AWS 관리 키\(alias\/aws\/sns\)로 암호화해요.*서비스 발행자가 이 주제에 발행하지 못해요/)).toBeInTheDocument();
  });

  test("delivery status logging is written per protocol, on or off", async () => {
    setup();
    await loaded();
    const logging = section("배달 상태 로깅");
    expect(logging.getByText("켜짐 · 성공 로그 표본 25%(역할 sns-feedback) · 실패 로그 전부(역할 sns-failure)")).toBeInTheDocument();
    expect(logging.getAllByText("꺼짐")).toHaveLength(4);
    expect(logging.getByRole("button", { name: "SQS 배달 상태 로깅 설정…" })).toHaveClass("tone-primary");
    expect(logging.getByText("모바일 푸시")).toBeInTheDocument();
  });

  test("the HTTP delivery policy is a table with readable names", async () => {
    setup();
    await loaded();
    const policy = within(screen.getByRole("table", { name: "HTTP(S) 배달 정책" }));
    const row = policy.getByText("정상 엔드포인트 재시도 · 최소 지연(초)").closest("tr")!;
    expect(within(row).getByText("20")).toBeInTheDocument();
    expect(policy.getByText("구독별 재정의 막기")).toBeInTheDocument();
  });

  test("the data protection policy is absent, or present with its statement names", async () => {
    setup();
    await loaded();
    expect(section("데이터 보호 정책").getByText("데이터 보호 정책이 없어요")).toBeInTheDocument();
  });

  test("a data protection policy shows its name and statement ids", async () => {
    m.topic.mockResolvedValue(sampleTopic({ dataProtectionPolicy: JSON.stringify({ Name: "pii", Version: "2021-06-01", Statement: [{ Sid: "mask-cards" }, { Sid: "audit-emails" }] }) }));
    setup();
    await loaded();
    expect(section("데이터 보호 정책").getByText("데이터 보호 정책이 있어요(pii). 문 2개: mask-cards, audit-emails")).toBeInTheDocument();
  });

  test("tags are listed, and 원본 데이터 보기 opens the raw attributes", async () => {
    setup();
    await loaded();
    expect(section("태그").getByText("team=orders")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "원본 데이터 보기…" }));
    const dialog = within(screen.getByRole("dialog", { name: "orders-events.fifo 원본 데이터" }));
    expect(dialog.getByText(/"KmsMasterKeyId": "alias\/orders"/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("subscriptions", () => {
  const showTable = async () => {
    setup();
    await loaded();
    openMenu("구독");
  };

  test("shows replay status and polling indicator", async () => {
    const topic = sampleTopic();
    m.topic.mockResolvedValue({ ...topic, subscriptions: [{ ...sqsSubscription, attributes: { ...sqsSubscription.attributes, ReplayStatus: "In progress" } }] });
    await showTable();
    expect(within(rows()[0]).getByRole("status")).toHaveTextContent("다시 보내기: In progress · 10초마다 확인");
  });

  test("a table row per subscription: endpoint names, where they live, state, filter summary, raw, DLQ", async () => {
    await showTable();
    expect(rows()).toHaveLength(4);
    const queue = within(rows()[0]);
    expect(queue.getByText("orders-queue.fifo")).toBeInTheDocument();
    expect(queue.getByText("확인됨")).toBeInTheDocument();
    expect(queue.getByText(sqsSubscription.summary!)).toBeInTheDocument();
    expect(queue.getByText("켜짐")).toBeInTheDocument();
    expect(queue.getByText("orders-dlq")).toBeInTheDocument();

    // 같은 계정·리전이라 위치를 곁들이지 않는다. 다른 계정·리전이면 곁들인다
    const lambda = within(rows()[1]);
    expect(lambda.getByText("order-processor")).toBeInTheDocument();
    expect(lambda.getByText("필터 없음")).toBeInTheDocument();
    expect(lambda.getByText("없음")).toBeInTheDocument();
    const partner = within(rows()[2]);
    expect(partner.getByText("partner-queue")).toBeInTheDocument();
    expect(partner.getByText("999999999999 · us-east-1")).toBeInTheDocument();
    expect(partner.getByText("detail.status ∈ {paid} · 본문 범위")).toBeInTheDocument();
    // 이 구독의 속성을 읽지 못했으면 표에 작은 표시가 붙는다
    expect(partner.getByRole("img", { name: "이 구독의 속성을 읽지 못했어요" })).toHaveAttribute("title", "이 구독의 속성을 읽지 못했어요: 권한 없음 (sqs:GetQueueAttributes)");
  });

  test("a pending subscription is a row with its endpoint as is", async () => {
    await showTable();
    const pending = within(rows()[3]);
    expect(pending.getByText("ops@example.com")).toBeInTheDocument();
    expect(pending.getByText("확인 대기")).toBeInTheDocument();
  });

  test("protocol and state chips carry counts and narrow the table: any within a group, all across groups", async () => {
    await showTable();
    const protocols = within(screen.getByRole("group", { name: "프로토콜" }));
    const states = within(screen.getByRole("group", { name: "상태" }));
    expect(protocols.getByRole("button", { name: /sqs 2$/ })).toBeInTheDocument();
    expect(protocols.getByRole("button", { name: /lambda 1$/ })).toBeInTheDocument();
    expect(states.getByRole("button", { name: "확인됨 3" })).toBeInTheDocument();
    expect(states.getByRole("button", { name: "확인 대기 1" })).toBeInTheDocument();

    fireEvent.click(protocols.getByRole("button", { name: /sqs 2$/ }));
    expect(rows()).toHaveLength(2);
    fireEvent.click(protocols.getByRole("button", { name: /email 1$/ }));
    expect(rows()).toHaveLength(3);
    fireEvent.click(states.getByRole("button", { name: "확인 대기 1" }));
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]).getByText("ops@example.com")).toBeInTheDocument();
    expect(protocols.getByRole("button", { name: /email 1$/ })).toHaveAttribute("aria-pressed", "true");

    // 이메일 칩을 끄면 sqs만 남는데, 상태는 확인 대기만이라 맞는 구독이 없다
    fireEvent.click(protocols.getByRole("button", { name: /email 1$/ }));
    expect(screen.getByText("조건에 맞는 구독이 없어요")).toBeInTheDocument();
  });

  test("⌘F finds subscriptions by endpoint, filter summary or DLQ, and Esc clears it", async () => {
    await showTable();
    findFor("processor");
    expect(rows()).toHaveLength(1);
    // 맞은 글자는 <mark>로 칠해져 글이 쪼개지고 접근성 이름에는 그 자리에 공백이 끼므로 공백을 허용해서 단추로 찾는다
    expect(within(rows()[0]).getByRole("button", { name: /^order-\s*processor$/ })).toBeInTheDocument();
    findFor("본문");
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]).getByRole("button", { name: /^partner-queue$/ })).toBeInTheDocument();
    findFor("dlq");
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]).getByRole("button", { name: /^orders-queue\.fifo$/ })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "목록에서 찾기" }), { key: "Escape" });
    expect(rows()).toHaveLength(4);
  });

  test("a topic without subscriptions says so", async () => {
    m.topic.mockResolvedValue(sampleTopic({ subscriptions: [] }));
    setup();
    await screen.findByText("FIFO · KMS(alias/orders) · 구독 4 (대기 1)");
    openMenu("구독");
    expect(screen.getByText("이 주제에는 구독이 없어요")).toBeInTheDocument();
  });
});

describe("subscription detail", () => {
  const detailOf = async (endpoint: string, onOpenResource = vi.fn()) => {
    setup({ onOpenResource });
    await loaded();
    openMenu("구독");
    openSub(endpoint);
    await screen.findByRole("region", { name: "구독 상세" });
    return onOpenResource;
  };

  test("clicking a row opens the detail and the breadcrumb leads back to the list", async () => {
    await detailOf("orders-queue.fifo");
    const crumb = within(screen.getByRole("navigation", { name: "현재 위치" }));
    expect(crumb.getByText("orders-queue.fifo")).toBeInTheDocument();
    // 메뉴는 목록 항목이 켜져 있다
    expect(menu().getByRole("button", { name: "구독" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(crumb.getByRole("button", { name: "구독" }));
    expect(table()).toBeInTheDocument();
  });

  test("it shows every attribute, the filter policy as highlighted JSON, the DLQ and raw delivery", async () => {
    await detailOf("orders-queue.fifo");
    const detail = within(screen.getByRole("region", { name: "구독 상세" }));
    const attributes = within(detail.getByRole("table", { name: "속성" }));
    for (const key of ["Protocol", "Endpoint", "RawMessageDelivery", "FilterPolicy", "RedrivePolicy", "SubscriptionArn"]) {
      expect(attributes.getByText(key)).toBeInTheDocument();
    }
    expect(detail.getByText("메시지 속성 범위")).toBeInTheDocument();
    const json = detail.getByLabelText("필터 정책", { selector: "pre" });
    expect(json.querySelector(".sns-json-key")).toHaveTextContent('"event_type"');
    expect(json.querySelector(".sns-json-str")).toHaveTextContent('"order.created"');
    expect(json).toHaveTextContent('"prefix": "order.p"');
    expect(detail.getByText("orders-dlq", { selector: "li" })).toBeInTheDocument();
    expect(detail.getByText(DLQ_ARN)).toBeInTheDocument();
    expect(detail.getByText("Raw 전달이 켜져 있어요: SNS 봉투 없이 본문을 그대로 보내요")).toBeInTheDocument();
    expect(detail.getByText("SQS 큐 · FIFO · KMS(alias/aws/sqs)")).toBeInTheDocument();
  });

  test("a subscription without a filter or DLQ says what that means", async () => {
    await detailOf("order-processor");
    const detail = within(screen.getByRole("region", { name: "구독 상세" }));
    expect(detail.getByText("필터 정책이 없어서 모든 메시지를 받아요")).toBeInTheDocument();
    expect(detail.getByText(/DLQ가 없어요/)).toBeInTheDocument();
    expect(detail.getByText("Raw 전달이 꺼져 있어요: 본문이 SNS 봉투(JSON)로 감싸져요")).toBeInTheDocument();
  });

  test("the nav button jumps to the queue's row of the resource browser (its row id is the queue URL)", async () => {
    const onOpenResource = await detailOf("orders-queue.fifo");
    const button = screen.getByRole("button", { name: "SQS 큐 열기" });
    expect(button).toHaveClass("tone-nav");
    fireEvent.click(button);
    expect(onOpenResource).toHaveBeenCalledWith({ region: REGION, service: "sqs", type: "queues", id: QUEUE_URL });
  });

  test("the nav button of a Lambda subscription jumps to the function by name", async () => {
    const onOpenResource = await detailOf("order-processor");
    fireEvent.click(screen.getByRole("button", { name: "Lambda 함수 열기" }));
    expect(onOpenResource).toHaveBeenCalledWith({ region: REGION, service: "lambda", type: "functions", id: "order-processor" });
  });

  test("an endpoint that could not be read, or lives in another account, cannot be jumped to and says why", async () => {
    // 읽지 못한 엔드포인트(다른 계정의 큐)
    await detailOf("partner-queue");
    const button = screen.getByRole("button", { name: "SQS 큐 열기" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "엔드포인트를 읽지 못해 어느 행인지 알 수 없어요");
    expect(screen.getByText("권한 없음 (sqs:GetQueueAttributes)")).toBeInTheDocument();
    // 본문 범위 필터
    expect(screen.getByText("본문 범위")).toBeInTheDocument();
  });

  test("an endpoint of another account is disabled with that reason even when it was resolved", async () => {
    const other = { ...sqsSubscription, endpoint: PARTNER_QUEUE_ARN, target: { ...sqsSubscription.target!, arn: PARTNER_QUEUE_ARN } as NonNullable<typeof sqsSubscription.target> };
    m.topic.mockResolvedValue(sampleTopic({ subscriptions: [other] }));
    setup();
    await screen.findByText("FIFO · KMS(alias/orders) · 구독 4 (대기 1)");
    openMenu("구독");
    openSub("partner-queue");
    const button = await screen.findByRole("button", { name: "SQS 큐 열기" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "다른 계정의 리소스라 이 프로필로 열 수 없어요");
  });

  test("a pending subscription explains that its attributes cannot be read until it is confirmed", async () => {
    await detailOf("ops@example.com");
    const detail = within(screen.getByRole("region", { name: "구독 상세" }));
    expect(detail.getByText(/확인 대기 중인 구독이에요. 확인이 끝나기 전에는 속성을 읽을 수 없어요/)).toBeInTheDocument();
    expect(detail.queryByRole("table", { name: "속성" })).toBeNull();
    expect(detail.queryByRole("button", { name: "원본 데이터 보기…" })).toBeNull();
    // 이메일은 리소스 브라우저에 가리킬 행이 없다
    expect(detail.queryByRole("button", { name: /열기$/ })).toBeNull();
  });

  test("원본 데이터 보기 shows the subscription's attributes", async () => {
    await detailOf("order-processor");
    fireEvent.click(screen.getByRole("button", { name: "원본 데이터 보기…" }));
    expect(within(screen.getByRole("dialog", { name: "order-processor 원본 데이터" })).getByText(/"Protocol": "lambda"/)).toBeInTheDocument();
  });

  test("a subscription that is gone from the snapshot says so and offers the list", async () => {
    setup({ open: { route: snsSubscriptionRoute("arn:gone"), nonce: 1 } });
    await loaded();
    expect(screen.getByText(/이 구독을 찾을 수 없어요/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "구독 목록으로" }));
    expect(table()).toBeInTheDocument();
  });
});

describe("opening on a route", () => {
  test("다른 구독으로 직접 이동하면 이전 구독의 열린 편집기를 버려요", async () => {
    const { rerender, qc } = setup({ open: { route: snsSubscriptionRoute(sqsSubscription.key), nonce: 1 } });
    await screen.findByRole("region", { name: "구독 상세" });
    fireEvent.click(screen.getByRole("button", { name: "필터 정책 편집" }));
    expect(screen.getByRole("button", { name: "미리 보기…" })).toBeInTheDocument();
    rerender(<QueryClientProvider client={qc}><SnsTab target={snsTarget} active open={{ route: snsSubscriptionRoute(lambdaSubscription.key), nonce: 2 }} /></QueryClientProvider>);
    await waitFor(() => expect(screen.queryByRole("button", { name: "미리 보기…" })).toBeNull());
    expect(screen.getByRole("button", { name: "필터 정책 편집" })).toBeInTheDocument();
  });

  test("a requested subscription opens right away, and back returns to the overview", async () => {
    setup({ open: { route: snsSubscriptionRoute(sqsSubscription.key), nonce: 1 } });
    await loaded();
    expect(await screen.findByRole("region", { name: "구독 상세" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(screen.getByRole("region", { name: "주제 개요" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "앞으로" }));
    expect(screen.getByRole("region", { name: "구독 상세" })).toBeInTheDocument();
  });

  test("a later request on the open tab moves it, even to the same place again", async () => {
    const { rerender, qc } = setup();
    await loaded();
    const route = snsSubscriptionRoute(lambdaSubscription.key);
    const request = (nonce: number) =>
      rerender(
        <QueryClientProvider client={qc}>
          <SnsTab target={snsTarget} active={true} open={{ route, nonce }} />
        </QueryClientProvider>,
      );
    request(1);
    expect(await screen.findByRole("region", { name: "구독 상세" })).toBeInTheDocument();
    fireEvent.click(menu().getByRole("button", { name: "개요" }));
    expect(screen.getByRole("region", { name: "주제 개요" })).toBeInTheDocument();
    request(2);
    expect(await screen.findByRole("region", { name: "구독 상세" })).toBeInTheDocument();
  });
});

describe("history", () => {
  test("the back and forward buttons walk the screens", async () => {
    setup();
    await loaded();
    expect(screen.getByRole("button", { name: "뒤로" })).toBeDisabled();
    openMenu("구독");
    openSub("order-processor");
    await screen.findByRole("region", { name: "구독 상세" });
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(table()).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(screen.getByRole("region", { name: "주제 개요" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "뒤로" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "앞으로" }));
    expect(table()).toBeInTheDocument();
  });
});

describe("metrics", () => {
  const sampleMetrics: ResourceMetrics = { namespace: "AWS/SNS", region: REGION, charts: [], period: 300, start: 0, end: 1, daily: false, note: "표본 지표 안내" };

  test("reuses the resource metrics for service sns, type topics, with the topic as the row", async () => {
    vi.mocked(api.resourceMetrics).mockResolvedValue(sampleMetrics);
    setup();
    await loaded();
    openMenu("지표");
    await waitFor(() => expect(api.resourceMetrics).toHaveBeenCalledWith("personal", REGION, "sns", "topics", expect.objectContaining({ id: TOPIC_ARN, name: "orders-events.fifo", values: { name: "orders-events.fifo" } }), "3h"));
    expect(await screen.findByText("표본 지표 안내")).toBeInTheDocument();
  });
});

describe("errors and refreshing", () => {
  test("a failed read shows the error with retry", async () => {
    m.topic.mockRejectedValue({ kind: "network", message: "연결할 수 없어요" });
    setup();
    expect(await screen.findByText("네트워크 오류: 연결할 수 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "SNS 메뉴" })).toBeNull();
    m.topic.mockResolvedValue(sampleTopic());
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await loaded();
  });

  test("an expired SSO session offers the login", async () => {
    m.topic.mockRejectedValue({ kind: "ssoExpired" });
    setup();
    expect(await screen.findByText("SSO 세션이 만료됐어요 (personal)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "로그인" })).toBeInTheDocument();
  });

  test("items that could not be read are noted quietly while the rest renders", async () => {
    m.topic.mockResolvedValue(sampleTopic({ errors: [{ kind: "accessDenied", action: "sns:ListTagsForResource" }, { kind: "accessDenied", action: "sns:ListTagsForResource" }, { kind: "throttled" }] }));
    setup();
    await loaded();
    const note = screen.getByRole("status", { name: "읽지 못한 항목" });
    expect(note).toHaveTextContent("일부 정보를 읽지 못했어요 (3건): 권한 없음 (sns:ListTagsForResource) · 요청이 너무 많아요. 잠시 후 다시 시도하세요");
    expect(screen.getByRole("region", { name: "주제 개요" })).toBeInTheDocument();
  });

  test("[다시 읽기] reads the snapshot again and keeps the old screen if that fails", async () => {
    setup();
    await loaded();
    m.topic.mockRejectedValue({ kind: "network", message: "timeout" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "다시 읽기" }));
    });
    expect(m.topic).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("네트워크 오류: timeout")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "주제 개요" })).toBeInTheDocument();
  });
});
