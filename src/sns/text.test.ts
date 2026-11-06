import { archiveSentences, dataProtectionSentence, encryptionSentence, fifoSentences, httpPolicyLabel, loggingSentence, signatureSentence, tracingSentence } from "./text";
import { sampleOverview, sampleTopic } from "./fixtures";

test("encryption: none, AWS managed, customer managed (alias or key ARN)", () => {
  const withKey = (kmsKey: string | null, awsManagedKey = false) => sampleTopic({ overview: { ...sampleOverview, kmsKey, awsManagedKey } });
  expect(encryptionSentence(withKey(null))).toBe("저장된 메시지를 암호화하지 않아요(서버 측 암호화 꺼짐)");
  expect(encryptionSentence(withKey("alias/aws/sns", true))).toContain("AWS 관리 키(alias/aws/sns)로 암호화해요");
  expect(encryptionSentence(withKey("arn:aws:kms:ap-northeast-2:123456789012:alias/orders"))).toBe("고객 관리 키 alias/orders로 암호화해요");
});

test("FIFO: deduplication and throughput scope", () => {
  const topic = (over: Partial<typeof sampleOverview>) => sampleTopic({ overview: { ...sampleOverview, ...over } });
  expect(fifoSentences(topic({ contentBasedDeduplication: false, fifoThroughputScope: "Topic" }))).toEqual(["내용 기반 중복 제거가 꺼져 있어요: 발행할 때 중복 제거 ID를 줘야 해요", "주제 전체에 처리량 한도를 걸어요"]);
  expect(fifoSentences(topic({ fifoThroughputScope: null }))[1]).toBe("처리량 범위는 기본값이에요");
  expect(fifoSentences(topic({ fifoThroughputScope: "Future" }))[1]).toBe("처리량 범위는 Future예요");
});

test("archive: off, or retention with its start", () => {
  expect(archiveSentences(sampleTopic({ overview: { ...sampleOverview, archiveRetentionDays: null } }))).toEqual(["메시지 아카이브가 꺼져 있어요"]);
  expect(archiveSentences(sampleTopic({ overview: { ...sampleOverview, beginningArchiveTime: null } }))).toEqual(["발행한 메시지를 30일 동안 보관해요"]);
  expect(archiveSentences(sampleTopic())).toHaveLength(2);
});

test("signature and tracing", () => {
  expect(signatureSentence(1)).toBe("서명 버전은 1이에요(SHA1)");
  expect(signatureSentence(2)).toBe("서명 버전은 2이에요(SHA256)");
  expect(tracingSentence("Active")).toBe("X-Ray 추적이 켜져 있어요(Active)");
  expect(tracingSentence("PassThrough")).toContain("켜지 않았어요");
  expect(tracingSentence(null)).toContain("켜지 않았어요");
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
