import { invoke } from "../api/invoke";
import type { FilterInput, FilterResult, FilterSample, SnsAccountOverview, SnsApplyResult, SnsChangeRecord, SnsChangeRequest, SnsDiagnosisReport, SnsMessaging, SnsPlan, SnsPolicyFinding, SnsPublicAccessReport, SnsPublishers, SnsRole, SnsSubscriptionRow, SnsTopic, SnsTopicPolicy } from "./types";

// 명령 이름과 인자 이름은 계약과 같아야 한다(Tauri가 camelCase 인자를 snake_case로 바꿔 준다).
// 모두 최상위 인자 `profile`을 받는다: invoke가 SSO 만료를 알릴 때 이 값을 읽는다(src/api/invoke.ts). 쓰는 명령(plan 다음의 apply)은 미리보기를 받은 계획만 받는다.
export const snsApi = {
  /** 주제 스냅샷: 속성, 구독(속성·필터·엔드포인트 해석 포함), 태그, 데이터 보호 정책. 항목별 읽기 실패는 errors에 남고 나머지는 온다 */
  topic: (profile: string, region: string, arn: string) => invoke<SnsTopic>("sns_topic", { profile, region, arn }),
  /** 이 프로필·리전의 모든 구독(주제 가리지 않음) */
  subscriptionsAll: (profile: string, region: string) => invoke<SnsSubscriptionRow[]>("sns_subscriptions_all", { profile, region }),
  /** 이 엔드포인트(SQS 큐·Lambda 함수 ARN)를 구독한 주제 ARN 목록 */
  subscribedTopics: (profile: string, region: string, endpointArn: string) => invoke<string[]>("sns_subscribed_topics", { profile, region, endpointArn }),
  diagnose: (profile: string, region: string, arn: string) => invoke<SnsDiagnosisReport>("sns_diagnose", { profile, region, arn }),
  filterTest: (policies: FilterInput[], sample: FilterSample) => invoke<FilterResult[]>("sns_filter_test", { policies, sample }),
  publishers: (profile: string, region: string, arn: string, deep: boolean) => invoke<SnsPublishers>("sns_publishers", { profile, region, arn, deep }),
  /** 주제 정책: 문장 풀이, 누가 발행·구독할 수 있나, Access Analyzer 검증, 이 주제의 점검 결과 */
  topicPolicy: (profile: string, region: string, arn: string) => invoke<SnsTopicPolicy>("sns_topic_policy", { profile, region, arn }),
  /** 유료(호출당 $0.002) 공개 접근 검사. 버튼을 눌렀을 때만 부른다 */
  checkPublicAccess: (profile: string, region: string, arn: string) => invoke<SnsPublicAccessReport>("sns_check_public_access", { profile, region, arn }),
  /** 계정 개요: 주제별 지난 24시간 지표, 고아·대기 구독, 점검 모음, 계정 지표 */
  accountOverview: (profile: string, region: string) => invoke<SnsAccountOverview>("sns_account_overview", { profile, region }),
  /** SMS·모바일 푸시(읽기). 샌드박스 번호는 가려서 온다 */
  messaging: (profile: string, region: string) => invoke<SnsMessaging>("sns_messaging", { profile, region }),
  /** 변경 미리보기: 아무것도 바꾸지 않고 호출·전후 값·영향·경고·확인 문구를 만든다 */
  plan: (profile: string, region: string, request: SnsChangeRequest) => invoke<SnsPlan>("sns_plan", { profile, region, request }),
  /** 미리보기를 받은 계획을 적용한다. 그 사이 상태가 바뀌었으면 `{ kind: "stalePlan" }`로 거절한다(isStalePlan) */
  apply: (profile: string, region: string, plan: SnsPlan) => invoke<SnsApplyResult>("sns_apply", { profile, region, plan }),
  /** 이 프로필의 변경 기록(최신순). 주제와 리전을 가리지 않는다 */
  changes: (profile: string) => invoke<SnsChangeRecord[]>("sns_changes", { profile }),
  /** 기록 하나를 되돌리는 계획 */
  undoPlan: (profile: string, region: string, id: string) => invoke<SnsPlan>("sns_undo_plan", { profile, region, id }),
  /** 정책 저장 미리보기: 저장하기 전 문서의 무료 ValidatePolicy 지적 */
  validatePolicy: (profile: string, region: string, document: string) => invoke<SnsPolicyFinding[]>("sns_validate_policy", { profile, region, document }),
  /** 정책 저장 미리보기의 유료(호출당 $0.002) 공개 접근 검사. 버튼을 눌렀을 때만 부른다 */
  checkPolicyDocument: (profile: string, region: string, arn: string, document: string) => invoke<SnsPublicAccessReport>("sns_check_policy_document", { profile, region, arn, document }),
  /** 배달 상태 로깅에 고를 수 있는 기존 IAM 역할(SNS를 신뢰하는 역할) */
  loggingRoles: (profile: string, region: string) => invoke<SnsRole[]>("sns_logging_roles", { profile, region }),
};
