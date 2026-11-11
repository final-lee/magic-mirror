import { archiveValues, dataProtectionSentence, encryptionValue, fifoValues, httpPolicyLabel, kindValue, loggingSentence, signatureValue, subscriptionValue, tracingValue } from "./text";
import { sampleOverview, sampleTopic } from "./fixtures";

test("kind and subscription counts", () => {
  expect(kindValue(true)).toEqual({ value: "FIFO", note: "순서를 지키고 중복을 걸러 내요" });
  expect(kindValue(false)).toEqual({ value: "표준", note: "순서·중복을 보장하지 않아요" });
  expect(subscriptionValue(4, 1, 0)).toBe("확인됨 4 · 대기 1 · 해지됨 0");
});

test("encryption: none, AWS managed, customer managed", () => {
  const withKey = (kmsKey: string | null, awsManagedKey = false) => sampleTopic({ overview: { ...sampleOverview, kmsKey, awsManagedKey } });
  expect(encryptionValue(withKey(null))).toEqual({ value: "꺼짐", note: "저장된 메시지를 암호화하지 않아요" });
  expect(encryptionValue(withKey("alias/aws/sns", true))).toEqual({ value: "alias/aws/sns · AWS 관리 키", note: "CloudWatch 경보·EventBridge 같은 서비스가 이 주제에 발행하지 못해요", warn: true });
  expect(encryptionValue(withKey("arn:aws:kms:ap-northeast-2:123456789012:alias/orders"))).toEqual({ value: "alias/orders · 고객 관리 키" });
});

test("FIFO: deduplication and throughput scope", () => {
  const topic = (over: Partial<typeof sampleOverview>) => sampleTopic({ overview: { ...sampleOverview, ...over } });
  expect(fifoValues(topic({ contentBasedDeduplication: false, fifoThroughputScope: "Topic" }))).toEqual([{ value: "꺼짐", note: "발행할 때 중복 제거 ID가 필요해요" }, { value: "주제 전체" }]);
  expect(fifoValues(topic({ fifoThroughputScope: "MessageGroup" }))[1]).toEqual({ value: "메시지 그룹마다", note: "높은 처리량 모드" });
  expect(fifoValues(topic({ fifoThroughputScope: null }))[1]).toEqual({ value: "기본(주제 전체)" });
  expect(fifoValues(topic({ fifoThroughputScope: "Future" }))[1]).toEqual({ value: "Future" });
});

test("archive: off, or retention with its start", () => {
  expect(archiveValues(sampleTopic({ overview: { ...sampleOverview, archiveRetentionDays: null, beginningArchiveTime: null } }))).toEqual(["꺼짐", null]);
  expect(archiveValues(sampleTopic({ overview: { ...sampleOverview, beginningArchiveTime: null } }))).toEqual(["30일", null]);
  expect(archiveValues(sampleTopic())[1]).toBeTruthy();
});

test("signature and tracing", () => {
  expect(signatureValue(1)).toEqual({ value: "버전 1 · SHA1", note: "버전 2(SHA256)를 권장해요" });
  expect(signatureValue(2)).toEqual({ value: "버전 2 · SHA256" });
  expect(tracingValue("Active")).toEqual({ value: "켜짐" });
  expect(tracingValue("PassThrough")).toEqual({ value: "꺼짐", note: "들어온 추적 헤더는 그대로 전달해요" });
  expect(tracingValue(null).value).toBe("꺼짐");
});

test("delivery logging per protocol", () => {
  expect(loggingSentence({ protocol: "HTTP", successRole: null, failureRole: null, sampleRate: 0 })).toEqual({ protocol: "HTTP(S)", on: false, text: "꺼짐" });
  expect(loggingSentence({ protocol: "SQS", successRole: "arn:aws:iam::1:role/path/ok", failureRole: null, sampleRate: 100 })).toEqual({ protocol: "SQS", on: true, text: "켜짐 · 성공 로그 표본 100%(역할 ok)" });
  expect(loggingSentence({ protocol: "Lambda", successRole: "arn:aws:iam::1:role/ok", failureRole: "arn:aws:iam::1:role/bad", sampleRate: 0 }).text).toBe(
    "켜짐 · 성공 로그는 표본 0%라 남기지 않아요(역할 ok) · 실패 로그 전부(역할 bad)",
  );
  expect(loggingSentence({ protocol: "Firehose", successRole: null, failureRole: "arn:aws:iam::1:role/bad", sampleRate: null }).text).toBe("켜짐 · 실패 로그 전부(역할 bad)");
});

test("HTTP delivery policy keys are named by group and leaf; unknown keys stay as they are", () => {
  expect(httpPolicyLabel({ key: "http.defaultHealthyRetryPolicy.numRetries", value: "3" })).toBe("정상 엔드포인트 재시도 · 재시도 횟수");
  expect(httpPolicyLabel({ key: "http.defaultSicklyRetryPolicy.backoffFunction", value: "linear" })).toBe("문제 있는 엔드포인트 재시도 · 지연 늘리는 방식");
  expect(httpPolicyLabel({ key: "http.disableSubscriptionOverrides", value: "false" })).toBe("구독별 재정의 막기");
  expect(httpPolicyLabel({ key: "http.somethingNew", value: "1" })).toBe("http.somethingNew");
});

test("data protection: with name and statement ids, or an unreadable document", () => {
  expect(dataProtectionSentence('{"Name":"pii","Statement":[{"Sid":"a"},{"Sid":"b"},{"x":1}]}')).toBe("데이터 보호 정책이 있어요(pii). 문 2개: a, b");
  expect(dataProtectionSentence('{"Statement":[]}')).toBe("데이터 보호 정책이 있어요");
  expect(dataProtectionSentence("not json")).toBe("데이터 보호 정책이 있어요");
});
