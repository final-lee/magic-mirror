use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_iam::types::{Policy, PolicyScopeType, Role, User};

use super::util::{dt, opt, s, unknown_type, url_encode, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Iam;

const CONSOLE: &str = "https://console.aws.amazon.com/iam/home#";

#[async_trait]
impl ResourceAdapter for Iam {
    fn service_id(&self) -> &'static str {
        "iam"
    }
    fn display_name(&self) -> &'static str {
        "IAM"
    }
    fn is_global(&self) -> bool {
        true
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![
            ResourceType {
                id: "users",
                name: "Users",
                columns: vec![
                    col("name", "Name", Text),
                    col("id", "User ID", Mono),
                    col("created", "Created", Datetime),
                    col("lastUsed", "Last used", Datetime),
                ],
            },
            ResourceType {
                id: "roles",
                name: "Roles",
                columns: vec![
                    col("name", "Name", Text),
                    col("id", "Role ID", Mono),
                    col("created", "Created", Datetime),
                    col("description", "Description", Text),
                ],
            },
            ResourceType {
                id: "policies",
                name: "Policies",
                columns: vec![
                    col("name", "Name", Text),
                    col("id", "Policy ID", Mono),
                    col("attachments", "Attachments", Text),
                    col("updated", "Updated", Datetime),
                ],
            },
        ]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        let client = aws_sdk_iam::Client::new(cfg);
        let mut out = Capped::new();
        match type_id {
            "users" => {
                let mut pages = client.list_users().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "iam:ListUsers"))?;
                    for u in page.users() {
                        if !out.push(user(u)) {
                            break 'pages;
                        }
                    }
                }
            }
            "roles" => {
                let mut pages = client.list_roles().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "iam:ListRoles"))?;
                    for r in page.roles() {
                        if !out.push(role(r)) {
                            break 'pages;
                        }
                    }
                }
            }
            "policies" => {
                // 고객 관리형 정책만 (AWS 관리형은 수백 개라 제외)
                let mut pages = client.list_policies().scope(PolicyScopeType::Local).into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "iam:ListPolicies"))?;
                    for p in page.policies() {
                        if !out.push(policy(p)) {
                            break 'pages;
                        }
                    }
                }
            }
            other => return Err(unknown_type(other)),
        }
        Ok(out.finish())
    }
}

fn user(u: &User) -> Resource {
    let name = u.user_name().to_string();
    Resource::new(&name, &name)
        .arn(Some(u.arn()))
        .value("name", &name)
        .value("id", u.user_id())
        .value("created", dt(Some(u.create_date())))
        .value("lastUsed", dt(u.password_last_used()))
        .field("Path", u.path())
        .tags(u.tags().iter().map(|t| (Some(t.key()), Some(t.value()))))
        .raw(u)
        .console(format!("{CONSOLE}/users/details/{name}"))
}

fn role(r: &Role) -> Resource {
    let name = r.role_name().to_string();
    Resource::new(&name, &name)
        .arn(Some(r.arn()))
        .value("name", &name)
        .value("id", r.role_id())
        .value("created", dt(Some(r.create_date())))
        .value("description", s(r.description()))
        .field("Path", r.path())
        .field("Max session (s)", opt(r.max_session_duration()))
        .tags(r.tags().iter().map(|t| (Some(t.key()), Some(t.value()))))
        .raw(r)
        .console(format!("{CONSOLE}/roles/details/{name}"))
}

fn policy(p: &Policy) -> Resource {
    let name = s(p.policy_name());
    let arn = s(p.arn());
    Resource::new(&arn, &name)
        .arn(p.arn())
        .value("name", &name)
        .value("id", s(p.policy_id()))
        .value("attachments", opt(p.attachment_count()))
        .value("updated", dt(p.update_date()))
        .field("Default version", s(p.default_version_id()))
        .field("Description", s(p.description()))
        .field("Created", dt(p.create_date()))
        .raw(p)
        .console(format!("{CONSOLE}/policies/details/{}", url_encode(&arn)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_smithy_types::DateTime;

    #[test]
    fn user_resource() {
        let u = User::builder()
            .user_name("alice")
            .user_id("AIDA1")
            .arn("arn:aws:iam::1:user/alice")
            .path("/")
            .create_date(DateTime::from_secs(0))
            .build()
            .unwrap();
        let r = user(&u);
        assert_eq!(r.values["id"], "AIDA1");
        assert_eq!(r.values["created"], "1970-01-01T00:00:00Z");
        assert_eq!(r.values["lastUsed"], "");
        assert!(r.console_url.unwrap().ends_with("/users/details/alice"));
    }

    #[test]
    fn policy_console_url_is_encoded() {
        let p = Policy::builder()
            .policy_name("deploy")
            .policy_id("ANPA1")
            .arn("arn:aws:iam::1:policy/deploy")
            .attachment_count(2)
            .build();
        let r = policy(&p);
        assert_eq!(r.values["attachments"], "2");
        assert!(r.console_url.unwrap().ends_with("arn%3Aaws%3Aiam%3A%3A1%3Apolicy%2Fdeploy"));
    }
}
