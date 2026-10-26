//! 변경 종류(계약의 `IamChange`)와 변경 미리보기·경고·영향 계산·역변경. 모두 순수 코드다: IAM을 바꾸는 호출은 `write`에만 있다.
//! 점검 항목의 빠른 조치(`FindingItem::fix`)도 이 값을 가리키므로 읽기 쪽에서도 쓴다.
//!
//! - `calls`: 변경이 부르는 API와 인자(미리보기에 보이고 `write`가 그대로 실행한다)
//! - `facts`: 스냅숏 밖에서 읽어 오는 재료(키 상태, 이 앱이 쓰는 키, 정책 문서 검사 결과)
//! - `state`: 변경을 적용한 뒤의 가상 스냅숏(`apply_to_snapshot`)
//! - `impact`: 영향받는 주체와 권한 증감
//! - `warnings`·`document`: 막힘·확인·주의 규칙과 정책 문서 검사
//! - `inverse`: 되돌리기용 역변경
//! - `preview`: 위 조각을 모은 `ChangePreview`

use serde::{Deserialize, Serialize};

mod calls;
mod document;
mod facts;
mod impact;
mod inverse;
mod preview;
mod state;
mod text;
mod warnings;

#[cfg(test)]
mod scenarios;

pub use calls::{calls, ApiCall};
pub use facts::{deletes_policy_version, Facts, PolicyCheck};
pub use impact::Impact;
pub use inverse::inverse;
pub use preview::{preview, ChangePreview};
pub use state::{apply_to_snapshot, missing_policy};
pub use warnings::{WarnLevel, Warning};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum IamChange {
    /// `target`은 사용자·그룹·역할 ARN
    AttachPolicy { target: String, policy_arn: String },
    DetachPolicy { target: String, policy_arn: String },
    AddToGroup { user_name: String, group_name: String },
    RemoveFromGroup { user_name: String, group_name: String },
    /// `status`는 `"Active"` 또는 `"Inactive"`
    SetAccessKeyStatus { user_name: String, access_key_id: String, status: String },
    DeleteAccessKey { user_name: String, access_key_id: String },
    PutInlinePolicy { target: String, name: String, document: String },
    DeleteInlinePolicy { target: String, name: String },
    UpdateManagedPolicy { policy_arn: String, document: String },
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn json_shape_matches_the_contract() {
        let attach = IamChange::AttachPolicy { target: "arn:aws:iam::1:user/a".into(), policy_arn: "arn:aws:iam::aws:policy/X".into() };
        assert_eq!(
            serde_json::to_value(&attach).unwrap(),
            json!({ "op": "attachPolicy", "target": "arn:aws:iam::1:user/a", "policyArn": "arn:aws:iam::aws:policy/X" })
        );
        let key = IamChange::SetAccessKeyStatus { user_name: "bob".into(), access_key_id: "AKIA1".into(), status: "Inactive".into() };
        assert_eq!(
            serde_json::to_value(&key).unwrap(),
            json!({ "op": "setAccessKeyStatus", "userName": "bob", "accessKeyId": "AKIA1", "status": "Inactive" })
        );
    }

    #[test]
    fn every_op_round_trips() {
        let changes = [
            json!({ "op": "attachPolicy", "target": "t", "policyArn": "p" }),
            json!({ "op": "detachPolicy", "target": "t", "policyArn": "p" }),
            json!({ "op": "addToGroup", "userName": "u", "groupName": "g" }),
            json!({ "op": "removeFromGroup", "userName": "u", "groupName": "g" }),
            json!({ "op": "setAccessKeyStatus", "userName": "u", "accessKeyId": "k", "status": "Active" }),
            json!({ "op": "deleteAccessKey", "userName": "u", "accessKeyId": "k" }),
            json!({ "op": "putInlinePolicy", "target": "t", "name": "n", "document": "{}" }),
            json!({ "op": "deleteInlinePolicy", "target": "t", "name": "n" }),
            json!({ "op": "updateManagedPolicy", "policyArn": "p", "document": "{}" }),
        ];
        for value in changes {
            let change: IamChange = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(&change).unwrap(), value);
        }
        assert!(serde_json::from_value::<IamChange>(json!({ "op": "createUser", "name": "x" })).is_err());
    }
}
