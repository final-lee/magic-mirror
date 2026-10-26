use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_lambda::types::FunctionConfiguration;

use super::util::{opt, region, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Lambda;

#[async_trait]
impl ResourceAdapter for Lambda {
    fn service_id(&self) -> &'static str {
        "lambda"
    }
    fn display_name(&self) -> &'static str {
        "Lambda"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "functions",
            name: "Functions",
            columns: vec![
                col("name", "Function name", Text),
                col("runtime", "Runtime", Text),
                col("memory", "Memory", Text),
                col("lastModified", "Last modified", Datetime),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "functions" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_lambda::Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        let mut pages = client.list_functions().into_paginator().send();
        'pages: while let Some(page) = pages.next().await {
            let page = page.map_err(|e| from_sdk(e, "lambda:ListFunctions"))?;
            for f in page.functions() {
                if !out.push(function(f, &region)) {
                    break 'pages;
                }
            }
        }
        Ok(out.finish())
    }
}

/// Lambda의 "2026-10-21T14:02:00.000+0000"을 WebKit이 파싱할 수 있게 "+00:00"으로 바꾼다.
pub fn fix_tz(value: &str) -> String {
    let bytes = value.as_bytes();
    let n = bytes.len();
    if n > 5 && (bytes[n - 5] == b'+' || bytes[n - 5] == b'-') && bytes[n - 4..].iter().all(u8::is_ascii_digit) {
        format!("{}:{}", &value[..n - 2], &value[n - 2..])
    } else {
        value.to_string()
    }
}

fn function(f: &FunctionConfiguration, region: &str) -> Resource {
    let name = s(f.function_name());
    Resource::new(&name, &name)
        .arn(f.function_arn())
        .value("name", &name)
        .value("runtime", s(f.runtime().map(|r| r.as_str())))
        .value("memory", opt(f.memory_size().map(|m| format!("{m} MB"))))
        .value("lastModified", fix_tz(&s(f.last_modified())))
        .field("Handler", s(f.handler()))
        .field("Timeout", opt(f.timeout().map(|t| format!("{t}초"))))
        .field("Code size", format!("{} bytes", f.code_size()))
        .field("Role", s(f.role()))
        .field("Description", s(f.description()))
        .field(
            "Architectures",
            f.architectures().iter().map(|a| a.as_str()).collect::<Vec<_>>().join(", "),
        )
        .raw(f)
        .console(format!("https://{region}.console.aws.amazon.com/lambda/home?region={region}#/functions/{name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_lambda::types::Runtime;

    #[test]
    fn fixes_timezone_offset() {
        assert_eq!(fix_tz("2026-10-21T14:02:00.000+0000"), "2026-10-21T14:02:00.000+00:00");
        assert_eq!(fix_tz("2026-10-21T14:02:00.000-0530"), "2026-10-21T14:02:00.000-05:30");
        assert_eq!(fix_tz("2026-10-21T14:02:00Z"), "2026-10-21T14:02:00Z");
        assert_eq!(fix_tz(""), "");
    }

    #[test]
    fn function_resource() {
        let f = FunctionConfiguration::builder()
            .function_name("order-processor")
            .function_arn("arn:aws:lambda:r:1:function:order-processor")
            .runtime(Runtime::Nodejs20x)
            .memory_size(512)
            .last_modified("2026-10-21T14:02:00.000+0000")
            .build();
        let r = function(&f, "ap-northeast-2");
        assert_eq!(r.name, "order-processor");
        assert_eq!(r.values["runtime"], "nodejs20.x");
        assert_eq!(r.values["memory"], "512 MB");
        assert_eq!(r.values["lastModified"], "2026-10-21T14:02:00.000+00:00");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:lambda:r:1:function:order-processor"));
    }
}
