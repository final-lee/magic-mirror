import { useState } from "react";
import { PolicyChecks } from "./ChangeExtras";
import * as t from "./editText";
import { JsonEditPane } from "./JsonEditPane";
import type { SnsTopicRef } from "./targets";
import type { SnsTopicPolicy } from "./types";
import { useSnsChange } from "./useSnsChange";

/**
 * 주제 정책 편집: [정책 편집](보조)이 같은 자리에서 CodeEditor로 바뀌고, [미리 보기…](실행)가 변경 대화창을 연다.
 * 대화창에는 줄 차이와 함께 저장할 문서의 ValidatePolicy 지적, 유료 CheckNoPublicAccess 버튼($0.002)이 붙는다.
 * 정책을 공개·다른 계정으로 넓히면 주제 이름을 입력해야 적용할 수 있다(백엔드 계획의 확인 문구).
 */
export function TopicPolicyEdit({ target, policy }: { target: SnsTopicRef; policy: SnsTopicPolicy }) {
  const [editing, setEditing] = useState(false);
  const { start, dialog } = useSnsChange(target);
  if (!editing) {
    return (
      <div className="sns-edit-slot">
        <button type="button" className="btn small tone-secondary" disabled={policy.policy === null} title={policy.policy === null ? t.POLICY_NONE_TO_EDIT : undefined} onClick={() => setEditing(true)}>
          {t.POLICY_EDIT}
        </button>
        {dialog}
      </div>
    );
  }
  return (
    <>
      <JsonEditPane
        label={t.POLICY_EDITOR}
        initial={policy.policy ?? ""}
        allowEmpty={false}
        onCancel={() => setEditing(false)}
        onPreview={(text) =>
          text !== null &&
          start(
            { kind: "topicPolicy", topicArn: target.topicArn, policy: text },
            { renderExtra: (plan) => <PolicyChecks profile={target.profile} region={target.region} topicArn={target.topicArn} plan={plan} />, onApplied: () => setEditing(false) },
          )
        }
      />
      {dialog}
    </>
  );
}
