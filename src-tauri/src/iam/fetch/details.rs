//! `GetAccountAuthorizationDetails` 응답을 스냅숏 레코드로 바꾸고(순수), 계정 전체를 끝까지 읽는다.
//! 정책 문서는 URL 인코딩돼 오니 풀어서 담는다. 읽지 못한 문서는 "아무 권한도 안 준다"로 넘기지 않고 경고를 남긴다.

use std::collections::{BTreeMap, BTreeSet};

use aws_sdk_iam::operation::get_account_authorization_details::GetAccountAuthorizationDetailsOutput;
use aws_sdk_iam::types::{
    AttachedPermissionsBoundary, AttachedPolicy, EntityType, GroupDetail, ManagedPolicyDetail, PolicyDetail, RoleDetail, Tag, UserDetail,
};
use futures::stream::{self, StreamExt};

use crate::error::{from_sdk, AppError};
use crate::iam::clock::iso_of;
use crate::iam::model::{GroupRec, InlinePolicy, ManagedPolicyRec, RoleRec, Scope, UserRec, VersionRec};
use crate::iam::policy::{decode_document, parse_document};

/// 정책을 한꺼번에 몇 개까지 가져올지.
const POLICY_FETCH_CONCURRENCY: usize = 20;

/// 읽은 결과를 모으는 그릇. 페이지가 올 때마다 `absorb`로 레코드로 바꿔 담아서 SDK 응답은 바로 버린다.
#[derive(Default)]
pub(super) struct Details {
    pub users: Vec<UserRec>,
    pub groups: Vec<GroupRec>,
    pub roles: Vec<RoleRec>,
    pub policies: BTreeMap<String, ManagedPolicyRec>,
    pub warnings: Vec<String>,
}

/// 관리형 정책의 출처는 ARN의 계정 칸이 `aws`인지로 가른다.
fn scope_of(arn: &str) -> Scope {
    if arn.split(':').nth(4) == Some("aws") {
        Scope::Aws
    } else {
        Scope::Local
    }
}

fn path_of(path: Option<&str>) -> String {
    path.filter(|p| !p.is_empty()).unwrap_or("/").to_string()
}

fn tag_map(tags: &[Tag]) -> BTreeMap<String, String> {
    tags.iter().map(|t| (t.key().to_string(), t.value().to_string())).collect()
}

fn attached_arns(list: &[AttachedPolicy]) -> Vec<String> {
    list.iter().filter_map(|p| p.policy_arn()).map(str::to_string).collect()
}

fn boundary_arn(boundary: Option<&AttachedPermissionsBoundary>) -> Option<String> {
    boundary?.permissions_boundary_arn().map(str::to_string)
}

/// `v12` → 12. 숫자가 아니면 0.
fn version_number(id: &str) -> u32 {
    id.trim_start_matches(['v', 'V']).parse().unwrap_or(0)
}

/// 관리형 정책 하나를 만들 재료. 조회 방법(GAAD, GetPolicy)이 달라도 같은 규칙으로 만들려고 한곳에 모았다.
pub(super) struct PolicyParts<'a> {
    pub arn: &'a str,
    pub name: &'a str,
    pub description: Option<&'a str>,
    pub default_version_id: Option<&'a str>,
    pub attachment_count: i32,
    pub updated_at: Option<String>,
    pub versions: Vec<VersionRec>,
    /// 기본 버전 문서(URL 인코딩 그대로)
    pub document: Option<&'a str>,
}

pub(super) fn managed_rec(parts: PolicyParts, warnings: &mut Vec<String>) -> ManagedPolicyRec {
    let mut versions = parts.versions;
    versions.sort_by_key(|v| std::cmp::Reverse(version_number(&v.id)));
    let (raw, document) = match parts.document {
        Some(encoded) => {
            let raw = decode_document(encoded);
            let document = match parse_document(&raw) {
                Ok(doc) => Some(doc),
                Err(e) => {
                    warnings.push(format!("{} 정책을 해석하지 못했어요: {e}", parts.name));
                    None
                }
            };
            (Some(raw), document)
        }
        None => {
            warnings.push(format!("{} 정책의 문서를 가져오지 못했어요", parts.name));
            (None, None)
        }
    };
    ManagedPolicyRec {
        arn: parts.arn.to_string(),
        name: parts.name.to_string(),
        scope: scope_of(parts.arn),
        description: parts.description.map(str::to_string),
        default_version_id: parts.default_version_id.map(str::to_string),
        attachment_count: parts.attachment_count,
        updated_at: parts.updated_at,
        raw,
        document,
        versions,
    }
}

impl Details {
    /// `owner`는 경고에 쓰는 이름("사용자 alice").
    fn inline_policies(&mut self, owner: &str, list: &[PolicyDetail]) -> Vec<InlinePolicy> {
        list.iter()
            .map(|p| {
                let name = p.policy_name().unwrap_or_default().to_string();
                let raw = decode_document(p.policy_document().unwrap_or_default());
                let document = match parse_document(&raw) {
                    Ok(doc) => Some(doc),
                    Err(e) => {
                        self.warnings.push(format!("{owner}의 {name} 정책을 해석하지 못했어요: {e}"));
                        None
                    }
                };
                InlinePolicy { name, raw, document }
            })
            .collect()
    }

    fn user(&mut self, u: &UserDetail) -> UserRec {
        let name = u.user_name().unwrap_or_default().to_string();
        UserRec {
            arn: u.arn().unwrap_or_default().to_string(),
            path: path_of(u.path()),
            created_at: iso_of(u.create_date()),
            inline: self.inline_policies(&format!("사용자 {name}"), u.user_policy_list()),
            attached: attached_arns(u.attached_managed_policies()),
            groups: u.group_list().to_vec(),
            boundary: boundary_arn(u.permissions_boundary()),
            tags: tag_map(u.tags()),
            name,
        }
    }

    fn group(&mut self, g: &GroupDetail) -> GroupRec {
        let name = g.group_name().unwrap_or_default().to_string();
        GroupRec {
            arn: g.arn().unwrap_or_default().to_string(),
            path: path_of(g.path()),
            created_at: iso_of(g.create_date()),
            inline: self.inline_policies(&format!("그룹 {name}"), g.group_policy_list()),
            attached: attached_arns(g.attached_managed_policies()),
            name,
        }
    }

    fn role(&mut self, r: &RoleDetail) -> RoleRec {
        let name = r.role_name().unwrap_or_default().to_string();
        let trust_raw = r.assume_role_policy_document().map(decode_document);
        let trust = trust_raw.as_deref().and_then(|raw| match parse_document(raw) {
            Ok(doc) => Some(doc),
            Err(e) => {
                self.warnings.push(format!("역할 {name}의 신뢰 정책을 해석하지 못했어요: {e}"));
                None
            }
        });
        RoleRec {
            arn: r.arn().unwrap_or_default().to_string(),
            path: path_of(r.path()),
            created_at: iso_of(r.create_date()),
            inline: self.inline_policies(&format!("역할 {name}"), r.role_policy_list()),
            attached: attached_arns(r.attached_managed_policies()),
            boundary: boundary_arn(r.permissions_boundary()),
            tags: tag_map(r.tags()),
            trust_raw,
            trust,
            last_used: iso_of(r.role_last_used().and_then(|used| used.last_used_date())),
            name,
        }
    }

    fn managed(&mut self, p: &ManagedPolicyDetail) -> ManagedPolicyRec {
        let default_id = p.default_version_id();
        let is_default = |id: Option<&str>, flag: bool| flag || (default_id.is_some() && id == default_id);
        let versions = p
            .policy_version_list()
            .iter()
            .map(|v| VersionRec {
                id: v.version_id().unwrap_or_default().to_string(),
                is_default: is_default(v.version_id(), v.is_default_version()),
                created_at: iso_of(v.create_date()),
            })
            .collect();
        let document = p.policy_version_list().iter().find(|v| is_default(v.version_id(), v.is_default_version())).and_then(|v| v.document());
        managed_rec(
            PolicyParts {
                arn: p.arn().unwrap_or_default(),
                name: p.policy_name().unwrap_or_default(),
                description: p.description(),
                default_version_id: default_id,
                // AWS의 AttachmentCount는 권한 경계로 쓰이는 것을 세지 않는다. 경계 쪽은 스냅숏의 사용자·역할에서 센다
                attachment_count: p.attachment_count().unwrap_or(0),
                updated_at: iso_of(p.update_date()),
                versions,
                document,
            },
            &mut self.warnings,
        )
    }

    /// 한 페이지를 레코드로 바꿔 담는다.
    pub fn absorb(&mut self, page: &GetAccountAuthorizationDetailsOutput) {
        for user in page.user_detail_list() {
            let rec = self.user(user);
            self.users.push(rec);
        }
        for group in page.group_detail_list() {
            let rec = self.group(group);
            self.groups.push(rec);
        }
        for role in page.role_detail_list() {
            let rec = self.role(role);
            self.roles.push(rec);
        }
        for policy in page.policies() {
            let rec = self.managed(policy);
            self.policies.insert(rec.arn.clone(), rec);
        }
    }

    /// 사용자·그룹·역할에 붙어 있거나 권한 경계로 걸려 있는데 `policies`에 없는 관리형 정책의 ARN(정렬, 중복 없음).
    pub fn missing_policy_arns(&self) -> Vec<String> {
        let mut wanted: BTreeSet<&str> = BTreeSet::new();
        for u in &self.users {
            wanted.extend(u.attached.iter().map(String::as_str).chain(u.boundary.as_deref()));
        }
        for g in &self.groups {
            wanted.extend(g.attached.iter().map(String::as_str));
        }
        for r in &self.roles {
            wanted.extend(r.attached.iter().map(String::as_str).chain(r.boundary.as_deref()));
        }
        wanted.into_iter().filter(|arn| !self.policies.contains_key(*arn)).map(str::to_string).collect()
    }
}

/// 계정의 사용자·그룹·역할·관리형 정책을 끝까지 읽는다.
pub(super) async fn fetch_all(client: &aws_sdk_iam::Client) -> Result<Details, AppError> {
    let mut details = Details::default();
    let mut pages = client
        .get_account_authorization_details()
        .filter(EntityType::User)
        .filter(EntityType::Role)
        .filter(EntityType::Group)
        .filter(EntityType::LocalManagedPolicy)
        .filter(EntityType::AwsManagedPolicy)
        .into_paginator()
        .page_size(1000)
        .send();
    while let Some(page) = pages.next().await {
        details.absorb(&page.map_err(|e| from_sdk(e, "iam:GetAccountAuthorizationDetails"))?);
    }
    Ok(details)
}

/// `GetPolicy` + `GetPolicyVersion`으로 정책 하나를 읽는다.
async fn load_policy(client: &aws_sdk_iam::Client, arn: &str) -> Result<(aws_sdk_iam::types::Policy, Option<aws_sdk_iam::types::PolicyVersion>), AppError> {
    let out = client.get_policy().policy_arn(arn).send().await.map_err(|e| from_sdk(e, "iam:GetPolicy"))?;
    let policy = out.policy().cloned().ok_or_else(|| AppError::other("정책 정보가 비어 있어요"))?;
    let Some(version_id) = policy.default_version_id() else {
        return Ok((policy, None));
    };
    let out = client.get_policy_version().policy_arn(arn).version_id(version_id).send().await.map_err(|e| from_sdk(e, "iam:GetPolicyVersion"))?;
    let version = out.policy_version().cloned();
    Ok((policy, version))
}

/// 붙어 있는데 목록에 없던 관리형 정책을 하나씩(20개씩 동시에) 읽어 채운다. 못 읽은 정책은 경고만 남기고 넘어간다.
pub(super) async fn fill_missing(client: &aws_sdk_iam::Client, details: &mut Details) {
    let arns = details.missing_policy_arns();
    if arns.is_empty() {
        return;
    }
    let loaded: Vec<(String, Result<_, AppError>)> =
        stream::iter(arns).map(|arn| async move { let result = load_policy(client, &arn).await; (arn, result) }).buffered(POLICY_FETCH_CONCURRENCY).collect().await;
    for (arn, result) in loaded {
        match result {
            Ok((policy, version)) => {
                let default_id = policy.default_version_id();
                let rec = managed_rec(
                    PolicyParts {
                        arn: &arn,
                        name: policy.policy_name().unwrap_or_else(|| arn.rsplit('/').next().unwrap_or(&arn)),
                        description: policy.description(),
                        default_version_id: default_id,
                        attachment_count: policy.attachment_count().unwrap_or(0),
                        updated_at: iso_of(policy.update_date()),
                        versions: default_id
                            .map(|id| VersionRec { id: id.to_string(), is_default: true, created_at: iso_of(version.as_ref().and_then(|v| v.create_date())) })
                            .into_iter()
                            .collect(),
                        document: version.as_ref().and_then(|v| v.document()),
                    },
                    &mut details.warnings,
                );
                details.policies.insert(arn, rec);
            }
            Err(e) => details.warnings.push(format!("{arn} 정책을 불러오지 못했어요: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use aws_sdk_iam::types::{PolicyVersion, RoleLastUsed};
    use aws_smithy_types::DateTime;
    use serde_json::json;

    use super::*;
    use crate::adapters::util::url_encode;
    use crate::iam::policy::{Actions, Effect};

    fn doc(statements: serde_json::Value) -> String {
        json!({ "Version": "2012-10-17", "Statement": statements }).to_string()
    }

    fn encoded(statements: serde_json::Value) -> String {
        url_encode(&doc(statements))
    }

    fn inline_detail(name: &str, document: &str) -> PolicyDetail {
        PolicyDetail::builder().policy_name(name).policy_document(document).build()
    }

    fn attached(name: &str, arn: &str) -> AttachedPolicy {
        AttachedPolicy::builder().policy_name(name).policy_arn(arn).build()
    }

    fn at(secs: i64) -> DateTime {
        DateTime::from_secs(secs)
    }

    fn absorbed(page: GetAccountAuthorizationDetailsOutput) -> Details {
        let mut details = Details::default();
        details.absorb(&page);
        details
    }

    #[test]
    fn users_keep_inline_policies_groups_boundary_and_tags() {
        let allow_s3 = encoded(json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*" }]));
        let user = UserDetail::builder()
            .user_name("bob")
            .arn("arn:aws:iam::111111111111:user/dev/bob")
            .path("/dev/")
            .create_date(at(1_700_000_000))
            .user_policy_list(inline_detail("assets", &allow_s3))
            .attached_managed_policies(attached("ReadOnly", "arn:aws:iam::aws:policy/ReadOnlyAccess"))
            .group_list("admins")
            .group_list("devs")
            .permissions_boundary(AttachedPermissionsBoundary::builder().permissions_boundary_arn("arn:aws:iam::111111111111:policy/b").build())
            .tags(Tag::builder().key("team").value("core").build().unwrap())
            .build();
        let d = absorbed(GetAccountAuthorizationDetailsOutput::builder().user_detail_list(user).build());
        assert!(d.warnings.is_empty(), "{:?}", d.warnings);
        let u = &d.users[0];
        assert_eq!((u.name.as_str(), u.arn.as_str(), u.path.as_str()), ("bob", "arn:aws:iam::111111111111:user/dev/bob", "/dev/"));
        assert_eq!(u.created_at.as_deref(), Some("2023-11-14T22:13:20Z"));
        assert_eq!(u.groups, vec!["admins".to_string(), "devs".to_string()]);
        assert_eq!(u.attached, vec!["arn:aws:iam::aws:policy/ReadOnlyAccess".to_string()]);
        assert_eq!(u.boundary.as_deref(), Some("arn:aws:iam::111111111111:policy/b"));
        assert_eq!(u.tags.get("team").map(String::as_str), Some("core"));
        assert_eq!(u.inline.len(), 1);
        assert_eq!(u.inline[0].name, "assets");
        // URL 인코딩이 풀려 있다
        assert!(u.inline[0].raw.starts_with('{'), "{}", u.inline[0].raw);
        let parsed = u.inline[0].document.as_ref().unwrap();
        assert_eq!(parsed.statements[0].effect, Effect::Allow);
        assert_eq!(parsed.statements[0].actions, Actions::Action(vec!["s3:GetObject".to_string()]));
    }

    #[test]
    fn a_missing_path_is_the_root_path() {
        let d = absorbed(
            GetAccountAuthorizationDetailsOutput::builder()
                .user_detail_list(UserDetail::builder().user_name("a").arn("arn:aws:iam::1:user/a").build())
                .group_detail_list(GroupDetail::builder().group_name("g").arn("arn:aws:iam::1:group/g").build())
                .build(),
        );
        assert_eq!((d.users[0].path.as_str(), d.groups[0].path.as_str()), ("/", "/"));
        assert_eq!(d.users[0].created_at, None);
        assert!(d.users[0].boundary.is_none() && d.users[0].inline.is_empty());
    }

    #[test]
    fn roles_decode_the_trust_policy_and_keep_the_last_use() {
        let trust = encoded(json!([{ "Effect": "Allow", "Principal": { "Service": "ec2.amazonaws.com" }, "Action": "sts:AssumeRole" }]));
        let role = RoleDetail::builder()
            .role_name("deploy")
            .arn("arn:aws:iam::111111111111:role/deploy")
            .path("/")
            .assume_role_policy_document(&trust)
            .role_policy_list(inline_detail("inline", &encoded(json!([{ "Effect": "Allow", "Action": "sqs:*", "Resource": "*" }]))))
            .attached_managed_policies(attached("X", "arn:aws:iam::111111111111:policy/x"))
            .role_last_used(RoleLastUsed::builder().last_used_date(at(1_700_000_000)).region("ap-northeast-2").build())
            .tags(Tag::builder().key("aws:cloudformation:stack-name").value("stack").build().unwrap())
            .build();
        let d = absorbed(GetAccountAuthorizationDetailsOutput::builder().role_detail_list(role).build());
        assert!(d.warnings.is_empty(), "{:?}", d.warnings);
        let r = &d.roles[0];
        assert_eq!(r.last_used.as_deref(), Some("2023-11-14T22:13:20Z"));
        assert!(r.trust_raw.as_deref().unwrap().starts_with('{'));
        let trust_doc = r.trust.as_ref().unwrap();
        assert_eq!(trust_doc.statements[0].principal, Some(json!({ "Service": "ec2.amazonaws.com" })));
        assert_eq!(r.inline[0].name, "inline");
        assert_eq!(r.attached, vec!["arn:aws:iam::111111111111:policy/x".to_string()]);
        assert!(r.tags.contains_key("aws:cloudformation:stack-name"));
        // 사용 기록이 없는 역할
        let never = absorbed(GetAccountAuthorizationDetailsOutput::builder().role_detail_list(RoleDetail::builder().role_name("n").build()).build());
        assert_eq!(never.roles[0].last_used, None);
        assert!(never.roles[0].trust_raw.is_none() && never.roles[0].trust.is_none());
    }

    #[test]
    fn groups_keep_their_policies() {
        let group = GroupDetail::builder()
            .group_name("admins")
            .arn("arn:aws:iam::111111111111:group/admins")
            .path("/")
            .group_policy_list(inline_detail("g", &doc(json!([{ "Effect": "Allow", "Action": "*", "Resource": "*" }]))))
            .attached_managed_policies(attached("Admin", "arn:aws:iam::aws:policy/AdministratorAccess"))
            .build();
        let d = absorbed(GetAccountAuthorizationDetailsOutput::builder().group_detail_list(group).build());
        let g = &d.groups[0];
        assert_eq!(g.name, "admins");
        assert_eq!(g.attached, vec!["arn:aws:iam::aws:policy/AdministratorAccess".to_string()]);
        // 이미 평문인 문서도 그대로 읽는다
        assert!(g.inline[0].document.is_some());
    }

    #[test]
    fn documents_that_cannot_be_read_leave_a_warning_naming_the_policy() {
        let user = UserDetail::builder()
            .user_name("bob")
            .arn("arn:aws:iam::1:user/bob")
            .user_policy_list(inline_detail("broken", "not json at all"))
            .user_policy_list(inline_detail("fine", &doc(json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*" }]))))
            .build();
        let role = RoleDetail::builder()
            .role_name("r")
            .arn("arn:aws:iam::1:role/r")
            .assume_role_policy_document("{\"Statement\": 3}")
            .role_policy_list(inline_detail("oops", "{}"))
            .build();
        let group = GroupDetail::builder().group_name("g").arn("arn:aws:iam::1:group/g").group_policy_list(inline_detail("bad", "[")).build();
        let d = absorbed(GetAccountAuthorizationDetailsOutput::builder().user_detail_list(user).role_detail_list(role).group_detail_list(group).build());
        assert_eq!(d.warnings.len(), 4, "{:?}", d.warnings);
        assert!(d.warnings[0].starts_with("사용자 bob의 broken 정책을 해석하지 못했어요: "), "{}", d.warnings[0]);
        assert!(d.warnings.iter().any(|w| w.starts_with("역할 r의 신뢰 정책을 해석하지 못했어요: ")), "{:?}", d.warnings);
        assert!(d.warnings.iter().any(|w| w.starts_with("역할 r의 oops 정책을 해석하지 못했어요: ")), "{:?}", d.warnings);
        assert!(d.warnings.iter().any(|w| w.starts_with("그룹 g의 bad 정책을 해석하지 못했어요: ")), "{:?}", d.warnings);
        // 정책 레코드는 남고 문서만 없다. 원문은 보여 줄 수 있게 둔다
        assert!(d.users[0].inline[0].document.is_none());
        assert_eq!(d.users[0].inline[0].raw, "not json at all");
        assert!(d.users[0].inline[1].document.is_some());
        assert!(d.roles[0].trust.is_none() && d.roles[0].trust_raw.is_some());
    }

    fn version(id: &str, default: bool, document: &str, secs: i64) -> PolicyVersion {
        PolicyVersion::builder().version_id(id).is_default_version(default).document(document).create_date(at(secs)).build()
    }

    #[test]
    fn managed_policies_use_the_default_version_and_list_versions_newest_first() {
        let v1 = encoded(json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*" }]));
        let v2 = encoded(json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*" }]));
        let policy = ManagedPolicyDetail::builder()
            .policy_name("team-policy")
            .arn("arn:aws:iam::111111111111:policy/team/team-policy")
            .default_version_id("v2")
            .attachment_count(2)
            .permissions_boundary_usage_count(3)
            .description("팀 정책")
            .update_date(at(1_700_000_000))
            .policy_version_list(version("v1", false, &v1, 1_600_000_000))
            .policy_version_list(version("v2", true, &v2, 1_700_000_000))
            .policy_version_list(version("v10", false, &v1, 1_650_000_000))
            .build();
        let d = absorbed(GetAccountAuthorizationDetailsOutput::builder().policies(policy).build());
        assert!(d.warnings.is_empty(), "{:?}", d.warnings);
        let rec = &d.policies["arn:aws:iam::111111111111:policy/team/team-policy"];
        assert_eq!((rec.name.as_str(), rec.scope, rec.description.as_deref()), ("team-policy", Scope::Local, Some("팀 정책")));
        assert_eq!(rec.default_version_id.as_deref(), Some("v2"));
        // 권한 경계로 쓰는 수는 더하지 않는다
        assert_eq!(rec.attachment_count, 2);
        assert_eq!(rec.updated_at.as_deref(), Some("2023-11-14T22:13:20Z"));
        let ids: Vec<(&str, bool)> = rec.versions.iter().map(|v| (v.id.as_str(), v.is_default)).collect();
        assert_eq!(ids, vec![("v10", false), ("v2", true), ("v1", false)]);
        assert_eq!(rec.versions[1].created_at.as_deref(), Some("2023-11-14T22:13:20Z"));
        assert!(rec.raw.as_deref().unwrap().contains("\"s3:*\""), "{:?}", rec.raw);
        assert_eq!(rec.document.as_ref().unwrap().statements[0].actions, Actions::Action(vec!["s3:*".to_string()]));
    }

    #[test]
    fn aws_managed_policies_are_told_apart_by_the_arn() {
        let policy = ManagedPolicyDetail::builder()
            .policy_name("AdministratorAccess")
            .arn("arn:aws:iam::aws:policy/AdministratorAccess")
            .default_version_id("v1")
            .policy_version_list(version("v1", true, &doc(json!([{ "Effect": "Allow", "Action": "*", "Resource": "*" }])), 0))
            .build();
        let d = absorbed(GetAccountAuthorizationDetailsOutput::builder().policies(policy).build());
        assert_eq!(d.policies["arn:aws:iam::aws:policy/AdministratorAccess"].scope, Scope::Aws);
    }

    #[test]
    fn default_version_is_found_by_id_when_the_flag_is_missing() {
        let policy = ManagedPolicyDetail::builder()
            .policy_name("p")
            .arn("arn:aws:iam::1:policy/p")
            .default_version_id("v3")
            .policy_version_list(version("v2", false, &doc(json!([{ "Effect": "Deny", "Action": "*", "Resource": "*" }])), 0))
            .policy_version_list(PolicyVersion::builder().version_id("v3").document(doc(json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*" }]))).build())
            .build();
        let rec = &absorbed(GetAccountAuthorizationDetailsOutput::builder().policies(policy).build()).policies["arn:aws:iam::1:policy/p"];
        assert_eq!(rec.document.as_ref().unwrap().statements[0].effect, Effect::Allow);
        assert!(rec.versions.iter().find(|v| v.id == "v3").unwrap().is_default);
    }

    #[test]
    fn unreadable_or_missing_policy_documents_warn() {
        let bad = ManagedPolicyDetail::builder()
            .policy_name("bad")
            .arn("arn:aws:iam::1:policy/bad")
            .default_version_id("v1")
            .policy_version_list(version("v1", true, "{\"Statement\": []", 0))
            .build();
        let none = ManagedPolicyDetail::builder().policy_name("none").arn("arn:aws:iam::1:policy/none").default_version_id("v1").build();
        let d = absorbed(GetAccountAuthorizationDetailsOutput::builder().policies(bad).policies(none).build());
        assert_eq!(d.warnings.len(), 2, "{:?}", d.warnings);
        assert!(d.warnings[0].starts_with("bad 정책을 해석하지 못했어요: "), "{}", d.warnings[0]);
        assert_eq!(d.warnings[1], "none 정책의 문서를 가져오지 못했어요");
        assert!(d.policies["arn:aws:iam::1:policy/bad"].document.is_none());
        assert!(d.policies["arn:aws:iam::1:policy/bad"].raw.is_some());
        assert!(d.policies["arn:aws:iam::1:policy/none"].raw.is_none());
    }

    #[test]
    fn pages_add_up() {
        let mut d = Details::default();
        d.absorb(&GetAccountAuthorizationDetailsOutput::builder().user_detail_list(UserDetail::builder().user_name("a").arn("arn:aws:iam::1:user/a").build()).build());
        d.absorb(&GetAccountAuthorizationDetailsOutput::builder().user_detail_list(UserDetail::builder().user_name("b").arn("arn:aws:iam::1:user/b").build()).build());
        let names: Vec<&str> = d.users.iter().map(|u| u.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b"]);
    }

    #[test]
    fn missing_policy_arns_cover_attachments_and_boundaries_once() {
        let mut d = Details::default();
        let have = "arn:aws:iam::aws:policy/Have";
        d.policies.insert(have.into(), ManagedPolicyRec { arn: have.into(), ..Default::default() });
        d.users.push(UserRec { attached: vec![have.into(), "arn:aws:iam::1:policy/u-managed".into()], boundary: Some("arn:aws:iam::1:policy/u-boundary".into()), ..Default::default() });
        d.groups.push(GroupRec { attached: vec!["arn:aws:iam::1:policy/u-managed".into(), "arn:aws:iam::1:policy/g-managed".into()], ..Default::default() });
        d.roles.push(RoleRec { attached: vec!["arn:aws:iam::aws:policy/Gone".into()], boundary: Some(have.into()), ..Default::default() });
        assert_eq!(
            d.missing_policy_arns(),
            vec![
                "arn:aws:iam::1:policy/g-managed".to_string(),
                "arn:aws:iam::1:policy/u-boundary".to_string(),
                "arn:aws:iam::1:policy/u-managed".to_string(),
                "arn:aws:iam::aws:policy/Gone".to_string(),
            ]
        );
        assert!(Details::default().missing_policy_arns().is_empty());
    }

    #[test]
    fn version_numbers_sort_numerically() {
        assert_eq!((version_number("v1"), version_number("v10"), version_number("V3"), version_number("x")), (1, 10, 3, 0));
    }
}
