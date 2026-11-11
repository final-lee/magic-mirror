import { ErrorState } from "../components/ErrorState";
import { useSnsSubscribedTopics } from "./queries";
import { arnScope, topicNameOf, type SnsTopicRef } from "./targets";
import * as t from "./text";

interface Props {
  profile: string;
  region: string;
  /** 현재 프로필의 계정. 모르면 엔드포인트가 속한 계정으로 본다 */
  account: string | undefined;
  endpointArn: string;
  onOpenSns?: (target: SnsTopicRef) => void;
}

/**
 * SQS 큐·Lambda 함수 상세의 `이 리소스를 구독한 주제` 줄. 같은 계정의 주제는 [주제 열기] 단추로 주제 탭을 열고,
 * 다른 계정의 주제는 ARN 글로만 보인다(이 프로필로는 읽을 수 없다).
 */
export function SubscribedTopics({ profile, region, account, endpointArn, onOpenSns }: Props) {
  const q = useSnsSubscribedTopics(profile, region, endpointArn);
  const own = account ?? arnScope(endpointArn).account;
  return (
    <section className="sns-subscribed" aria-label={t.SUBSCRIBED_TOPICS}>
      <div className="sect">{t.SUBSCRIBED_TOPICS}</div>
      {q.isError ? (
        <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <div className="dim">{t.SUBSCRIBED_LOADING}</div>
      ) : q.data.length === 0 ? (
        <div className="dim">{t.SUBSCRIBED_NONE}</div>
      ) : (
        <ul className="sns-subscribed-list">
          {q.data.map((arn) => {
            const scope = arnScope(arn);
            const name = topicNameOf(arn);
            return (
              <li key={arn}>
                {scope.account === own ? (
                  <>
                    <span className="mono">{name}</span>
                    <button className="btn small tone-nav" onClick={() => onOpenSns?.({ profile, region: scope.region || region, topicArn: arn, topicName: name })}>
                      {t.OPEN_TOPIC}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="mono">{arn}</span>
                    <span className="dim">{t.OTHER_ACCOUNT_TOPIC}</span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
