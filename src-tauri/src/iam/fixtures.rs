//! 테스트용 IAM 스냅숏. 계정 `111111111111`의 사용자·그룹·역할·정책을 코드로 만든다.

use serde_json::{json, Value};

use super::model::{GroupRec, InlinePolicy, ManagedPolicyRec, RoleRec, Scope, Snapshot, UserRec, VersionRec};
use super::policy::{parse_document, PolicyDocument};

pub const ACCOUNT: &str = "111111111111";

pub const ALICE: &str = "arn:aws:iam::111111111111:user/alice";
pub const BOB: &str = "arn:aws:iam::111111111111:user/bob";
pub const CAROL: &str = "arn:aws:iam::111111111111:user/carol";
pub const ADMINS: &str = "arn:aws:iam::111111111111:group/admins";
pub const DEPLOY: &str = "arn:aws:iam::111111111111:role/deploy";
pub const CI: &str = "arn:aws:iam::111111111111:role/ci";
pub const VENDOR: &str = "arn:aws:iam::111111111111:role/vendor";
pub const OPEN: &str = "arn:aws:iam::111111111111:role/open";
pub const SLR: &str = "arn:aws:iam::111111111111:role/aws-service-role/x.amazonaws.com/AWSServiceRoleForX";
pub const SSO: &str = "arn:aws:iam::111111111111:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_abc";

pub const ADMIN_POLICY: &str = "arn:aws:iam::aws:policy/AdministratorAccess";
pub const S3_FULL: &str = "arn:aws:iam::aws:policy/AmazonS3FullAccess";
pub const CAROL_BOUNDARY: &str = "arn:aws:iam::111111111111:policy/carol-boundary";
pub const UNUSED_POLICY: &str = "arn:aws:iam::111111111111:policy/unused-policy";

const CREATED: &str = "2025-01-01T00:00:00Z";

/// `{"Version": ..., "Statement": statements}`
pub fn policy(statements: Value) -> Value {
    json!({ "Version": "2012-10-17", "Statement": statements })
}

pub fn doc(value: Value) -> PolicyDocument {
    parse_document(&value.to_string()).expect("테스트 정책은 올바른 문서여야 해요")
}

pub fn inline(name: &str, value: Value) -> InlinePolicy {
    let raw = value.to_string();
    InlinePolicy { name: name.into(), document: Some(parse_document(&raw).expect("테스트 정책은 올바른 문서여야 해요")), raw }
}

/// 이름은 ARN의 마지막 조각이다.
pub fn managed(arn: &str, scope: Scope, attachment_count: i32, value: Value) -> ManagedPolicyRec {
    let raw = value.to_string();
    ManagedPolicyRec {
        arn: arn.into(),
        name: arn.rsplit('/').next().unwrap_or(arn).into(),
        scope,
        description: None,
        default_version_id: Some("v1".into()),
        attachment_count,
        updated_at: Some("2026-01-01T00:00:00Z".into()),
        document: Some(parse_document(&raw).expect("테스트 정책은 올바른 문서여야 해요")),
        raw: Some(raw),
        versions: vec![VersionRec { id: "v1".into(), is_default: true, created_at: Some("2026-01-01T00:00:00Z".into()) }],
    }
}

pub fn user(name: &str) -> UserRec {
    UserRec { arn: format!("arn:aws:iam::{ACCOUNT}:user/{name}"), name: name.into(), path: "/".into(), created_at: Some(CREATED.into()), ..Default::default() }
}

/// 신뢰 정책 문서(문장 하나).
pub fn trust(principal: Value, action: &str, condition: Option<Value>) -> Value {
    let mut statement = json!({ "Effect": "Allow", "Principal": principal, "Action": action });
    if let Some(condition) = condition {
        statement["Condition"] = condition;
    }
    policy(json!([statement]))
}

pub fn role(name: &str, path: &str, trust_document: Value) -> RoleRec {
    RoleRec {
        arn: format!("arn:aws:iam::{ACCOUNT}:role{path}{name}"),
        name: name.into(),
        path: path.into(),
        created_at: Some(CREATED.into()),
        trust_raw: Some(trust_document.to_string()),
        trust: Some(doc(trust_document)),
        ..Default::default()
    }
}

/// 사용자 한 명(`u`)에 인라인 정책 하나(`p`)만 붙인 스냅숏과 그 사용자의 ARN.
pub fn solo_user(statements: Value) -> (Snapshot, String) {
    let mut u = user("u");
    u.inline.push(inline("p", policy(statements)));
    let arn = u.arn.clone();
    (Snapshot { account_id: ACCOUNT.into(), users: vec![u], ..Default::default() }, arn)
}

/// `solo_user`에 권한 경계(관리형 `b`) 하나를 더 건 스냅숏.
pub fn solo_user_with_boundary(statements: Value, boundary_statements: Value) -> (Snapshot, String) {
    let (mut s, arn) = solo_user(statements);
    let boundary_arn = format!("arn:aws:iam::{ACCOUNT}:policy/b");
    s.policies.insert(boundary_arn.clone(), managed(&boundary_arn, Scope::Local, 1, policy(boundary_statements)));
    s.users[0].boundary = Some(boundary_arn);
    (s, arn)
}

pub fn snapshot() -> Snapshot {
    let mut s = Snapshot {
        account_id: ACCOUNT.into(),
        caller_arn: ALICE.into(),
        caller_principal_arn: Some(ALICE.into()),
        fetched_at: "2026-10-26T00:00:00Z".into(),
        ..Default::default()
    };

    let policies = [
        managed(ADMIN_POLICY, Scope::Aws, 1, policy(json!([{ "Effect": "Allow", "Action": "*", "Resource": "*" }]))),
        managed(S3_FULL, Scope::Aws, 1, policy(json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*" }]))),
        managed(CAROL_BOUNDARY, Scope::Local, 1, policy(json!([{ "Sid": "ReadOnly", "Effect": "Allow", "Action": "s3:Get*", "Resource": "*" }]))),
        managed(UNUSED_POLICY, Scope::Local, 0, policy(json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*" }]))),
    ];
    for p in policies {
        s.policies.insert(p.arn.clone(), p);
    }

    s.groups.push(GroupRec {
        arn: ADMINS.into(),
        name: "admins".into(),
        path: "/".into(),
        created_at: Some(CREATED.into()),
        attached: vec![ADMIN_POLICY.into()],
        ..Default::default()
    });

    let mut alice = user("alice");
    alice.groups = vec!["admins".into()];
    let mut bob = user("bob");
    bob.inline.push(inline(
        "assets-read",
        policy(json!([
            { "Sid": "ReadAssets", "Effect": "Allow", "Action": ["s3:Get*", "s3:List*"], "Resource": "arn:aws:s3:::prod-assets*" },
            { "Sid": "DenySecret", "Effect": "Deny", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::prod-assets/secret/*" }
        ])),
    ));
    let mut carol = user("carol");
    carol.attached = vec![S3_FULL.into()];
    carol.boundary = Some(CAROL_BOUNDARY.into());
    s.users = vec![alice, bob, carol];

    let mut deploy = role("deploy", "/", trust(json!({ "Service": "codebuild.amazonaws.com" }), "sts:AssumeRole", None));
    deploy.inline.push(inline(
        "deploy-inline",
        policy(json!([
            { "Sid": "PassRole", "Effect": "Allow", "Action": "iam:PassRole", "Resource": "*" },
            {
                "Sid": "LambdaInRegion", "Effect": "Allow", "Action": "lambda:*", "Resource": "*",
                "Condition": { "StringEquals": { "aws:RequestedRegion": "ap-northeast-2" } }
            }
        ])),
    ));
    deploy.tags.insert("aws:cloudformation:stack-name".into(), "deploy-stack".into());
    deploy.last_used = Some("2026-10-20T00:00:00Z".into());

    let github = format!("arn:aws:iam::{ACCOUNT}:oidc-provider/token.actions.githubusercontent.com");
    let ci = role(
        "ci",
        "/",
        trust(
            json!({ "Federated": github }),
            "sts:AssumeRoleWithWebIdentity",
            Some(json!({
                "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
                "StringLike": { "token.actions.githubusercontent.com:sub": "repo:acme/app:*" }
            })),
        ),
    );
    let vendor = role("vendor", "/", trust(json!({ "AWS": "arn:aws:iam::999999999999:root" }), "sts:AssumeRole", None));
    let open = role("open", "/", trust(json!({ "AWS": "*" }), "sts:AssumeRole", None));
    let slr = role("AWSServiceRoleForX", "/aws-service-role/x.amazonaws.com/", trust(json!({ "Service": "x.amazonaws.com" }), "sts:AssumeRole", None));
    let saml = format!("arn:aws:iam::{ACCOUNT}:saml-provider/AWSSSO_abc_DO_NOT_DELETE");
    let sso = role(
        "AWSReservedSSO_Admin_abc",
        "/aws-reserved/sso.amazonaws.com/",
        trust(json!({ "Federated": saml }), "sts:AssumeRoleWithSAML", Some(json!({ "StringEquals": { "SAML:aud": "https://signin.aws.amazon.com/saml" } }))),
    );
    s.roles = vec![deploy, ci, vendor, open, slr, sso];
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_arns_match_the_records() {
        let s = snapshot();
        for (arn, name) in [(ALICE, "alice"), (BOB, "bob"), (CAROL, "carol")] {
            assert_eq!(s.user(name).map(|u| u.arn.as_str()), Some(arn));
        }
        assert_eq!(s.group("admins").map(|g| g.arn.as_str()), Some(ADMINS));
        for (arn, name) in [(DEPLOY, "deploy"), (CI, "ci"), (VENDOR, "vendor"), (OPEN, "open"), (SLR, "AWSServiceRoleForX"), (SSO, "AWSReservedSSO_Admin_abc")] {
            assert_eq!(s.role(name).map(|r| r.arn.as_str()), Some(arn));
        }
        for arn in [ADMIN_POLICY, S3_FULL, CAROL_BOUNDARY, UNUSED_POLICY] {
            assert!(s.policies.contains_key(arn), "{arn}");
        }
    }
}
