//! IAM을 바꾸는 호출은 이 파일에만 있다(리소스 브라우저 어댑터와 읽기 코드는 읽기 전용이다).
//! `change::calls`가 만든 호출 목록, 곧 미리보기에 보인 호출을 순서대로 그대로 실행하므로 보인 것과 실제 호출이 달라질 수 없다.
//! 액세스 키는 만들지 않는다(비밀 키를 다루지 않는다).

use aws_sdk_iam::types::StatusType;

use super::change::{calls, ApiCall, IamChange};
use super::model::Snapshot;
use crate::error::{from_sdk, AppError};

fn param<'a>(call: &'a ApiCall, key: &str) -> Result<&'a str, AppError> {
    call.params.get(key).map(String::as_str).ok_or_else(|| AppError::other(format!("{} 호출에 {key} 인자가 없어요", call.api)))
}

fn key_status(value: &str) -> Result<StatusType, AppError> {
    match value {
        "Active" => Ok(StatusType::Active),
        "Inactive" => Ok(StatusType::Inactive),
        other => Err(AppError::other(format!("액세스 키 상태는 Active나 Inactive여야 해요: {other}"))),
    }
}

/// 호출 하나를 보낸다. 호출 목록은 `change::calls`만 만들지만, 모르는 API나 빠진 인자는 보내지 않고 거부한다.
async fn run(client: &aws_sdk_iam::Client, call: &ApiCall) -> Result<(), AppError> {
    let api = call.api.as_str();
    let p = |key: &str| param(call, key);
    match api {
        "iam:AttachUserPolicy" => client.attach_user_policy().user_name(p("UserName")?).policy_arn(p("PolicyArn")?).send().await.map(drop).map_err(|e| from_sdk(e, api)),
        "iam:AttachGroupPolicy" => client.attach_group_policy().group_name(p("GroupName")?).policy_arn(p("PolicyArn")?).send().await.map(drop).map_err(|e| from_sdk(e, api)),
        "iam:AttachRolePolicy" => client.attach_role_policy().role_name(p("RoleName")?).policy_arn(p("PolicyArn")?).send().await.map(drop).map_err(|e| from_sdk(e, api)),
        "iam:DetachUserPolicy" => client.detach_user_policy().user_name(p("UserName")?).policy_arn(p("PolicyArn")?).send().await.map(drop).map_err(|e| from_sdk(e, api)),
        "iam:DetachGroupPolicy" => client.detach_group_policy().group_name(p("GroupName")?).policy_arn(p("PolicyArn")?).send().await.map(drop).map_err(|e| from_sdk(e, api)),
        "iam:DetachRolePolicy" => client.detach_role_policy().role_name(p("RoleName")?).policy_arn(p("PolicyArn")?).send().await.map(drop).map_err(|e| from_sdk(e, api)),
        "iam:AddUserToGroup" => client.add_user_to_group().user_name(p("UserName")?).group_name(p("GroupName")?).send().await.map(drop).map_err(|e| from_sdk(e, api)),
        "iam:RemoveUserFromGroup" => client.remove_user_from_group().user_name(p("UserName")?).group_name(p("GroupName")?).send().await.map(drop).map_err(|e| from_sdk(e, api)),
        "iam:UpdateAccessKey" => {
            let status = key_status(p("Status")?)?;
            client.update_access_key().user_name(p("UserName")?).access_key_id(p("AccessKeyId")?).status(status).send().await.map(drop).map_err(|e| from_sdk(e, api))
        }
        "iam:DeleteAccessKey" => client.delete_access_key().user_name(p("UserName")?).access_key_id(p("AccessKeyId")?).send().await.map(drop).map_err(|e| from_sdk(e, api)),
        "iam:PutUserPolicy" => {
            client.put_user_policy().user_name(p("UserName")?).policy_name(p("PolicyName")?).policy_document(p("PolicyDocument")?).send().await.map(drop).map_err(|e| from_sdk(e, api))
        }
        "iam:PutGroupPolicy" => {
            client.put_group_policy().group_name(p("GroupName")?).policy_name(p("PolicyName")?).policy_document(p("PolicyDocument")?).send().await.map(drop).map_err(|e| from_sdk(e, api))
        }
        "iam:PutRolePolicy" => {
            client.put_role_policy().role_name(p("RoleName")?).policy_name(p("PolicyName")?).policy_document(p("PolicyDocument")?).send().await.map(drop).map_err(|e| from_sdk(e, api))
        }
        "iam:DeleteUserPolicy" => client.delete_user_policy().user_name(p("UserName")?).policy_name(p("PolicyName")?).send().await.map(drop).map_err(|e| from_sdk(e, api)),
        "iam:DeleteGroupPolicy" => client.delete_group_policy().group_name(p("GroupName")?).policy_name(p("PolicyName")?).send().await.map(drop).map_err(|e| from_sdk(e, api)),
        "iam:DeleteRolePolicy" => client.delete_role_policy().role_name(p("RoleName")?).policy_name(p("PolicyName")?).send().await.map(drop).map_err(|e| from_sdk(e, api)),
        "iam:CreatePolicyVersion" => {
            let set_as_default = p("SetAsDefault")? == "true";
            client.create_policy_version().policy_arn(p("PolicyArn")?).policy_document(p("PolicyDocument")?).set_as_default(set_as_default).send().await.map(drop).map_err(|e| from_sdk(e, api))
        }
        "iam:DeletePolicyVersion" => client.delete_policy_version().policy_arn(p("PolicyArn")?).version_id(p("VersionId")?).send().await.map(drop).map_err(|e| from_sdk(e, api)),
        other => Err(AppError::other(format!("지원하지 않는 호출이에요: {other}"))),
    }
}

/// 변경이 부르는 IAM API를 순서대로 실행하고 부른 API 이름(`iam:AttachUserPolicy` …)을 돌려준다.
/// 하나라도 실패하면 거기서 멈추고 그 오류를 돌려준다(이미 부른 호출은 되돌리지 않는다).
pub async fn apply(client: &aws_sdk_iam::Client, s: &Snapshot, c: &IamChange) -> Result<Vec<String>, AppError> {
    let plan = calls(s, c);
    if plan.is_empty() {
        return Err(AppError::other("부를 IAM 호출을 만들지 못했어요. 대상이 있는지 확인해 주세요"));
    }
    let mut done = Vec::with_capacity(plan.len());
    for call in &plan {
        run(client, call).await?;
        done.push(call.api.clone());
    }
    Ok(done)
}

#[cfg(test)]
mod tests;

/// IAM을 바꾸는 호출이 이 파일 밖으로 새지 않았는지, 액세스 키를 만드는 호출이 어디에도 없는지 소스를 훑어 확인한다.
#[cfg(test)]
mod hygiene {
    use std::fs;
    use std::path::{Path, PathBuf};

    /// IAM 쓰기 SDK 호출. 이 파일에만 있어야 한다.
    const MUTATING: [&str; 18] = [
        "attach_user_policy",
        "attach_group_policy",
        "attach_role_policy",
        "detach_user_policy",
        "detach_group_policy",
        "detach_role_policy",
        "put_user_policy",
        "put_group_policy",
        "put_role_policy",
        "delete_user_policy",
        "delete_group_policy",
        "delete_role_policy",
        "add_user_to_group",
        "remove_user_from_group",
        "update_access_key",
        "delete_access_key",
        "create_policy_version",
        "delete_policy_version",
    ];

    fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    fn all_sources() -> Vec<PathBuf> {
        let mut files = Vec::new();
        sources(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
        files
    }

    fn is_this_file(path: &Path) -> bool {
        path.ends_with("iam/write.rs")
    }

    #[test]
    fn only_this_file_calls_the_iam_write_apis() {
        let files = all_sources();
        assert!(files.len() > 40, "소스를 제대로 찾지 못했어요: {}개", files.len());
        for path in files.iter().filter(|p| !is_this_file(p)) {
            let text = fs::read_to_string(path).unwrap();
            for name in MUTATING {
                assert!(!text.contains(&format!(".{name}(")), "{}에서 IAM 쓰기 호출 {name}을 불러요", path.display());
            }
        }
    }

    #[test]
    fn only_the_apply_command_reaches_the_writer() {
        // 쓰기는 항상 `commit`의 관문(막힘·확인 문구 재검증)을 거쳐야 하므로 `write::apply`를 부르는 곳은 `iam_apply` 하나다
        let call = ["write", "apply("].join("::");
        for path in all_sources() {
            let text = fs::read_to_string(&path).unwrap();
            if path.ends_with("src/iam_commands.rs") {
                assert_eq!(text.matches(&call).count(), 1, "iam_commands.rs에서 {call}는 한 번만 불러야 해요");
            } else if !path.starts_with(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/iam/write")) && !is_this_file(&path) {
                assert!(!text.contains(&call), "{}에서 쓰기를 직접 불러요", path.display());
            }
        }
    }

    #[test]
    fn this_file_does_call_every_listed_api() {
        let text = fs::read_to_string(all_sources().into_iter().find(|p| is_this_file(p)).unwrap()).unwrap();
        for name in MUTATING {
            assert!(text.contains(&format!(".{name}(")), "{name} 호출이 목록과 달라요");
        }
    }

    #[test]
    fn no_file_creates_access_keys() {
        // 이 파일 자신이 걸리지 않도록 이름을 조각으로 만든다
        let call = format!(".{}(", ["create", "access", "key"].join("_"));
        for path in all_sources() {
            assert!(!fs::read_to_string(&path).unwrap().contains(&call), "{}에서 액세스 키를 만들어요", path.display());
        }
    }
}
