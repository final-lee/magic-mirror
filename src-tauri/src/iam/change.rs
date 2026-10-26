//! 변경 종류(계약의 `IamChange`). 점검 항목의 빠른 조치(`FindingItem::fix`)가 가리키는 값이라 읽기 쪽에서도 쓴다.
//! 미리보기·역변경·적용은 이 값을 받아서 다루는 변경 쪽 코드에 있다.

use serde::{Deserialize, Serialize};

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
