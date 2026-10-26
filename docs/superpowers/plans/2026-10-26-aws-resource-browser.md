# Magic Mirror (AWS 리소스 브라우저) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AWS 프로필/리전을 골라 16개 서비스의 리소스를 Forklift 스타일 3단 화면에서 조회하는 Tauri 데스크탑 앱을 만든다.

**Architecture:** Rust 백엔드가 AWS SDK for Rust로 서비스별 어댑터(`ResourceAdapter` trait)를 통해 리소스를 조회해 공통 `Resource` 모델로 변환하고, Tauri 커맨드로 노출한다. React 프론트엔드는 `list_services` 결과(서비스/리소스 타입/칼럼 정의)로 사이드바와 표를 그리며 TanStack Query로 캐시한다. 상세 정보는 목록 응답에 포함된다.

**Tech Stack:** Tauri 2, Rust(aws-config 1.x, aws-sdk-* 1.x, tokio, serde, thiserror, async-trait, futures), React 18 + TypeScript + Vite 5, TanStack Query 5, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-26-aws-resource-browser-design.md`

## Global Constraints

- 조회 전용: 어떤 AWS 변경 API(Create/Update/Delete/Start/Stop/Put)도 호출하지 않는다.
- Secrets Manager: `GetSecretValue`를 절대 호출하지 않는다. `ListSecrets` 메타데이터만 사용한다.
- 목록 상한 `MAX_ITEMS = 1000`. 초과 시 `truncated: true`로 반환하고 UI에 "1,000개까지만 표시해요"를 표시한다.
- 전역 서비스(S3 버킷 목록, IAM, CloudFront, Route53)는 리전 `us-east-1` 클라이언트로 호출하고, 프론트 캐시 키의 리전 자리에 `"global"`을 쓴다.
- 서비스 표시 순서(레지스트리 순서): EC2, S3, Lambda, RDS, ECS, EKS, VPC, IAM, DynamoDB, CloudWatch Logs, CloudFront, SQS, SNS, ECR, Route53, Secrets Manager.
- 서비스 ID: `ec2, s3, lambda, rds, ecs, eks, vpc, iam, dynamodb, logs, cloudfront, sqs, sns, ecr, route53, secretsmanager`.
- 첫 실행 설정 기본값: 16개 서비스 모두 활성화, 즐겨찾기 없음.
- 설정 파일: Tauri app data dir의 `settings.json` (`{ enabledServices, favorites: [{service, type}], lastProfile, lastRegion }`).
- UI 문구는 한국어(해요체). 코드 식별자와 커밋 메시지는 영어.
- AWS SDK getter 시그니처(Option 여부, `&str` vs `Option<&str>`)가 계획의 코드와 다르면 컴파일러 안내에 맞춰 고치되, 표시되는 값과 동작은 유지한다.
- 모든 Rust 명령은 `src-tauri/`에서, 모든 npm 명령은 저장소 루트에서 실행한다.

---

## File Structure

```
package.json, index.html, vite.config.ts, tsconfig.json, app-icon.svg
src/
  main.tsx                 React 진입점 + QueryClientProvider
  App.tsx                  전역 상태(프로필/리전/선택/S3 위치/필터) + 레이아웃 + ⌘F/⌘R
  styles.css               전체 스타일 (목업 기반)
  api/types.ts             Rust 모델과 1:1 TS 타입
  api/client.ts            invoke 래퍼 (api 객체)
  api/errors.ts            isAppError, errorMessage
  api/desktop.ts           openUrl, copy (Tauri 플러그인 래퍼)
  api/queries.ts           TanStack Query 훅
  lib/format.ts            formatBytes/formatDate/formatValue/stateColor/compareValues
  lib/regions.ts           리전 목록
  lib/detail.ts            DetailData + resourceDetail/s3EntryDetail
  lib/s3.ts                prefixSegments, s3EntryToRow, S3_COLUMNS
  hooks/useCopyShortcut.ts ⌘C 복사
  components/Toolbar.tsx, Sidebar.tsx, ServiceBadge.tsx, ResourceTable.tsx, Cell.tsx,
             DetailPanel.tsx, RawModal.tsx, ErrorState.tsx, Breadcrumb.tsx, StatusBar.tsx,
             MainArea.tsx, ResourceArea.tsx, S3Area.tsx, ServiceSettings.tsx, NoProfiles.tsx
  test/setup.ts, test/utils.tsx
src-tauri/
  Cargo.toml, build.rs, tauri.conf.json, capabilities/default.json, icons/*
  src/main.rs, lib.rs       앱 부트스트랩, 커맨드 등록
  src/model.rs              Column/ResourceType/ServiceInfo/Resource/ListResult
  src/error.rs              AppError + classify/from_sdk
  src/settings.rs           Settings load/save
  src/aws/mod.rs, aws/context.rs   프로필 파싱, SdkConfig 캐시, 자격 증명 확인
  src/adapters/mod.rs       ResourceAdapter trait, registry, find_adapter, effective_region
  src/adapters/util.rs      공통 헬퍼 (Capped, name_tag, dt, url_encode, map_concurrent ...)
  src/adapters/{ec2,vpc,s3,lambda,rds,ecs,eks,iam,route53,cloudfront,dynamodb,logs,sqs,sns,ecr,secretsmanager}.rs
  src/commands.rs           Tauri 커맨드 + AppState
docs/manual-test-checklist.md
```

---

### Task 1: 프로젝트 스캐폴드 (Tauri 2 + React + Vite + Vitest)

**Files:**
- Create: `package.json`, `index.html`, `vite.config.ts`, `tsconfig.json`, `app-icon.svg`
- Create: `src/main.tsx`, `src/App.tsx`, `src/styles.css`, `src/test/setup.ts`, `src/App.test.tsx`
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`
- Generate: `src-tauri/icons/*`

**Interfaces:**
- Produces: `npm test`, `npm run build`, `npm run tauri dev`, `cargo test` 가 동작하는 빈 앱. Rust 라이브러리 크레이트 이름 `magic_mirror_lib`, 진입 함수 `magic_mirror_lib::run()`.

- [ ] **Step 1: package.json 작성**

```json
{
  "name": "magic-mirror",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "tauri": "tauri"
  }
}
```

- [ ] **Step 2: 의존성 설치**

```bash
npm install react@18 react-dom@18 @tanstack/react-query@5 @tauri-apps/api@2 @tauri-apps/plugin-opener@2 @tauri-apps/plugin-clipboard-manager@2
npm install -D typescript@5 vite@5 @vitejs/plugin-react@4 vitest@2 jsdom@25 @testing-library/react@16 @testing-library/dom@10 @testing-library/jest-dom@6 @testing-library/user-event@14 @types/react@18 @types/react-dom@18 @tauri-apps/cli@2
```

Expected: `added N packages`, 오류 없음.

- [ ] **Step 3: 프론트엔드 설정 파일 작성**

`index.html`:
```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Magic Mirror</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`vite.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2021",
    "lib": ["ES2021", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`src/test/setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

`src/styles.css`:
```css
body { margin: 0; }
```

`src/App.tsx`:
```tsx
export default function App() {
  return <div className="app">Magic Mirror</div>;
}
```

`src/main.tsx`:
```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 4: 스모크 테스트 작성 후 실행**

`src/App.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders app title", () => {
  render(<App />);
  expect(screen.getByText("Magic Mirror")).toBeInTheDocument();
});
```

Run: `npm test`
Expected: `1 passed`

- [ ] **Step 5: Tauri 백엔드 파일 작성**

`src-tauri/Cargo.toml`:
```toml
[package]
name = "magic-mirror"
version = "0.1.0"
edition = "2021"

[lib]
name = "magic_mirror_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-clipboard-manager = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

`src-tauri/build.rs`:
```rust
fn main() {
    tauri_build::build()
}
```

`src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    magic_mirror_lib::run()
}
```

`src-tauri/src/lib.rs`:
```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

`src-tauri/tauri.conf.json`:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Magic Mirror",
  "version": "0.1.0",
  "identifier": "dev.finallee.magicmirror",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "Magic Mirror",
        "width": 1280,
        "height": 800,
        "minWidth": 900,
        "minHeight": 560
      }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.png"
    ]
  }
}
```

`src-tauri/capabilities/default.json`:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "main window permissions",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "clipboard-manager:allow-write-text"
  ]
}
```

- [ ] **Step 6: 아이콘 생성**

`app-icon.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="220" fill="#1e1e20"/>
  <ellipse cx="512" cy="480" rx="250" ry="320" fill="none" stroke="#0a84ff" stroke-width="56"/>
  <path d="M420 330 Q470 300 520 330" stroke="#e6e6e8" stroke-width="36" fill="none" stroke-linecap="round"/>
  <rect x="472" y="800" width="80" height="120" rx="20" fill="#0a84ff"/>
</svg>
```

Run: `npx tauri icon app-icon.svg`
Expected: `src-tauri/icons/`에 `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.png` 등이 생성됨.

- [ ] **Step 7: 빌드 확인**

Run: `npm run build && (cd src-tauri && cargo test)`
Expected: Vite 빌드 성공, `cargo test`는 컴파일 성공 후 `test result: ok. 0 passed`.

Run: `npm run tauri dev` → "Magic Mirror" 텍스트가 있는 창이 뜨는지 확인 후 종료(Ctrl+C).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json index.html vite.config.ts tsconfig.json app-icon.svg src src-tauri
git commit -m "chore: scaffold Tauri 2 + React + Vite app"
```

---

### Task 2: 공통 모델과 오류 분류

**Files:**
- Create: `src-tauri/src/model.rs`, `src-tauri/src/error.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`

**Interfaces:**
- Produces (Rust, `crate::model`):
  - `pub const MAX_ITEMS: usize = 1000;`
  - `pub enum ColumnKind { Text, Mono, State, Datetime, Bytes }` (serde: `"text" | "mono" | "state" | "datetime" | "bytes"`)
  - `pub struct Column { key: &'static str, label: &'static str, kind: ColumnKind }`, `pub const fn col(key, label, kind) -> Column`
  - `pub struct ResourceType { id: &'static str, name: &'static str, columns: Vec<Column> }`
  - `pub struct ServiceInfo { id, name, global: bool, types: Vec<ResourceType> }`
  - `pub struct Field { label: String, value: String }`
  - `pub struct Resource { id, name, arn: Option<String>, values: BTreeMap<String,String>, tags: BTreeMap<String,String>, fields: Vec<Field>, raw: String, console_url: Option<String> }` + 빌더 메서드 `new, arn, value, field, tags, raw, console`
  - `pub struct ListResult { items: Vec<Resource>, truncated: bool }`
- Produces (Rust, `crate::error`):
  - `pub enum AppError { SsoExpired, AccessDenied { action }, Throttled, Network { message }, Other { message } }` (serde: `{"kind":"ssoExpired"}`, `{"kind":"accessDenied","action":"..."}` …)
  - `pub fn classify(code: Option<&str>, chain: &str, action: &str) -> AppError`
  - `pub fn from_sdk<E, R>(err: SdkError<E, R>, action: &str) -> AppError`

- [ ] **Step 1: 의존성 추가**

```bash
cd src-tauri && cargo add thiserror@2 aws-smithy-types@1 aws-smithy-runtime-api@1 --features aws-smithy-runtime-api/client
```

Expected: `Cargo.toml`에 세 크레이트가 추가됨.

- [ ] **Step 2: 실패하는 테스트와 함께 error.rs 작성**

`src-tauri/src/error.rs`:
```rust
use aws_smithy_runtime_api::client::result::SdkError;
use aws_smithy_types::error::display::DisplayErrorContext;
use aws_smithy_types::error::metadata::ProvideErrorMetadata;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppError {
    #[error("SSO 세션이 만료됐어요")]
    SsoExpired,
    #[error("권한 없음 ({action})")]
    AccessDenied { action: String },
    #[error("요청이 너무 많아요")]
    Throttled,
    #[error("네트워크 오류: {message}")]
    Network { message: String },
    #[error("{message}")]
    Other { message: String },
}

impl AppError {
    pub fn other(message: impl Into<String>) -> Self {
        AppError::Other { message: message.into() }
    }
}

/// AWS 오류 코드와 오류 체인 문자열로 사용자에게 보여줄 오류 종류를 정한다.
pub fn classify(code: Option<&str>, chain: &str, action: &str) -> AppError {
    todo!()
}

pub fn from_sdk<E, R>(err: SdkError<E, R>, action: &str) -> AppError
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
    R: std::fmt::Debug + Send + Sync + 'static,
{
    let code = err.code().map(str::to_owned);
    let chain = format!("{}", DisplayErrorContext(&err));
    classify(code.as_deref(), &chain, action)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_denied_codes() {
        for code in ["AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "AuthorizationError"] {
            assert_eq!(
                classify(Some(code), "", "ec2:DescribeInstances"),
                AppError::AccessDenied { action: "ec2:DescribeInstances".into() },
                "code {code}"
            );
        }
    }

    #[test]
    fn throttling_codes() {
        for code in ["Throttling", "ThrottlingException", "RequestLimitExceeded", "TooManyRequestsException", "SlowDown"] {
            assert_eq!(classify(Some(code), "", "x"), AppError::Throttled, "code {code}");
        }
    }

    #[test]
    fn expired_credentials() {
        assert_eq!(classify(Some("ExpiredToken"), "", "x"), AppError::SsoExpired);
        assert_eq!(classify(Some("ExpiredTokenException"), "", "x"), AppError::SsoExpired);
        assert_eq!(
            classify(None, "failed to load credentials: the SSO session token has expired", "x"),
            AppError::SsoExpired
        );
    }

    #[test]
    fn network_errors() {
        let e = classify(None, "dispatch failure: io error: connection refused", "x");
        assert!(matches!(e, AppError::Network { .. }), "{e:?}");
    }

    #[test]
    fn other_errors_keep_message() {
        assert_eq!(
            classify(Some("ValidationException"), "ValidationException: bad input", "x"),
            AppError::Other { message: "ValidationException: bad input".into() }
        );
    }

    #[test]
    fn serializes_with_kind_tag() {
        let v = serde_json::to_value(AppError::AccessDenied { action: "iam:ListUsers".into() }).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "accessDenied", "action": "iam:ListUsers" }));
        let v = serde_json::to_value(AppError::SsoExpired).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "ssoExpired" }));
    }
}
```

`src-tauri/src/lib.rs` 맨 위에 추가:
```rust
mod error;
mod model;
```

- [ ] **Step 3: model.rs 작성 (테스트 포함)**

`src-tauri/src/model.rs`:
```rust
use serde::Serialize;
use std::collections::BTreeMap;

pub const MAX_ITEMS: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnKind {
    Text,
    Mono,
    State,
    Datetime,
    Bytes,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Column {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: ColumnKind,
}

pub const fn col(key: &'static str, label: &'static str, kind: ColumnKind) -> Column {
    Column { key, label, kind }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResourceType {
    pub id: &'static str,
    pub name: &'static str,
    pub columns: Vec<Column>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ServiceInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub global: bool,
    pub types: Vec<ResourceType>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Field {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub id: String,
    pub name: String,
    pub arn: Option<String>,
    pub values: BTreeMap<String, String>,
    pub tags: BTreeMap<String, String>,
    pub fields: Vec<Field>,
    pub raw: String,
    pub console_url: Option<String>,
}

impl Resource {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self { id: id.into(), name: name.into(), ..Default::default() }
    }

    pub fn arn(mut self, arn: Option<impl Into<String>>) -> Self {
        self.arn = arn.map(Into::into);
        self
    }

    /// 표 칼럼 값 (`Column::key`와 같은 키를 쓴다)
    pub fn value(mut self, key: &str, v: impl ToString) -> Self {
        self.values.insert(key.to_string(), v.to_string());
        self
    }

    /// 상세 패널 전용 추가 정보. 빈 값은 넣지 않는다.
    pub fn field(mut self, label: &str, v: impl ToString) -> Self {
        let value = v.to_string();
        if !value.is_empty() {
            self.fields.push(Field { label: label.to_string(), value });
        }
        self
    }

    pub fn tags<'a>(mut self, pairs: impl IntoIterator<Item = (Option<&'a str>, Option<&'a str>)>) -> Self {
        for (k, v) in pairs {
            if let Some(k) = k {
                self.tags.insert(k.to_string(), v.unwrap_or_default().to_string());
            }
        }
        self
    }

    pub fn raw(mut self, d: &impl std::fmt::Debug) -> Self {
        self.raw = format!("{d:#?}");
        self
    }

    pub fn console(mut self, url: impl Into<String>) -> Self {
        self.console_url = Some(url.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ListResult {
    pub items: Vec<Resource>,
    pub truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_skips_empty_fields_and_collects_tags() {
        let r = Resource::new("i-1", "web")
            .value("state", "running")
            .field("Empty", "")
            .field("AMI", "ami-1")
            .tags([(Some("env"), Some("prod")), (None, Some("ignored")), (Some("k"), None)]);
        assert_eq!(r.values["state"], "running");
        assert_eq!(r.fields, vec![Field { label: "AMI".into(), value: "ami-1".into() }]);
        assert_eq!(r.tags["env"], "prod");
        assert_eq!(r.tags["k"], "");
        assert_eq!(r.tags.len(), 2);
    }

    #[test]
    fn serializes_camel_case() {
        let r = Resource::new("a", "b").console("https://x");
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["consoleUrl"], "https://x");
        let c = serde_json::to_value(col("id", "ID", ColumnKind::Mono)).unwrap();
        assert_eq!(c, serde_json::json!({ "key": "id", "label": "ID", "kind": "mono" }));
    }
}
```

- [ ] **Step 4: 테스트 실행해 classify 테스트 실패 확인**

Run: `cd src-tauri && cargo test error::`
Expected: FAIL — `not yet implemented` 패닉.

- [ ] **Step 5: classify 구현**

`error.rs`의 `classify` 본문을 교체:
```rust
pub fn classify(code: Option<&str>, chain: &str, action: &str) -> AppError {
    if let Some(c) = code {
        if c.contains("AccessDenied") || c == "UnauthorizedOperation" || c == "AuthorizationError" {
            return AppError::AccessDenied { action: action.to_string() };
        }
        if c.contains("Throttl") || c == "RequestLimitExceeded" || c == "TooManyRequestsException" || c == "SlowDown" {
            return AppError::Throttled;
        }
        if c == "ExpiredToken" || c == "ExpiredTokenException" {
            return AppError::SsoExpired;
        }
    }
    let lower = chain.to_lowercase();
    if lower.contains("sso") && (lower.contains("token") || lower.contains("expired") || lower.contains("unauthorized")) {
        return AppError::SsoExpired;
    }
    if lower.contains("dispatch failure") || lower.contains("timeout") || lower.contains("timed out") || lower.contains("connection") || lower.contains("dns") {
        return AppError::Network { message: chain.to_string() };
    }
    AppError::Other { message: chain.to_string() }
}
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `cd src-tauri && cargo test`
Expected: `error::tests` 6개, `model::tests` 2개 PASS. (`from_sdk` 미사용 경고는 무시)

- [ ] **Step 7: Commit**

```bash
git add src-tauri
git commit -m "feat(backend): add resource model and AWS error classification"
```

---

### Task 3: 설정 저장/불러오기

**Files:**
- Create: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: `crate::error::AppError`
- Produces (`crate::settings`):
  - `pub struct Favorite { service: String, type_id: String }` (JSON: `{"service":"ec2","type":"instances"}`)
  - `pub struct Settings { enabled_services: Vec<String>, favorites: Vec<Favorite>, last_profile: Option<String>, last_region: Option<String> }` (JSON camelCase)
  - `pub fn load(path: &Path, all_services: &[&str]) -> Settings`
  - `pub fn save(path: &Path, settings: &Settings) -> Result<(), AppError>`

- [ ] **Step 1: 테스트용 의존성 추가**

```bash
cd src-tauri && cargo add --dev tempfile@3
```

- [ ] **Step 2: 실패하는 테스트와 함께 settings.rs 작성**

`src-tauri/src/settings.rs`:
```rust
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Favorite {
    pub service: String,
    #[serde(rename = "type")]
    pub type_id: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled_services: Vec<String>,
    pub favorites: Vec<Favorite>,
    pub last_profile: Option<String>,
    pub last_region: Option<String>,
}

fn defaults(all_services: &[&str]) -> Settings {
    Settings {
        enabled_services: all_services.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    }
}

/// 파일이 없거나 깨져 있으면 기본값(모든 서비스 활성화)을 돌려준다.
pub fn load(path: &Path, all_services: &[&str]) -> Settings {
    todo!()
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), AppError> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_returns_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let s = load(&dir.path().join("settings.json"), &["ec2", "s3"]);
        assert_eq!(s.enabled_services, vec!["ec2", "s3"]);
        assert!(s.favorites.is_empty());
        assert_eq!(s.last_profile, None);
    }

    #[test]
    fn corrupt_file_returns_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{not json").unwrap();
        assert_eq!(load(&path, &["ec2"]).enabled_services, vec!["ec2"]);
    }

    #[test]
    fn save_then_load_roundtrip_creates_parent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        let s = Settings {
            enabled_services: vec!["iam".into()],
            favorites: vec![Favorite { service: "ec2".into(), type_id: "instances".into() }],
            last_profile: Some("prod".into()),
            last_region: Some("ap-northeast-2".into()),
        };
        save(&path, &s).unwrap();
        assert_eq!(load(&path, &["ec2", "iam"]), s);
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["favorites"][0]["type"], "instances");
        assert_eq!(json["lastProfile"], "prod");
    }
}
```

`lib.rs`에 `mod settings;` 추가.

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd src-tauri && cargo test settings::`
Expected: FAIL — `not yet implemented`.

- [ ] **Step 4: 구현**

```rust
pub fn load(path: &Path, all_services: &[&str]) -> Settings {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| defaults(all_services)),
        Err(_) => defaults(all_services),
    }
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::other(format!("설정 폴더를 만들 수 없어요: {e}")))?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| AppError::other(e.to_string()))?;
    fs::write(path, text).map_err(|e| AppError::other(format!("설정을 저장할 수 없어요: {e}")))
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd src-tauri && cargo test settings::`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add src-tauri
git commit -m "feat(backend): persist settings to JSON"
```

---

### Task 4: AWS 컨텍스트 (프로필 파싱, SdkConfig 캐시, 자격 증명 확인)

**Files:**
- Create: `src-tauri/src/aws/mod.rs`, `src-tauri/src/aws/context.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: `crate::error::{AppError, from_sdk}`
- Produces (`crate::aws::context`):
  - `pub struct ProfileInfo { name: String, region: Option<String> }` (Serialize)
  - `pub fn parse_profiles(text: &str) -> Vec<ProfileInfo>`
  - `pub fn list_profiles() -> Vec<ProfileInfo>`
  - `pub const GLOBAL_REGION: &str = "us-east-1";`
  - `pub fn credentials_error(chain: &str) -> AppError`
  - `#[derive(Default)] pub struct AwsContext` with `pub async fn config(&self, profile: &str, region: &str) -> Result<SdkConfig, AppError>`, `pub async fn forget_profile(&self, profile: &str)`, `pub async fn account_id(&self, profile: &str) -> Result<String, AppError>`

- [ ] **Step 1: 의존성 추가**

```bash
cd src-tauri && cargo add aws-config@1 --features behavior-version-latest && cargo add aws-credential-types@1 aws-sdk-sts@1 && cargo add tokio@1 --features sync,process,macros,rt-multi-thread
```

- [ ] **Step 2: 실패하는 테스트와 함께 context.rs 작성**

`src-tauri/src/aws/mod.rs`:
```rust
pub mod context;
```

`src-tauri/src/aws/context.rs`:
```rust
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use aws_config::{BehaviorVersion, Region, SdkConfig};
use aws_credential_types::provider::ProvideCredentials;
use aws_smithy_types::error::display::DisplayErrorContext;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::error::{from_sdk, AppError};

pub const GLOBAL_REGION: &str = "us-east-1";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProfileInfo {
    pub name: String,
    pub region: Option<String>,
}

/// `~/.aws/config` 형식에서 `[default]`, `[profile X]` 섹션만 프로필로 읽는다.
pub fn parse_profiles(text: &str) -> Vec<ProfileInfo> {
    todo!()
}

fn config_file_path() -> Option<PathBuf> {
    std::env::var_os("AWS_CONFIG_FILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".aws").join("config")))
}

pub fn list_profiles() -> Vec<ProfileInfo> {
    config_file_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|t| parse_profiles(&t))
        .unwrap_or_default()
}

pub fn credentials_error(chain: &str) -> AppError {
    let lower = chain.to_lowercase();
    if lower.contains("sso") || lower.contains("token") {
        AppError::SsoExpired
    } else {
        AppError::other(chain)
    }
}

#[derive(Default)]
pub struct AwsContext {
    cache: Mutex<HashMap<(String, String), SdkConfig>>,
}

impl AwsContext {
    /// (profile, region) 조합의 SdkConfig를 만들고 자격 증명을 한 번 확인한 뒤 캐시한다.
    pub async fn config(&self, profile: &str, region: &str) -> Result<SdkConfig, AppError> {
        let key = (profile.to_string(), region.to_string());
        if let Some(cfg) = self.cache.lock().await.get(&key) {
            return Ok(cfg.clone());
        }
        let cfg = aws_config::defaults(BehaviorVersion::latest())
            .profile_name(profile)
            .region(Region::new(region.to_string()))
            .load()
            .await;
        let provider = cfg
            .credentials_provider()
            .ok_or_else(|| AppError::other("자격 증명 공급자를 찾을 수 없어요"))?;
        provider
            .provide_credentials()
            .await
            .map_err(|e| credentials_error(&format!("{}", DisplayErrorContext(&e))))?;
        self.cache.lock().await.insert(key, cfg.clone());
        Ok(cfg)
    }

    /// SSO 재로그인 후 새 토큰을 읽도록 해당 프로필의 캐시를 비운다.
    pub async fn forget_profile(&self, profile: &str) {
        self.cache.lock().await.retain(|(p, _), _| p != profile);
    }

    pub async fn account_id(&self, profile: &str) -> Result<String, AppError> {
        let cfg = self.config(profile, GLOBAL_REGION).await?;
        let out = aws_sdk_sts::Client::new(&cfg)
            .get_caller_identity()
            .send()
            .await
            .map_err(|e| from_sdk(e, "sts:GetCallerIdentity"))?;
        Ok(out.account().unwrap_or_default().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
[default]
region = us-west-2

[profile prod-sso]
sso_session = my-sso
sso_account_id = 123456789012
region=ap-northeast-2

[sso-session my-sso]
sso_region = us-east-1
region = eu-west-1

[profile localstack]
endpoint_url = http://localhost:4566

[services dev]
region = eu-central-1
"#;

    #[test]
    fn parses_profiles_and_regions() {
        assert_eq!(
            parse_profiles(SAMPLE),
            vec![
                ProfileInfo { name: "default".into(), region: Some("us-west-2".into()) },
                ProfileInfo { name: "prod-sso".into(), region: Some("ap-northeast-2".into()) },
                ProfileInfo { name: "localstack".into(), region: None },
            ]
        );
    }

    #[test]
    fn empty_config_has_no_profiles() {
        assert!(parse_profiles("").is_empty());
    }

    #[test]
    fn credential_errors_mentioning_sso_are_expired() {
        assert_eq!(credentials_error("the SSO session has expired or is invalid"), AppError::SsoExpired);
        assert_eq!(credentials_error("no providers in chain"), AppError::other("no providers in chain"));
    }
}
```

`lib.rs`에 `mod aws;` 추가.

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd src-tauri && cargo test aws::`
Expected: `parses_profiles_and_regions`, `empty_config_has_no_profiles` FAIL (`not yet implemented`).

- [ ] **Step 4: parse_profiles 구현**

```rust
pub fn parse_profiles(text: &str) -> Vec<ProfileInfo> {
    let mut out: Vec<ProfileInfo> = Vec::new();
    let mut in_profile = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            let header = line[1..line.len() - 1].trim();
            let name = if header == "default" {
                Some("default")
            } else {
                header.strip_prefix("profile ").map(str::trim)
            };
            in_profile = name.is_some();
            if let Some(name) = name {
                out.push(ProfileInfo { name: name.to_string(), region: None });
            }
        } else if in_profile {
            if let Some((k, v)) = line.split_once('=') {
                if k.trim() == "region" {
                    if let Some(last) = out.last_mut() {
                        last.region = Some(v.trim().to_string());
                    }
                }
            }
        }
    }
    out
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd src-tauri && cargo test aws::`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add src-tauri
git commit -m "feat(backend): parse AWS profiles and cache SDK configs"
```

---

### Task 5: 어댑터 trait, 공통 헬퍼, Tauri 커맨드

**Files:**
- Create: `src-tauri/src/adapters/mod.rs`, `src-tauri/src/adapters/util.rs`, `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: `crate::model::*`, `crate::error::*`, `crate::settings::{load, save, Settings}`, `crate::aws::context::{AwsContext, ProfileInfo, list_profiles, GLOBAL_REGION}`
- Produces (`crate::adapters`):
  ```rust
  #[async_trait]
  pub trait ResourceAdapter: Send + Sync {
      fn service_id(&self) -> &'static str;
      fn display_name(&self) -> &'static str;
      fn is_global(&self) -> bool { false }
      fn resource_types(&self) -> Vec<ResourceType>;
      async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError>;
  }
  pub type AdapterRef = Arc<dyn ResourceAdapter>;
  pub fn registry() -> Vec<AdapterRef>;
  pub fn service_info(a: &dyn ResourceAdapter) -> ServiceInfo;
  pub fn find_adapter(adapters: &[AdapterRef], id: &str) -> Result<AdapterRef, AppError>;
  pub fn effective_region<'a>(a: &dyn ResourceAdapter, region: &'a str) -> &'a str;
  ```
- Produces (`crate::adapters::util`): `s, dt, dt_millis, opt, region, last_segment, name_tag, hash_tags, url_encode, unknown_type, Capped<T> { new, push, finish }, map_concurrent`
- Produces (Tauri commands, JS 이름): `list_profiles() -> ProfileInfo[]`, `get_account({profile}) -> string`, `list_services() -> ServiceInfo[]`, `list_resources({profile, region, service, typeId}) -> ListResult`, `sso_login({profile})`, `get_settings() -> Settings`, `save_settings({settings})`
- Produces: `pub struct AppState { pub ctx: AwsContext, pub adapters: Vec<AdapterRef>, pub settings_path: PathBuf }`

- [ ] **Step 1: 의존성 추가**

```bash
cd src-tauri && cargo add async-trait@0.1 futures@0.3
```

- [ ] **Step 2: util.rs 작성 (테스트 먼저, 구현은 todo)**

`src-tauri/src/adapters/util.rs`:
```rust
use std::collections::HashMap;
use std::future::Future;

use aws_config::SdkConfig;
use aws_smithy_types::{date_time::Format, DateTime};
use futures::stream::{self, StreamExt};

use crate::error::AppError;
use crate::model::{ListResult, Resource, MAX_ITEMS};

/// Option<&str> → String (없으면 빈 문자열)
pub fn s(o: Option<&str>) -> String {
    o.unwrap_or_default().to_string()
}

/// AWS DateTime → ISO 8601 문자열
pub fn dt(o: Option<&DateTime>) -> String {
    o.and_then(|d| d.fmt(Format::DateTime).ok()).unwrap_or_default()
}

/// epoch 밀리초 → ISO 8601 문자열
pub fn dt_millis(ms: Option<i64>) -> String {
    ms.map(DateTime::from_millis).and_then(|d| d.fmt(Format::DateTime).ok()).unwrap_or_default()
}

pub fn opt<T: ToString>(o: Option<T>) -> String {
    o.map(|v| v.to_string()).unwrap_or_default()
}

pub fn region(cfg: &SdkConfig) -> String {
    cfg.region().map(|r| r.to_string()).unwrap_or_default()
}

pub fn last_segment(value: &str, sep: char) -> String {
    todo!()
}

/// `Name` 태그 값 (비어 있으면 None)
pub fn name_tag<'a>(tags: impl IntoIterator<Item = (Option<&'a str>, Option<&'a str>)>) -> Option<String> {
    todo!()
}

/// HashMap 형태 태그(EKS 등)를 Resource::tags 입력으로 바꾼다.
pub fn hash_tags(m: Option<&HashMap<String, String>>) -> Vec<(Option<&str>, Option<&str>)> {
    m.into_iter().flatten().map(|(k, v)| (Some(k.as_str()), Some(v.as_str()))).collect()
}

/// 콘솔 URL용 퍼센트 인코딩 (영숫자와 -_.~ 외 모두 인코딩)
pub fn url_encode(value: &str) -> String {
    todo!()
}

pub fn unknown_type(type_id: &str) -> AppError {
    AppError::other(format!("알 수 없는 리소스 타입: {type_id}"))
}

/// MAX_ITEMS까지만 모으는 컬렉션. push가 false를 돌려주면 순회를 멈춘다.
pub struct Capped<T> {
    pub items: Vec<T>,
    pub truncated: bool,
}

impl<T> Capped<T> {
    pub fn new() -> Self {
        Self { items: Vec::new(), truncated: false }
    }

    pub fn push(&mut self, item: T) -> bool {
        todo!()
    }
}

impl<T> Default for Capped<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl Capped<Resource> {
    pub fn finish(self) -> ListResult {
        ListResult { items: self.items, truncated: self.truncated }
    }
}

/// 최대 8개씩 동시에 실행하고 입력 순서대로 결과를 돌려준다.
pub async fn map_concurrent<T, R, F, Fut>(items: Vec<T>, f: F) -> Vec<R>
where
    F: FnMut(T) -> Fut,
    Fut: Future<Output = R>,
{
    stream::iter(items).map(f).buffered(8).collect().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_segment_splits() {
        assert_eq!(last_segment("arn:aws:ecs:r:1:cluster/prod", '/'), "prod");
        assert_eq!(last_segment("arn:aws:sns:r:1:alerts", ':'), "alerts");
        assert_eq!(last_segment("plain", '/'), "plain");
    }

    #[test]
    fn name_tag_finds_non_empty_name() {
        assert_eq!(name_tag([(Some("env"), Some("prod")), (Some("Name"), Some("web"))]), Some("web".into()));
        assert_eq!(name_tag([(Some("Name"), Some(""))]), None);
        assert_eq!(name_tag(Vec::<(Option<&str>, Option<&str>)>::new()), None);
    }

    #[test]
    fn url_encode_escapes_reserved() {
        assert_eq!(url_encode("arn:aws:iam::1:policy/a b"), "arn%3Aaws%3Aiam%3A%3A1%3Apolicy%2Fa%20b");
        assert_eq!(url_encode("abc-_.~"), "abc-_.~");
    }

    #[test]
    fn capped_stops_at_max() {
        let mut c = Capped::new();
        for i in 0..MAX_ITEMS {
            assert!(c.push(i));
        }
        assert!(!c.truncated);
        assert!(!c.push(MAX_ITEMS));
        assert!(c.truncated);
        assert_eq!(c.items.len(), MAX_ITEMS);
    }

    #[test]
    fn dt_millis_formats_iso() {
        assert_eq!(dt_millis(Some(0)), "1970-01-01T00:00:00Z");
        assert_eq!(dt_millis(None), "");
    }

    #[tokio::test]
    async fn map_concurrent_keeps_order() {
        let out = map_concurrent(vec![3, 1, 2], |n| async move { n * 10 }).await;
        assert_eq!(out, vec![30, 10, 20]);
    }
}
```

- [ ] **Step 3: adapters/mod.rs 작성**

`src-tauri/src/adapters/mod.rs`:
```rust
pub mod util;

use std::sync::Arc;

use async_trait::async_trait;
use aws_config::SdkConfig;

use crate::aws::context::GLOBAL_REGION;
use crate::error::AppError;
use crate::model::{ListResult, ResourceType, ServiceInfo};

#[async_trait]
pub trait ResourceAdapter: Send + Sync {
    fn service_id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    /// 리전과 무관한 서비스(IAM 등)는 true — us-east-1 클라이언트로 호출한다.
    fn is_global(&self) -> bool {
        false
    }
    fn resource_types(&self) -> Vec<ResourceType>;
    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError>;
}

pub type AdapterRef = Arc<dyn ResourceAdapter>;

/// 서비스 표시 순서대로 모든 어댑터를 돌려준다.
pub fn registry() -> Vec<AdapterRef> {
    vec![]
}

pub fn service_info(a: &dyn ResourceAdapter) -> ServiceInfo {
    ServiceInfo { id: a.service_id(), name: a.display_name(), global: a.is_global(), types: a.resource_types() }
}

pub fn find_adapter(adapters: &[AdapterRef], id: &str) -> Result<AdapterRef, AppError> {
    adapters
        .iter()
        .find(|a| a.service_id() == id)
        .cloned()
        .ok_or_else(|| AppError::other(format!("알 수 없는 서비스: {id}")))
}

pub fn effective_region<'a>(a: &dyn ResourceAdapter, region: &'a str) -> &'a str {
    if a.is_global() {
        GLOBAL_REGION
    } else {
        region
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake {
        global: bool,
    }

    #[async_trait]
    impl ResourceAdapter for Fake {
        fn service_id(&self) -> &'static str {
            "fake"
        }
        fn display_name(&self) -> &'static str {
            "Fake"
        }
        fn is_global(&self) -> bool {
            self.global
        }
        fn resource_types(&self) -> Vec<ResourceType> {
            vec![]
        }
        async fn list(&self, _cfg: &SdkConfig, _type_id: &str) -> Result<ListResult, AppError> {
            Ok(ListResult { items: vec![], truncated: false })
        }
    }

    #[test]
    fn find_adapter_by_id() {
        let adapters: Vec<AdapterRef> = vec![Arc::new(Fake { global: false })];
        assert_eq!(find_adapter(&adapters, "fake").unwrap().display_name(), "Fake");
        assert!(matches!(find_adapter(&adapters, "nope"), Err(AppError::Other { .. })));
    }

    #[test]
    fn global_services_use_us_east_1() {
        assert_eq!(effective_region(&Fake { global: true }, "ap-northeast-2"), "us-east-1");
        assert_eq!(effective_region(&Fake { global: false }, "ap-northeast-2"), "ap-northeast-2");
    }

    #[test]
    fn registry_ids_are_unique() {
        let ids: Vec<_> = registry().iter().map(|a| a.service_id()).collect();
        let mut dedup = ids.clone();
        dedup.sort();
        dedup.dedup();
        assert_eq!(ids.len(), dedup.len());
    }
}
```

`lib.rs`에 `mod adapters;` 추가.

- [ ] **Step 4: 테스트 실패 확인**

Run: `cd src-tauri && cargo test adapters::`
Expected: util 테스트들이 `not yet implemented`로 FAIL, mod 테스트 3개 PASS.

- [ ] **Step 5: util 구현**

```rust
pub fn last_segment(value: &str, sep: char) -> String {
    value.rsplit(sep).next().unwrap_or(value).to_string()
}

pub fn name_tag<'a>(tags: impl IntoIterator<Item = (Option<&'a str>, Option<&'a str>)>) -> Option<String> {
    tags.into_iter()
        .find(|(k, _)| *k == Some("Name"))
        .and_then(|(_, v)| v)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

pub fn url_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}
```

`Capped::push`:
```rust
    pub fn push(&mut self, item: T) -> bool {
        if self.items.len() >= MAX_ITEMS {
            self.truncated = true;
            return false;
        }
        self.items.push(item);
        true
    }
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `cd src-tauri && cargo test adapters::`
Expected: 9 passed.

- [ ] **Step 7: commands.rs 작성**

`src-tauri/src/commands.rs`:
```rust
use std::io::ErrorKind;
use std::path::PathBuf;

use tauri::State;
use tokio::process::Command;

use crate::adapters::{effective_region, find_adapter, service_info, AdapterRef};
use crate::aws::context::{self, AwsContext, ProfileInfo};
use crate::error::AppError;
use crate::model::{ListResult, ServiceInfo};
use crate::settings::{self, Settings};

pub struct AppState {
    pub ctx: AwsContext,
    pub adapters: Vec<AdapterRef>,
    pub settings_path: PathBuf,
}

impl AppState {
    fn service_ids(&self) -> Vec<&'static str> {
        self.adapters.iter().map(|a| a.service_id()).collect()
    }
}

/// Finder에서 실행하면 PATH가 짧으므로 Homebrew 경로도 시도한다.
const AWS_CLI_CANDIDATES: [&str; 3] = ["aws", "/opt/homebrew/bin/aws", "/usr/local/bin/aws"];

#[tauri::command]
pub fn list_profiles() -> Vec<ProfileInfo> {
    context::list_profiles()
}

#[tauri::command]
pub async fn get_account(state: State<'_, AppState>, profile: String) -> Result<String, AppError> {
    state.ctx.account_id(&profile).await
}

#[tauri::command]
pub fn list_services(state: State<'_, AppState>) -> Vec<ServiceInfo> {
    state.adapters.iter().map(|a| service_info(a.as_ref())).collect()
}

#[tauri::command]
pub async fn list_resources(
    state: State<'_, AppState>,
    profile: String,
    region: String,
    service: String,
    type_id: String,
) -> Result<ListResult, AppError> {
    let adapter = find_adapter(&state.adapters, &service)?;
    let cfg = state.ctx.config(&profile, effective_region(adapter.as_ref(), &region)).await?;
    adapter.list(&cfg, &type_id).await
}

#[tauri::command]
pub async fn sso_login(state: State<'_, AppState>, profile: String) -> Result<(), AppError> {
    for bin in AWS_CLI_CANDIDATES {
        match Command::new(bin).args(["sso", "login", "--profile", &profile]).status().await {
            Ok(status) if status.success() => {
                state.ctx.forget_profile(&profile).await;
                return Ok(());
            }
            Ok(status) => return Err(AppError::other(format!("aws sso login이 실패했어요 ({status})"))),
            Err(e) if e.kind() == ErrorKind::NotFound => continue,
            Err(e) => return Err(AppError::other(e.to_string())),
        }
    }
    Err(AppError::other("aws CLI를 찾을 수 없어요"))
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    settings::load(&state.settings_path, &state.service_ids())
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), AppError> {
    settings::save(&state.settings_path, &settings)
}
```

- [ ] **Step 8: lib.rs 연결**

`src-tauri/src/lib.rs` 전체:
```rust
mod adapters;
mod aws;
mod commands;
mod error;
mod model;
mod settings;

use tauri::Manager;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(AppState {
                ctx: aws::context::AwsContext::default(),
                adapters: adapters::registry(),
                settings_path: dir.join("settings.json"),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::get_account,
            commands::list_services,
            commands::list_resources,
            commands::sso_login,
            commands::get_settings,
            commands::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 9: 전체 테스트와 빌드 확인**

Run: `cd src-tauri && cargo test && cargo build`
Expected: 모든 테스트 PASS, 빌드 성공(미사용 경고 허용).

- [ ] **Step 10: Commit**

```bash
git add src-tauri
git commit -m "feat(backend): add adapter trait, helpers, and Tauri commands"
```

---

## 어댑터 작업 공통 규칙 (Task 6–14)

- 각 어댑터 파일은 `pub struct <Name>;` 하나와 `ResourceAdapter` 구현, SDK 타입 → `Resource` 변환 **순수 함수**, `#[cfg(test)] mod tests`로 구성한다.
- 페이지네이션은 `into_paginator().send()`로 페이지 단위 순회하고, `Capped::push`가 `false`를 돌려주면 라벨 붙은 루프(`'pages`)를 `break`한다.
- 모든 SDK 오류는 `from_sdk(e, "<service>:<Action>")`으로 변환한다. 이 액션 문자열이 "권한 없음 (...)" 메시지에 그대로 표시된다.
- 새 어댑터를 만들면 `adapters/mod.rs`에 `pub mod <file>;`를 추가하고 `registry()` vec에 `Arc::new(<file>::<Name>)`을 추가한다(최종 순서는 Task 14에서 확정).
- 테스트는 SDK 타입의 `builder()`로 입력을 만들어 변환 함수만 검증한다. AWS를 호출하지 않는다.
- 각 Task 마지막에 `cargo test`와 `cargo build`가 모두 통과해야 한다.

---

### Task 6: EC2, VPC 어댑터

**Files:**
- Create: `src-tauri/src/adapters/ec2.rs`, `src-tauri/src/adapters/vpc.rs`
- Modify: `src-tauri/src/adapters/mod.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: `ResourceAdapter`, `util::*`, `model::*`, `from_sdk`
- Produces: `ec2::Ec2` (id `ec2`, types `instances`, `security-groups`, `volumes`), `vpc::Vpc` (id `vpc`, types `vpcs`, `subnets`), `pub(crate) fn ec2::tag_pairs(&[aws_sdk_ec2::types::Tag])`

- [ ] **Step 1: 의존성 추가**

```bash
cd src-tauri && cargo add aws-sdk-ec2@1
```

- [ ] **Step 2: ec2.rs 작성 — 변환 함수 테스트 먼저**

`src-tauri/src/adapters/ec2.rs`:
```rust
use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_ec2::types::{Instance, SecurityGroup, Tag, Volume};

use super::util::{dt, name_tag, opt, region, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Ec2;

pub(crate) fn tag_pairs(tags: &[Tag]) -> impl Iterator<Item = (Option<&str>, Option<&str>)> {
    tags.iter().map(|t| (t.key(), t.value()))
}

#[async_trait]
impl ResourceAdapter for Ec2 {
    fn service_id(&self) -> &'static str {
        "ec2"
    }
    fn display_name(&self) -> &'static str {
        "EC2"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![
            ResourceType {
                id: "instances",
                name: "Instances",
                columns: vec![
                    col("name", "Name", Text),
                    col("id", "Instance ID", Mono),
                    col("state", "State", State),
                    col("type", "Type", Text),
                    col("privateIp", "Private IP", Mono),
                    col("az", "AZ", Text),
                ],
            },
            ResourceType {
                id: "security-groups",
                name: "Security Groups",
                columns: vec![
                    col("name", "Name", Text),
                    col("id", "Group ID", Mono),
                    col("vpc", "VPC", Mono),
                    col("description", "Description", Text),
                ],
            },
            ResourceType {
                id: "volumes",
                name: "Volumes",
                columns: vec![
                    col("name", "Name", Text),
                    col("id", "Volume ID", Mono),
                    col("state", "State", State),
                    col("size", "Size (GiB)", Text),
                    col("type", "Type", Text),
                    col("attachedTo", "Attached To", Mono),
                ],
            },
        ]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        let client = aws_sdk_ec2::Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        match type_id {
            "instances" => {
                let mut pages = client.describe_instances().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "ec2:DescribeInstances"))?;
                    for rsv in page.reservations() {
                        let owner = s(rsv.owner_id());
                        for i in rsv.instances() {
                            if !out.push(instance(i, &owner, &region)) {
                                break 'pages;
                            }
                        }
                    }
                }
            }
            "security-groups" => {
                let mut pages = client.describe_security_groups().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "ec2:DescribeSecurityGroups"))?;
                    for g in page.security_groups() {
                        if !out.push(security_group(g, &region)) {
                            break 'pages;
                        }
                    }
                }
            }
            "volumes" => {
                let mut pages = client.describe_volumes().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "ec2:DescribeVolumes"))?;
                    for v in page.volumes() {
                        if !out.push(volume(v, &region)) {
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

fn instance(i: &Instance, owner: &str, region: &str) -> Resource {
    let id = s(i.instance_id());
    let name = name_tag(tag_pairs(i.tags())).unwrap_or_else(|| id.clone());
    let arn = (!owner.is_empty()).then(|| format!("arn:aws:ec2:{region}:{owner}:instance/{id}"));
    Resource::new(&id, &name)
        .arn(arn)
        .value("name", &name)
        .value("id", &id)
        .value("state", s(i.state().and_then(|st| st.name()).map(|n| n.as_str())))
        .value("type", s(i.instance_type().map(|t| t.as_str())))
        .value("privateIp", s(i.private_ip_address()))
        .value("az", s(i.placement().and_then(|p| p.availability_zone())))
        .field("Public IP", s(i.public_ip_address()))
        .field("VPC", s(i.vpc_id()))
        .field("Subnet", s(i.subnet_id()))
        .field("AMI", s(i.image_id()))
        .field("Key pair", s(i.key_name()))
        .field("Launched", dt(i.launch_time()))
        .field(
            "Security groups",
            i.security_groups().iter().filter_map(|g| g.group_id()).collect::<Vec<_>>().join(", "),
        )
        .tags(tag_pairs(i.tags()))
        .raw(i)
        .console(format!("https://{region}.console.aws.amazon.com/ec2/home?region={region}#InstanceDetails:instanceId={id}"))
}

fn security_group(g: &SecurityGroup, region: &str) -> Resource {
    let id = s(g.group_id());
    let name = name_tag(tag_pairs(g.tags())).unwrap_or_else(|| s(g.group_name()));
    let owner = s(g.owner_id());
    let arn = (!owner.is_empty()).then(|| format!("arn:aws:ec2:{region}:{owner}:security-group/{id}"));
    Resource::new(&id, &name)
        .arn(arn)
        .value("name", &name)
        .value("id", &id)
        .value("vpc", s(g.vpc_id()))
        .value("description", s(g.description()))
        .field("Group name", s(g.group_name()))
        .field("Inbound rules", g.ip_permissions().len())
        .field("Outbound rules", g.ip_permissions_egress().len())
        .tags(tag_pairs(g.tags()))
        .raw(g)
        .console(format!("https://{region}.console.aws.amazon.com/ec2/home?region={region}#SecurityGroup:groupId={id}"))
}

fn volume(v: &Volume, region: &str) -> Resource {
    let id = s(v.volume_id());
    let name = name_tag(tag_pairs(v.tags())).unwrap_or_else(|| id.clone());
    Resource::new(&id, &name)
        .value("name", &name)
        .value("id", &id)
        .value("state", s(v.state().map(|st| st.as_str())))
        .value("size", opt(v.size()))
        .value("type", s(v.volume_type().map(|t| t.as_str())))
        .value(
            "attachedTo",
            v.attachments().iter().filter_map(|a| a.instance_id()).collect::<Vec<_>>().join(", "),
        )
        .field("AZ", s(v.availability_zone()))
        .field("IOPS", opt(v.iops()))
        .field("Encrypted", opt(v.encrypted()))
        .field("Created", dt(v.create_time()))
        .tags(tag_pairs(v.tags()))
        .raw(v)
        .console(format!("https://{region}.console.aws.amazon.com/ec2/home?region={region}#VolumeDetails:volumeId={id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_ec2::types::{
        InstanceState, InstanceStateName, InstanceType, Placement, VolumeAttachment, VolumeState, VolumeType,
    };

    #[test]
    fn instance_uses_name_tag_and_builds_arn() {
        let i = Instance::builder()
            .instance_id("i-1")
            .instance_type(InstanceType::T3Micro)
            .state(InstanceState::builder().name(InstanceStateName::Running).build())
            .private_ip_address("10.0.0.1")
            .placement(Placement::builder().availability_zone("ap-northeast-2a").build())
            .tags(Tag::builder().key("Name").value("web-1").build())
            .tags(Tag::builder().key("env").value("prod").build())
            .build();
        let r = instance(&i, "123456789012", "ap-northeast-2");
        assert_eq!(r.id, "i-1");
        assert_eq!(r.name, "web-1");
        assert_eq!(r.values["state"], "running");
        assert_eq!(r.values["type"], "t3.micro");
        assert_eq!(r.values["az"], "ap-northeast-2a");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:ec2:ap-northeast-2:123456789012:instance/i-1"));
        assert_eq!(r.tags["env"], "prod");
        assert!(r.console_url.unwrap().contains("instanceId=i-1"));
    }

    #[test]
    fn instance_without_name_tag_falls_back_to_id() {
        let i = Instance::builder().instance_id("i-2").build();
        let r = instance(&i, "", "us-east-1");
        assert_eq!(r.name, "i-2");
        assert_eq!(r.arn, None);
        assert_eq!(r.values["state"], "");
    }

    #[test]
    fn security_group_falls_back_to_group_name() {
        let g = SecurityGroup::builder().group_id("sg-1").group_name("web").vpc_id("vpc-1").owner_id("1").build();
        let r = security_group(&g, "us-east-1");
        assert_eq!(r.name, "web");
        assert_eq!(r.values["vpc"], "vpc-1");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:ec2:us-east-1:1:security-group/sg-1"));
    }

    #[test]
    fn volume_lists_attachments() {
        let v = Volume::builder()
            .volume_id("vol-1")
            .state(VolumeState::InUse)
            .size(8)
            .volume_type(VolumeType::Gp3)
            .attachments(VolumeAttachment::builder().instance_id("i-1").build())
            .build();
        let r = volume(&v, "us-east-1");
        assert_eq!(r.values["state"], "in-use");
        assert_eq!(r.values["size"], "8");
        assert_eq!(r.values["type"], "gp3");
        assert_eq!(r.values["attachedTo"], "i-1");
    }
}
```

- [ ] **Step 3: vpc.rs 작성**

`src-tauri/src/adapters/vpc.rs`:
```rust
use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_ec2::types::{Subnet, Vpc as SdkVpc};

use super::ec2::tag_pairs;
use super::util::{name_tag, opt, region, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Vpc;

#[async_trait]
impl ResourceAdapter for Vpc {
    fn service_id(&self) -> &'static str {
        "vpc"
    }
    fn display_name(&self) -> &'static str {
        "VPC"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![
            ResourceType {
                id: "vpcs",
                name: "VPCs",
                columns: vec![
                    col("name", "Name", Text),
                    col("id", "VPC ID", Mono),
                    col("cidr", "CIDR", Mono),
                    col("default", "Default", Text),
                    col("state", "State", State),
                ],
            },
            ResourceType {
                id: "subnets",
                name: "Subnets",
                columns: vec![
                    col("name", "Name", Text),
                    col("id", "Subnet ID", Mono),
                    col("vpc", "VPC", Mono),
                    col("cidr", "CIDR", Mono),
                    col("az", "AZ", Text),
                ],
            },
        ]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        let client = aws_sdk_ec2::Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        match type_id {
            "vpcs" => {
                let mut pages = client.describe_vpcs().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "ec2:DescribeVpcs"))?;
                    for v in page.vpcs() {
                        if !out.push(vpc(v, &region)) {
                            break 'pages;
                        }
                    }
                }
            }
            "subnets" => {
                let mut pages = client.describe_subnets().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "ec2:DescribeSubnets"))?;
                    for sn in page.subnets() {
                        if !out.push(subnet(sn, &region)) {
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

fn yes_no(b: Option<bool>) -> &'static str {
    if b == Some(true) {
        "Yes"
    } else {
        "No"
    }
}

fn vpc(v: &SdkVpc, region: &str) -> Resource {
    let id = s(v.vpc_id());
    let name = name_tag(tag_pairs(v.tags())).unwrap_or_else(|| id.clone());
    let owner = s(v.owner_id());
    let arn = (!owner.is_empty()).then(|| format!("arn:aws:ec2:{region}:{owner}:vpc/{id}"));
    Resource::new(&id, &name)
        .arn(arn)
        .value("name", &name)
        .value("id", &id)
        .value("cidr", s(v.cidr_block()))
        .value("default", yes_no(v.is_default()))
        .value("state", s(v.state().map(|st| st.as_str())))
        .field("Tenancy", s(v.instance_tenancy().map(|t| t.as_str())))
        .field("DHCP options", s(v.dhcp_options_id()))
        .tags(tag_pairs(v.tags()))
        .raw(v)
        .console(format!("https://{region}.console.aws.amazon.com/vpcconsole/home?region={region}#VpcDetails:VpcId={id}"))
}

fn subnet(sn: &Subnet, region: &str) -> Resource {
    let id = s(sn.subnet_id());
    let name = name_tag(tag_pairs(sn.tags())).unwrap_or_else(|| id.clone());
    Resource::new(&id, &name)
        .arn(sn.subnet_arn())
        .value("name", &name)
        .value("id", &id)
        .value("vpc", s(sn.vpc_id()))
        .value("cidr", s(sn.cidr_block()))
        .value("az", s(sn.availability_zone()))
        .field("Available IPs", opt(sn.available_ip_address_count()))
        .field("Public IP on launch", yes_no(sn.map_public_ip_on_launch()))
        .field("Default for AZ", yes_no(sn.default_for_az()))
        .tags(tag_pairs(sn.tags()))
        .raw(sn)
        .console(format!("https://{region}.console.aws.amazon.com/vpcconsole/home?region={region}#SubnetDetails:subnetId={id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_ec2::types::Tag;

    #[test]
    fn vpc_default_flag_and_arn() {
        let v = SdkVpc::builder().vpc_id("vpc-1").cidr_block("10.0.0.0/16").is_default(true).owner_id("1").build();
        let r = vpc(&v, "ap-northeast-2");
        assert_eq!(r.name, "vpc-1");
        assert_eq!(r.values["default"], "Yes");
        assert_eq!(r.values["cidr"], "10.0.0.0/16");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:ec2:ap-northeast-2:1:vpc/vpc-1"));
    }

    #[test]
    fn subnet_uses_name_tag_and_sdk_arn() {
        let sn = Subnet::builder()
            .subnet_id("subnet-1")
            .subnet_arn("arn:aws:ec2:r:1:subnet/subnet-1")
            .vpc_id("vpc-1")
            .availability_zone("ap-northeast-2a")
            .tags(Tag::builder().key("Name").value("private-a").build())
            .build();
        let r = subnet(&sn, "ap-northeast-2");
        assert_eq!(r.name, "private-a");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:ec2:r:1:subnet/subnet-1"));
        assert_eq!(r.values["az"], "ap-northeast-2a");
    }
}
```

- [ ] **Step 4: 레지스트리 등록**

`adapters/mod.rs`:
```rust
pub mod ec2;
pub mod util;
pub mod vpc;
```
```rust
pub fn registry() -> Vec<AdapterRef> {
    vec![Arc::new(ec2::Ec2), Arc::new(vpc::Vpc)]
}
```

- [ ] **Step 5: 테스트 실행**

Run: `cd src-tauri && cargo test adapters:: && cargo build`
Expected: ec2 4개, vpc 2개 포함 모두 PASS. 빌드 성공.

- [ ] **Step 6: Commit**

```bash
git add src-tauri
git commit -m "feat(backend): add EC2 and VPC adapters"
```

---

### Task 7: S3 어댑터 + 객체 탐색 커맨드

**Files:**
- Create: `src-tauri/src/adapters/s3.rs`
- Modify: `src-tauri/src/adapters/mod.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Produces: `s3::S3` (id `s3`, global, type `buckets`; columns `name`, `region`, `created`)
- Produces: `pub struct S3Entry { name, key, is_folder: bool, size: Option<i64>, last_modified: Option<String>, storage_class: Option<String> }`, `pub struct S3Listing { entries: Vec<S3Entry>, next_token: Option<String> }` (JSON camelCase)
- Produces: `pub async fn s3::list_objects(cfg, bucket, prefix, token: Option<String>) -> Result<S3Listing, AppError>`, `pub fn s3::to_listing(&ListObjectsV2Output, prefix) -> S3Listing`
- Produces (Tauri): `list_s3_objects({profile, region, bucket, prefix, continuationToken}) -> S3Listing` — `region`은 버킷 리전

- [ ] **Step 1: 의존성 추가**

```bash
cd src-tauri && cargo add aws-sdk-s3@1
```

- [ ] **Step 2: s3.rs 작성**

`src-tauri/src/adapters/s3.rs`:
```rust
use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;
use aws_sdk_s3::types::Bucket;
use serde::Serialize;

use super::util::{dt, map_concurrent, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct S3;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Entry {
    pub name: String,
    pub key: String,
    pub is_folder: bool,
    pub size: Option<i64>,
    pub last_modified: Option<String>,
    pub storage_class: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Listing {
    pub entries: Vec<S3Entry>,
    pub next_token: Option<String>,
}

#[async_trait]
impl ResourceAdapter for S3 {
    fn service_id(&self) -> &'static str {
        "s3"
    }
    fn display_name(&self) -> &'static str {
        "S3"
    }
    fn is_global(&self) -> bool {
        true
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "buckets",
            name: "Buckets",
            columns: vec![
                col("name", "Bucket name", Text),
                col("region", "Region", Text),
                col("created", "Created", Datetime),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "buckets" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_s3::Client::new(cfg);
        let out = client.list_buckets().send().await.map_err(|e| from_sdk(e, "s3:ListAllMyBuckets"))?;
        let buckets: Vec<Bucket> = out.buckets().to_vec();
        // ListBuckets 응답에 리전이 없으면 GetBucketLocation으로 보완한다(실패하면 빈 값).
        let regions = map_concurrent(buckets.clone(), |b| {
            let client = client.clone();
            async move {
                if let Some(r) = b.bucket_region() {
                    return r.to_string();
                }
                match client.get_bucket_location().bucket(s(b.name())).send().await {
                    Ok(loc) => location_to_region(loc.location_constraint().map(|c| c.as_str())),
                    Err(_) => String::new(),
                }
            }
        })
        .await;
        let mut capped = Capped::new();
        for (b, region) in buckets.iter().zip(regions) {
            if !capped.push(bucket(b, &region)) {
                break;
            }
        }
        Ok(capped.finish())
    }
}

/// GetBucketLocation의 빈 값은 us-east-1, "EU"는 eu-west-1을 뜻한다.
pub fn location_to_region(constraint: Option<&str>) -> String {
    match constraint {
        None | Some("") => "us-east-1".to_string(),
        Some("EU") => "eu-west-1".to_string(),
        Some(r) => r.to_string(),
    }
}

fn bucket(b: &Bucket, region: &str) -> Resource {
    let name = s(b.name());
    Resource::new(&name, &name)
        .arn(Some(format!("arn:aws:s3:::{name}")))
        .value("name", &name)
        .value("region", region)
        .value("created", dt(b.creation_date()))
        .raw(b)
        .console(format!("https://s3.console.aws.amazon.com/s3/buckets/{name}?region={region}"))
}

pub async fn list_objects(
    cfg: &SdkConfig,
    bucket: &str,
    prefix: &str,
    token: Option<String>,
) -> Result<S3Listing, AppError> {
    let out = aws_sdk_s3::Client::new(cfg)
        .list_objects_v2()
        .bucket(bucket)
        .prefix(prefix)
        .delimiter("/")
        .max_keys(1000)
        .set_continuation_token(token)
        .send()
        .await
        .map_err(|e| from_sdk(e, "s3:ListBucket"))?;
    Ok(to_listing(&out, prefix))
}

pub fn to_listing(out: &ListObjectsV2Output, prefix: &str) -> S3Listing {
    let strip = |key: &str| key.strip_prefix(prefix).unwrap_or(key).to_string();
    let mut entries: Vec<S3Entry> = out
        .common_prefixes()
        .iter()
        .filter_map(|p| p.prefix())
        .map(|p| S3Entry {
            name: strip(p).trim_end_matches('/').to_string(),
            key: p.to_string(),
            is_folder: true,
            size: None,
            last_modified: None,
            storage_class: None,
        })
        .collect();
    entries.extend(
        out.contents()
            .iter()
            .filter(|o| o.key().is_some_and(|k| k != prefix))
            .map(|o| {
                let key = s(o.key());
                S3Entry {
                    name: strip(&key),
                    key,
                    is_folder: false,
                    size: o.size(),
                    last_modified: Some(dt(o.last_modified())).filter(|v| !v.is_empty()),
                    storage_class: o.storage_class().map(|c| c.as_str().to_string()),
                }
            }),
    );
    let next_token = if out.is_truncated() == Some(true) {
        out.next_continuation_token().map(str::to_owned)
    } else {
        None
    };
    S3Listing { entries, next_token }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_s3::types::{CommonPrefix, Object, ObjectStorageClass};

    #[test]
    fn listing_has_folders_then_objects_and_skips_placeholder() {
        let out = ListObjectsV2Output::builder()
            .common_prefixes(CommonPrefix::builder().prefix("images/products/").build())
            .contents(Object::builder().key("images/").size(0).build())
            .contents(
                Object::builder()
                    .key("images/logo.svg")
                    .size(12)
                    .storage_class(ObjectStorageClass::Standard)
                    .build(),
            )
            .is_truncated(true)
            .next_continuation_token("tok")
            .build();
        let l = to_listing(&out, "images/");
        assert_eq!(l.entries.len(), 2);
        assert_eq!(l.entries[0].name, "products");
        assert!(l.entries[0].is_folder);
        assert_eq!(l.entries[0].key, "images/products/");
        assert_eq!(l.entries[1].name, "logo.svg");
        assert_eq!(l.entries[1].size, Some(12));
        assert_eq!(l.entries[1].storage_class.as_deref(), Some("STANDARD"));
        assert_eq!(l.next_token.as_deref(), Some("tok"));
    }

    #[test]
    fn listing_without_truncation_has_no_token() {
        let out = ListObjectsV2Output::builder().next_continuation_token("stale").is_truncated(false).build();
        assert_eq!(to_listing(&out, "").next_token, None);
    }

    #[test]
    fn bucket_location_mapping() {
        assert_eq!(location_to_region(None), "us-east-1");
        assert_eq!(location_to_region(Some("")), "us-east-1");
        assert_eq!(location_to_region(Some("EU")), "eu-west-1");
        assert_eq!(location_to_region(Some("ap-northeast-2")), "ap-northeast-2");
    }

    #[test]
    fn bucket_resource_has_arn_and_region() {
        let b = Bucket::builder().name("assets").build();
        let r = bucket(&b, "ap-northeast-2");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:s3:::assets"));
        assert_eq!(r.values["region"], "ap-northeast-2");
        assert!(r.console_url.unwrap().contains("buckets/assets"));
    }
}
```

- [ ] **Step 3: 레지스트리 등록 + 커맨드 추가**

`adapters/mod.rs`에 `pub mod s3;` 추가, `registry()`에 `Arc::new(s3::S3)` 추가.

`commands.rs`에 추가:
```rust
use crate::adapters::s3::{self, S3Listing};

#[tauri::command]
pub async fn list_s3_objects(
    state: State<'_, AppState>,
    profile: String,
    region: String,
    bucket: String,
    prefix: String,
    continuation_token: Option<String>,
) -> Result<S3Listing, AppError> {
    let region = if region.is_empty() { context::GLOBAL_REGION.to_string() } else { region };
    let cfg = state.ctx.config(&profile, &region).await?;
    s3::list_objects(&cfg, &bucket, &prefix, continuation_token).await
}
```

`lib.rs`의 `generate_handler!`에 `commands::list_s3_objects,` 추가.

- [ ] **Step 4: 테스트 실행**

Run: `cd src-tauri && cargo test adapters::s3 && cargo build`
Expected: 4 passed, 빌드 성공.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(backend): add S3 bucket adapter and object listing"
```

---

### Task 8: Lambda, RDS 어댑터

**Files:**
- Create: `src-tauri/src/adapters/lambda.rs`, `src-tauri/src/adapters/rds.rs`
- Modify: `src-tauri/src/adapters/mod.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Produces: `lambda::Lambda` (id `lambda`, type `functions`), `rds::Rds` (id `rds`, types `db-instances`, `db-clusters`), `pub fn lambda::fix_tz(&str) -> String`

- [ ] **Step 1: 의존성 추가**

```bash
cd src-tauri && cargo add aws-sdk-lambda@1 aws-sdk-rds@1
```

- [ ] **Step 2: lambda.rs 작성**

`src-tauri/src/adapters/lambda.rs`:
```rust
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
```

- [ ] **Step 3: rds.rs 작성**

`src-tauri/src/adapters/rds.rs`:
```rust
use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_rds::types::{DbCluster, DbInstance, Tag};

use super::util::{dt, opt, region, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Rds;

fn tag_pairs(tags: &[Tag]) -> impl Iterator<Item = (Option<&str>, Option<&str>)> {
    tags.iter().map(|t| (t.key(), t.value()))
}

#[async_trait]
impl ResourceAdapter for Rds {
    fn service_id(&self) -> &'static str {
        "rds"
    }
    fn display_name(&self) -> &'static str {
        "RDS"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![
            ResourceType {
                id: "db-instances",
                name: "DB Instances",
                columns: vec![
                    col("name", "Identifier", Text),
                    col("engine", "Engine", Text),
                    col("class", "Class", Text),
                    col("status", "Status", State),
                    col("endpoint", "Endpoint", Mono),
                ],
            },
            ResourceType {
                id: "db-clusters",
                name: "DB Clusters",
                columns: vec![
                    col("name", "Identifier", Text),
                    col("engine", "Engine", Text),
                    col("status", "Status", State),
                    col("endpoint", "Endpoint", Mono),
                ],
            },
        ]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        let client = aws_sdk_rds::Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        match type_id {
            "db-instances" => {
                let mut pages = client.describe_db_instances().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "rds:DescribeDBInstances"))?;
                    for d in page.db_instances() {
                        if !out.push(db_instance(d, &region)) {
                            break 'pages;
                        }
                    }
                }
            }
            "db-clusters" => {
                let mut pages = client.describe_db_clusters().into_paginator().send();
                'pages: while let Some(page) = pages.next().await {
                    let page = page.map_err(|e| from_sdk(e, "rds:DescribeDBClusters"))?;
                    for c in page.db_clusters() {
                        if !out.push(db_cluster(c, &region)) {
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

fn db_instance(d: &DbInstance, region: &str) -> Resource {
    let id = s(d.db_instance_identifier());
    Resource::new(&id, &id)
        .arn(d.db_instance_arn())
        .value("name", &id)
        .value("engine", s(d.engine()))
        .value("class", s(d.db_instance_class()))
        .value("status", s(d.db_instance_status()))
        .value("endpoint", s(d.endpoint().and_then(|e| e.address())))
        .field("Engine version", s(d.engine_version()))
        .field("Multi-AZ", opt(d.multi_az()))
        .field("Storage (GiB)", opt(d.allocated_storage()))
        .field("AZ", s(d.availability_zone()))
        .field("VPC", s(d.db_subnet_group().and_then(|g| g.vpc_id())))
        .field("Cluster", s(d.db_cluster_identifier()))
        .field("Created", dt(d.instance_create_time()))
        .tags(tag_pairs(d.tag_list()))
        .raw(d)
        .console(format!("https://{region}.console.aws.amazon.com/rds/home?region={region}#database:id={id};is-cluster=false"))
}

fn db_cluster(c: &DbCluster, region: &str) -> Resource {
    let id = s(c.db_cluster_identifier());
    Resource::new(&id, &id)
        .arn(c.db_cluster_arn())
        .value("name", &id)
        .value("engine", s(c.engine()))
        .value("status", s(c.status()))
        .value("endpoint", s(c.endpoint()))
        .field("Engine version", s(c.engine_version()))
        .field("Reader endpoint", s(c.reader_endpoint()))
        .field("Members", c.db_cluster_members().len())
        .field("Multi-AZ", opt(c.multi_az()))
        .field("Created", dt(c.cluster_create_time()))
        .tags(tag_pairs(c.tag_list()))
        .raw(c)
        .console(format!("https://{region}.console.aws.amazon.com/rds/home?region={region}#database:id={id};is-cluster=true"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_rds::types::Endpoint;

    #[test]
    fn db_instance_resource() {
        let d = DbInstance::builder()
            .db_instance_identifier("orders-db")
            .engine("postgres")
            .db_instance_class("db.t4g.medium")
            .db_instance_status("available")
            .endpoint(Endpoint::builder().address("orders-db.abc.rds.amazonaws.com").build())
            .db_instance_arn("arn:aws:rds:r:1:db:orders-db")
            .tag_list(Tag::builder().key("env").value("prod").build())
            .build();
        let r = db_instance(&d, "ap-northeast-2");
        assert_eq!(r.values["status"], "available");
        assert_eq!(r.values["endpoint"], "orders-db.abc.rds.amazonaws.com");
        assert_eq!(r.tags["env"], "prod");
        assert!(r.console_url.unwrap().contains("is-cluster=false"));
    }

    #[test]
    fn db_cluster_resource() {
        let c = DbCluster::builder()
            .db_cluster_identifier("aurora-1")
            .engine("aurora-mysql")
            .status("available")
            .endpoint("aurora-1.cluster-abc.rds.amazonaws.com")
            .build();
        let r = db_cluster(&c, "ap-northeast-2");
        assert_eq!(r.name, "aurora-1");
        assert_eq!(r.values["engine"], "aurora-mysql");
        assert!(r.console_url.unwrap().contains("is-cluster=true"));
    }
}
```

- [ ] **Step 4: 레지스트리 등록**

`adapters/mod.rs`에 `pub mod lambda;`, `pub mod rds;` 추가, `registry()`에 `Arc::new(lambda::Lambda), Arc::new(rds::Rds)` 추가.

- [ ] **Step 5: 테스트 실행**

Run: `cd src-tauri && cargo test adapters:: && cargo build`
Expected: lambda 2개, rds 2개 포함 모두 PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri
git commit -m "feat(backend): add Lambda and RDS adapters"
```

---

### Task 9: ECS 어댑터

**Files:**
- Create: `src-tauri/src/adapters/ecs.rs`
- Modify: `src-tauri/src/adapters/mod.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Produces: `ecs::Ecs` (id `ecs`, types `clusters`, `services`, `tasks`). Services/Tasks는 모든 클러스터를 순회한다.

- [ ] **Step 1: 의존성 추가**

```bash
cd src-tauri && cargo add aws-sdk-ecs@1
```

- [ ] **Step 2: ecs.rs 작성**

`src-tauri/src/adapters/ecs.rs`:
```rust
use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_ecs::types::{Cluster, ClusterField, Service, ServiceField, Tag, Task, TaskField};
use aws_sdk_ecs::Client;

use super::util::{dt, last_segment, region, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Ecs;

fn tag_pairs(tags: &[Tag]) -> impl Iterator<Item = (Option<&str>, Option<&str>)> {
    tags.iter().map(|t| (t.key(), t.value()))
}

async fn cluster_arns(client: &Client) -> Result<Vec<String>, AppError> {
    let mut arns = Vec::new();
    let mut pages = client.list_clusters().into_paginator().send();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "ecs:ListClusters"))?;
        arns.extend(page.cluster_arns().iter().cloned());
    }
    Ok(arns)
}

#[async_trait]
impl ResourceAdapter for Ecs {
    fn service_id(&self) -> &'static str {
        "ecs"
    }
    fn display_name(&self) -> &'static str {
        "ECS"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![
            ResourceType {
                id: "clusters",
                name: "Clusters",
                columns: vec![
                    col("name", "Name", Text),
                    col("status", "Status", State),
                    col("services", "Services", Text),
                    col("runningTasks", "Running tasks", Text),
                ],
            },
            ResourceType {
                id: "services",
                name: "Services",
                columns: vec![
                    col("name", "Name", Text),
                    col("cluster", "Cluster", Text),
                    col("status", "Status", State),
                    col("tasks", "Running/Desired", Text),
                ],
            },
            ResourceType {
                id: "tasks",
                name: "Tasks",
                columns: vec![
                    col("id", "Task ID", Mono),
                    col("cluster", "Cluster", Text),
                    col("status", "Status", State),
                    col("taskDefinition", "Task definition", Text),
                ],
            },
        ]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        let client = Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        match type_id {
            "clusters" => {
                let arns = cluster_arns(&client).await?;
                'outer: for chunk in arns.chunks(100) {
                    let res = client
                        .describe_clusters()
                        .set_clusters(Some(chunk.to_vec()))
                        .include(ClusterField::Tags)
                        .send()
                        .await
                        .map_err(|e| from_sdk(e, "ecs:DescribeClusters"))?;
                    for c in res.clusters() {
                        if !out.push(cluster(c, &region)) {
                            break 'outer;
                        }
                    }
                }
            }
            "services" => {
                'outer: for cluster_arn in cluster_arns(&client).await? {
                    let mut service_arns = Vec::new();
                    let mut pages = client.list_services().cluster(&cluster_arn).into_paginator().send();
                    while let Some(page) = pages.next().await {
                        let page = page.map_err(|e| from_sdk(e, "ecs:ListServices"))?;
                        service_arns.extend(page.service_arns().iter().cloned());
                    }
                    for chunk in service_arns.chunks(10) {
                        let res = client
                            .describe_services()
                            .cluster(&cluster_arn)
                            .set_services(Some(chunk.to_vec()))
                            .include(ServiceField::Tags)
                            .send()
                            .await
                            .map_err(|e| from_sdk(e, "ecs:DescribeServices"))?;
                        for svc in res.services() {
                            if !out.push(service(svc, &region)) {
                                break 'outer;
                            }
                        }
                    }
                }
            }
            "tasks" => {
                'outer: for cluster_arn in cluster_arns(&client).await? {
                    let mut task_arns = Vec::new();
                    let mut pages = client.list_tasks().cluster(&cluster_arn).into_paginator().send();
                    while let Some(page) = pages.next().await {
                        let page = page.map_err(|e| from_sdk(e, "ecs:ListTasks"))?;
                        task_arns.extend(page.task_arns().iter().cloned());
                    }
                    for chunk in task_arns.chunks(100) {
                        let res = client
                            .describe_tasks()
                            .cluster(&cluster_arn)
                            .set_tasks(Some(chunk.to_vec()))
                            .include(TaskField::Tags)
                            .send()
                            .await
                            .map_err(|e| from_sdk(e, "ecs:DescribeTasks"))?;
                        for t in res.tasks() {
                            if !out.push(task(t, &region)) {
                                break 'outer;
                            }
                        }
                    }
                }
            }
            other => return Err(unknown_type(other)),
        }
        Ok(out.finish())
    }
}

fn cluster(c: &Cluster, region: &str) -> Resource {
    let name = s(c.cluster_name());
    Resource::new(&name, &name)
        .arn(c.cluster_arn())
        .value("name", &name)
        .value("status", s(c.status()))
        .value("services", c.active_services_count())
        .value("runningTasks", c.running_tasks_count())
        .field("Pending tasks", c.pending_tasks_count())
        .field("Container instances", c.registered_container_instances_count())
        .field("Capacity providers", c.capacity_providers().join(", "))
        .tags(tag_pairs(c.tags()))
        .raw(c)
        .console(format!("https://{region}.console.aws.amazon.com/ecs/v2/clusters/{name}?region={region}"))
}

fn service(svc: &Service, region: &str) -> Resource {
    let name = s(svc.service_name());
    let cluster = last_segment(&s(svc.cluster_arn()), '/');
    Resource::new(s(svc.service_arn()), &name)
        .arn(svc.service_arn())
        .value("name", &name)
        .value("cluster", &cluster)
        .value("status", s(svc.status()))
        .value("tasks", format!("{}/{}", svc.running_count(), svc.desired_count()))
        .field("Pending", svc.pending_count())
        .field("Launch type", s(svc.launch_type().map(|l| l.as_str())))
        .field("Task definition", last_segment(&s(svc.task_definition()), '/'))
        .field("Created", dt(svc.created_at()))
        .tags(tag_pairs(svc.tags()))
        .raw(svc)
        .console(format!(
            "https://{region}.console.aws.amazon.com/ecs/v2/clusters/{cluster}/services/{name}?region={region}"
        ))
}

fn task(t: &Task, region: &str) -> Resource {
    let arn = s(t.task_arn());
    let id = last_segment(&arn, '/');
    let cluster = last_segment(&s(t.cluster_arn()), '/');
    Resource::new(&id, &id)
        .arn(t.task_arn())
        .value("id", &id)
        .value("cluster", &cluster)
        .value("status", s(t.last_status()))
        .value("taskDefinition", last_segment(&s(t.task_definition_arn()), '/'))
        .field("Desired status", s(t.desired_status()))
        .field("Launch type", s(t.launch_type().map(|l| l.as_str())))
        .field("CPU", s(t.cpu()))
        .field("Memory", s(t.memory()))
        .field("Group", s(t.group()))
        .field("AZ", s(t.availability_zone()))
        .field("Started", dt(t.started_at()))
        .tags(tag_pairs(t.tags()))
        .raw(t)
        .console(format!(
            "https://{region}.console.aws.amazon.com/ecs/v2/clusters/{cluster}/tasks/{id}?region={region}"
        ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cluster_counts() {
        let c = Cluster::builder()
            .cluster_name("prod")
            .cluster_arn("arn:aws:ecs:r:1:cluster/prod")
            .status("ACTIVE")
            .active_services_count(3)
            .running_tasks_count(7)
            .build();
        let r = cluster(&c, "ap-northeast-2");
        assert_eq!(r.values["services"], "3");
        assert_eq!(r.values["runningTasks"], "7");
        assert!(r.console_url.unwrap().contains("/clusters/prod"));
    }

    #[test]
    fn service_shows_cluster_and_counts() {
        let svc = Service::builder()
            .service_name("api")
            .service_arn("arn:aws:ecs:r:1:service/prod/api")
            .cluster_arn("arn:aws:ecs:r:1:cluster/prod")
            .status("ACTIVE")
            .running_count(2)
            .desired_count(3)
            .build();
        let r = service(&svc, "ap-northeast-2");
        assert_eq!(r.values["cluster"], "prod");
        assert_eq!(r.values["tasks"], "2/3");
        assert!(r.console_url.unwrap().contains("/clusters/prod/services/api"));
    }

    #[test]
    fn task_uses_short_ids() {
        let t = Task::builder()
            .task_arn("arn:aws:ecs:r:1:task/prod/abc123")
            .cluster_arn("arn:aws:ecs:r:1:cluster/prod")
            .last_status("RUNNING")
            .task_definition_arn("arn:aws:ecs:r:1:task-definition/api:42")
            .build();
        let r = task(&t, "ap-northeast-2");
        assert_eq!(r.id, "abc123");
        assert_eq!(r.values["taskDefinition"], "api:42");
        assert_eq!(r.values["status"], "RUNNING");
    }
}
```

- [ ] **Step 3: 레지스트리 등록**

`adapters/mod.rs`에 `pub mod ecs;` 추가, `registry()`에 `Arc::new(ecs::Ecs)` 추가.

- [ ] **Step 4: 테스트 실행**

Run: `cd src-tauri && cargo test adapters::ecs && cargo build`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(backend): add ECS adapter"
```

---

### Task 10: EKS 어댑터

**Files:**
- Create: `src-tauri/src/adapters/eks.rs`
- Modify: `src-tauri/src/adapters/mod.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Produces: `eks::Eks` (id `eks`, types `clusters`, `node-groups`). 항목별 describe는 `map_concurrent`로 동시 실행.

- [ ] **Step 1: 의존성 추가**

```bash
cd src-tauri && cargo add aws-sdk-eks@1
```

- [ ] **Step 2: eks.rs 작성**

`src-tauri/src/adapters/eks.rs`:
```rust
use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_eks::types::{Cluster, Nodegroup};
use aws_sdk_eks::Client;

use super::util::{dt, hash_tags, map_concurrent, opt, region, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Eks;

async fn cluster_names(client: &Client) -> Result<Vec<String>, AppError> {
    let mut names = Vec::new();
    let mut pages = client.list_clusters().into_paginator().send();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "eks:ListClusters"))?;
        names.extend(page.clusters().iter().cloned());
    }
    Ok(names)
}

#[async_trait]
impl ResourceAdapter for Eks {
    fn service_id(&self) -> &'static str {
        "eks"
    }
    fn display_name(&self) -> &'static str {
        "EKS"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![
            ResourceType {
                id: "clusters",
                name: "Clusters",
                columns: vec![
                    col("name", "Name", Text),
                    col("version", "Version", Text),
                    col("status", "Status", State),
                    col("endpoint", "Endpoint", Mono),
                ],
            },
            ResourceType {
                id: "node-groups",
                name: "Node Groups",
                columns: vec![
                    col("name", "Name", Text),
                    col("cluster", "Cluster", Text),
                    col("status", "Status", State),
                    col("instanceTypes", "Instance types", Text),
                    col("size", "Size (min/desired/max)", Text),
                ],
            },
        ]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        let client = Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        match type_id {
            "clusters" => {
                let names = cluster_names(&client).await?;
                let results = map_concurrent(names, |name| {
                    let client = client.clone();
                    async move { client.describe_cluster().name(name).send().await }
                })
                .await;
                for res in results {
                    let res = res.map_err(|e| from_sdk(e, "eks:DescribeCluster"))?;
                    if let Some(c) = res.cluster() {
                        if !out.push(cluster(c, &region)) {
                            break;
                        }
                    }
                }
            }
            "node-groups" => {
                'outer: for cluster_name in cluster_names(&client).await? {
                    let mut ng_names = Vec::new();
                    let mut pages = client.list_nodegroups().cluster_name(&cluster_name).into_paginator().send();
                    while let Some(page) = pages.next().await {
                        let page = page.map_err(|e| from_sdk(e, "eks:ListNodegroups"))?;
                        ng_names.extend(page.nodegroups().iter().cloned());
                    }
                    let results = map_concurrent(ng_names, |ng| {
                        let client = client.clone();
                        let cluster_name = cluster_name.clone();
                        async move { client.describe_nodegroup().cluster_name(cluster_name).nodegroup_name(ng).send().await }
                    })
                    .await;
                    for res in results {
                        let res = res.map_err(|e| from_sdk(e, "eks:DescribeNodegroup"))?;
                        if let Some(ng) = res.nodegroup() {
                            if !out.push(nodegroup(ng, &region)) {
                                break 'outer;
                            }
                        }
                    }
                }
            }
            other => return Err(unknown_type(other)),
        }
        Ok(out.finish())
    }
}

fn cluster(c: &Cluster, region: &str) -> Resource {
    let name = s(c.name());
    Resource::new(&name, &name)
        .arn(c.arn())
        .value("name", &name)
        .value("version", s(c.version()))
        .value("status", s(c.status().map(|st| st.as_str())))
        .value("endpoint", s(c.endpoint()))
        .field("Platform version", s(c.platform_version()))
        .field("Role", s(c.role_arn()))
        .field("Created", dt(c.created_at()))
        .tags(hash_tags(c.tags()))
        .raw(c)
        .console(format!("https://{region}.console.aws.amazon.com/eks/home?region={region}#/clusters/{name}"))
}

fn nodegroup(ng: &Nodegroup, region: &str) -> Resource {
    let name = s(ng.nodegroup_name());
    let cluster = s(ng.cluster_name());
    let size = ng
        .scaling_config()
        .map(|sc| format!("{}/{}/{}", opt(sc.min_size()), opt(sc.desired_size()), opt(sc.max_size())))
        .unwrap_or_default();
    Resource::new(s(ng.nodegroup_arn()), &name)
        .arn(ng.nodegroup_arn())
        .value("name", &name)
        .value("cluster", &cluster)
        .value("status", s(ng.status().map(|st| st.as_str())))
        .value("instanceTypes", ng.instance_types().join(", "))
        .value("size", size)
        .field("Capacity type", s(ng.capacity_type().map(|c| c.as_str())))
        .field("Kubernetes version", s(ng.version()))
        .field("AMI release", s(ng.release_version()))
        .field("Created", dt(ng.created_at()))
        .tags(hash_tags(ng.tags()))
        .raw(ng)
        .console(format!(
            "https://{region}.console.aws.amazon.com/eks/home?region={region}#/clusters/{cluster}/nodegroups/{name}"
        ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_eks::types::{ClusterStatus, NodegroupScalingConfig, NodegroupStatus};

    #[test]
    fn cluster_resource_with_tags() {
        let c = Cluster::builder()
            .name("prod")
            .version("1.31")
            .status(ClusterStatus::Active)
            .endpoint("https://abc.eks.amazonaws.com")
            .tags("env", "prod")
            .build();
        let r = cluster(&c, "ap-northeast-2");
        assert_eq!(r.values["status"], "ACTIVE");
        assert_eq!(r.values["version"], "1.31");
        assert_eq!(r.tags["env"], "prod");
    }

    #[test]
    fn nodegroup_size_and_types() {
        let ng = Nodegroup::builder()
            .nodegroup_name("default")
            .cluster_name("prod")
            .status(NodegroupStatus::Active)
            .instance_types("m6i.large")
            .instance_types("m6i.xlarge")
            .scaling_config(NodegroupScalingConfig::builder().min_size(1).desired_size(2).max_size(5).build())
            .build();
        let r = nodegroup(&ng, "ap-northeast-2");
        assert_eq!(r.values["instanceTypes"], "m6i.large, m6i.xlarge");
        assert_eq!(r.values["size"], "1/2/5");
        assert!(r.console_url.unwrap().contains("/clusters/prod/nodegroups/default"));
    }
}
```

- [ ] **Step 3: 레지스트리 등록**

`adapters/mod.rs`에 `pub mod eks;` 추가, `registry()`에 `Arc::new(eks::Eks)` 추가.

- [ ] **Step 4: 테스트 실행**

Run: `cd src-tauri && cargo test adapters::eks && cargo build`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(backend): add EKS adapter"
```

---

### Task 11: 전역 서비스 어댑터 — IAM, Route53, CloudFront

**Files:**
- Create: `src-tauri/src/adapters/iam.rs`, `src-tauri/src/adapters/route53.rs`, `src-tauri/src/adapters/cloudfront.rs`
- Modify: `src-tauri/src/adapters/mod.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Produces: `iam::Iam` (id `iam`, global, types `users`, `roles`, `policies`), `route53::Route53` (id `route53`, global, type `hosted-zones`), `cloudfront::CloudFront` (id `cloudfront`, global, type `distributions`)

- [ ] **Step 1: 의존성 추가**

```bash
cd src-tauri && cargo add aws-sdk-iam@1 aws-sdk-route53@1 aws-sdk-cloudfront@1
```

- [ ] **Step 2: iam.rs 작성**

`src-tauri/src/adapters/iam.rs`:
```rust
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
```

- [ ] **Step 3: route53.rs 작성**

`src-tauri/src/adapters/route53.rs`:
```rust
use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_route53::types::HostedZone;

use super::util::{opt, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Route53;

#[async_trait]
impl ResourceAdapter for Route53 {
    fn service_id(&self) -> &'static str {
        "route53"
    }
    fn display_name(&self) -> &'static str {
        "Route53"
    }
    fn is_global(&self) -> bool {
        true
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "hosted-zones",
            name: "Hosted Zones",
            columns: vec![
                col("name", "Name", Text),
                col("id", "Zone ID", Mono),
                col("private", "Private", Text),
                col("records", "Record count", Text),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "hosted-zones" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_route53::Client::new(cfg);
        let mut out = Capped::new();
        let mut pages = client.list_hosted_zones().into_paginator().send();
        'pages: while let Some(page) = pages.next().await {
            let page = page.map_err(|e| from_sdk(e, "route53:ListHostedZones"))?;
            for z in page.hosted_zones() {
                if !out.push(zone(z)) {
                    break 'pages;
                }
            }
        }
        Ok(out.finish())
    }
}

fn zone(z: &HostedZone) -> Resource {
    let id = z.id().trim_start_matches("/hostedzone/").to_string();
    let name = z.name().to_string();
    let private = z.config().map(|c| c.private_zone()).unwrap_or(false);
    Resource::new(&id, &name)
        .arn(Some(format!("arn:aws:route53:::hostedzone/{id}")))
        .value("name", &name)
        .value("id", &id)
        .value("private", if private { "Yes" } else { "No" })
        .value("records", opt(z.resource_record_set_count()))
        .field("Comment", s(z.config().and_then(|c| c.comment())))
        .raw(z)
        .console(format!("https://console.aws.amazon.com/route53/v2/hostedzones#ListRecordSets/{id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_route53::types::HostedZoneConfig;

    #[test]
    fn zone_strips_prefix() {
        let z = HostedZone::builder()
            .id("/hostedzone/Z123")
            .name("example.com.")
            .caller_reference("ref")
            .config(HostedZoneConfig::builder().private_zone(true).build())
            .resource_record_set_count(12)
            .build()
            .unwrap();
        let r = zone(&z);
        assert_eq!(r.id, "Z123");
        assert_eq!(r.values["private"], "Yes");
        assert_eq!(r.values["records"], "12");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:route53:::hostedzone/Z123"));
    }
}
```

- [ ] **Step 4: cloudfront.rs 작성**

`src-tauri/src/adapters/cloudfront.rs`:
```rust
use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_cloudfront::types::DistributionSummary;

use super::util::{dt, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct CloudFront;

#[async_trait]
impl ResourceAdapter for CloudFront {
    fn service_id(&self) -> &'static str {
        "cloudfront"
    }
    fn display_name(&self) -> &'static str {
        "CloudFront"
    }
    fn is_global(&self) -> bool {
        true
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "distributions",
            name: "Distributions",
            columns: vec![
                col("id", "ID", Mono),
                col("domain", "Domain", Mono),
                col("aliases", "Aliases", Text),
                col("status", "Status", State),
                col("enabled", "Enabled", Text),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "distributions" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_cloudfront::Client::new(cfg);
        let mut out = Capped::new();
        let mut marker: Option<String> = None;
        'pages: loop {
            let res = client
                .list_distributions()
                .set_marker(marker.clone())
                .send()
                .await
                .map_err(|e| from_sdk(e, "cloudfront:ListDistributions"))?;
            let Some(list) = res.distribution_list() else { break };
            for d in list.items() {
                if !out.push(distribution(d)) {
                    break 'pages;
                }
            }
            match (list.is_truncated(), list.next_marker()) {
                (true, Some(next)) => marker = Some(next.to_string()),
                _ => break,
            }
        }
        Ok(out.finish())
    }
}

fn distribution(d: &DistributionSummary) -> Resource {
    let aliases: Vec<&str> = d.aliases().map(|a| a.items().iter().map(String::as_str).collect()).unwrap_or_default();
    let name = aliases.first().copied().unwrap_or(d.domain_name()).to_string();
    let id = d.id().to_string();
    Resource::new(&id, &name)
        .arn(Some(d.arn()))
        .value("id", &id)
        .value("domain", d.domain_name())
        .value("aliases", aliases.join(", "))
        .value("status", d.status())
        .value("enabled", if d.enabled() { "Yes" } else { "No" })
        .field("Comment", d.comment())
        .field("Price class", d.price_class().as_str())
        .field(
            "Origins",
            d.origins().map(|o| o.items().iter().map(|x| x.domain_name()).collect::<Vec<_>>().join(", ")).unwrap_or_default(),
        )
        .field("Last modified", dt(Some(d.last_modified_time())))
        .raw(d)
        .console(format!("https://console.aws.amazon.com/cloudfront/v4/home#/distributions/{id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_cloudfront::types::Aliases;

    #[test]
    fn distribution_name_prefers_alias() {
        let d = DistributionSummary::builder()
            .id("E1")
            .arn("arn:aws:cloudfront::1:distribution/E1")
            .domain_name("d1.cloudfront.net")
            .status("Deployed")
            .enabled(true)
            .aliases(Aliases::builder().quantity(1).items("cdn.example.com").build().unwrap())
            .build();
        // 필수 필드가 많아 build()가 Result를 돌려주면 .unwrap()을 붙이고, 누락된 필수 필드는
        // 기본값(빈 문자열/false/DateTime::from_secs(0) 등)으로 채운다.
        let r = distribution(&d.unwrap());
        assert_eq!(r.name, "cdn.example.com");
        assert_eq!(r.values["enabled"], "Yes");
        assert_eq!(r.values["status"], "Deployed");
    }
}
```

> 참고: `DistributionSummary::builder()`의 필수 필드(`last_modified_time`, `origins`, `default_cache_behavior`, `cache_behaviors`, `custom_error_responses`, `comment`, `price_class`, `restrictions`, `web_acl_id`, `http_version`, `is_ipv6_enabled`, `viewer_certificate`, `staging`)가 빠지면 `build()`가 `Err`를 돌려준다. 테스트가 실패하면 컴파일러/런타임 오류 메시지를 보고 각 필드를 최소값으로 채운다. 단언(assert)은 바꾸지 않는다.

- [ ] **Step 5: 레지스트리 등록**

`adapters/mod.rs`에 `pub mod cloudfront;`, `pub mod iam;`, `pub mod route53;` 추가, `registry()`에 세 어댑터 추가.

- [ ] **Step 6: 테스트 실행**

Run: `cd src-tauri && cargo test adapters:: && cargo build`
Expected: iam 2개, route53 1개, cloudfront 1개 포함 모두 PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri
git commit -m "feat(backend): add IAM, Route53, and CloudFront adapters"
```

---

### Task 12: DynamoDB, CloudWatch Logs 어댑터

**Files:**
- Create: `src-tauri/src/adapters/dynamodb.rs`, `src-tauri/src/adapters/logs.rs`
- Modify: `src-tauri/src/adapters/mod.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Produces: `dynamodb::DynamoDb` (id `dynamodb`, type `tables`), `logs::Logs` (id `logs`, display `CloudWatch Logs`, type `log-groups`)

- [ ] **Step 1: 의존성 추가**

```bash
cd src-tauri && cargo add aws-sdk-dynamodb@1 aws-sdk-cloudwatchlogs@1
```

- [ ] **Step 2: dynamodb.rs 작성**

`src-tauri/src/adapters/dynamodb.rs`:
```rust
use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_dynamodb::types::TableDescription;

use super::util::{dt, map_concurrent, opt, region, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct DynamoDb;

#[async_trait]
impl ResourceAdapter for DynamoDb {
    fn service_id(&self) -> &'static str {
        "dynamodb"
    }
    fn display_name(&self) -> &'static str {
        "DynamoDB"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "tables",
            name: "Tables",
            columns: vec![
                col("name", "Name", Text),
                col("status", "Status", State),
                col("items", "Items", Text),
                col("size", "Size", Bytes),
                col("billing", "Billing mode", Text),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "tables" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_dynamodb::Client::new(cfg);
        let region = region(cfg);
        let mut names = Capped::new();
        let mut pages = client.list_tables().into_paginator().send();
        'pages: while let Some(page) = pages.next().await {
            let page = page.map_err(|e| from_sdk(e, "dynamodb:ListTables"))?;
            for n in page.table_names() {
                if !names.push(n.clone()) {
                    break 'pages;
                }
            }
        }
        let results = map_concurrent(names.items, |name| {
            let client = client.clone();
            async move { client.describe_table().table_name(name).send().await }
        })
        .await;
        let mut items = Vec::new();
        for res in results {
            let res = res.map_err(|e| from_sdk(e, "dynamodb:DescribeTable"))?;
            if let Some(t) = res.table() {
                items.push(table(t, &region));
            }
        }
        Ok(ListResult { items, truncated: names.truncated })
    }
}

fn table(t: &TableDescription, region: &str) -> Resource {
    let name = s(t.table_name());
    let billing = t
        .billing_mode_summary()
        .and_then(|b| b.billing_mode())
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "PROVISIONED".to_string());
    let keys = t
        .key_schema()
        .iter()
        .map(|k| format!("{} ({})", k.attribute_name(), k.key_type().as_str()))
        .collect::<Vec<_>>()
        .join(", ");
    Resource::new(&name, &name)
        .arn(t.table_arn())
        .value("name", &name)
        .value("status", s(t.table_status().map(|st| st.as_str())))
        .value("items", opt(t.item_count()))
        .value("size", opt(t.table_size_bytes()))
        .value("billing", billing)
        .field("Keys", keys)
        .field("GSIs", t.global_secondary_indexes().len())
        .field("Created", dt(t.creation_date_time()))
        .raw(t)
        .console(format!("https://{region}.console.aws.amazon.com/dynamodbv2/home?region={region}#table?name={name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_dynamodb::types::{BillingMode, BillingModeSummary, KeySchemaElement, KeyType, TableStatus};

    #[test]
    fn table_resource() {
        let t = TableDescription::builder()
            .table_name("orders")
            .table_status(TableStatus::Active)
            .item_count(120)
            .table_size_bytes(2048)
            .billing_mode_summary(BillingModeSummary::builder().billing_mode(BillingMode::PayPerRequest).build())
            .key_schema(KeySchemaElement::builder().attribute_name("pk").key_type(KeyType::Hash).build().unwrap())
            .build();
        let r = table(&t, "ap-northeast-2");
        assert_eq!(r.values["status"], "ACTIVE");
        assert_eq!(r.values["items"], "120");
        assert_eq!(r.values["size"], "2048");
        assert_eq!(r.values["billing"], "PAY_PER_REQUEST");
        assert!(r.fields.iter().any(|f| f.label == "Keys" && f.value == "pk (HASH)"));
    }

    #[test]
    fn billing_defaults_to_provisioned() {
        let t = TableDescription::builder().table_name("legacy").build();
        assert_eq!(table(&t, "us-east-1").values["billing"], "PROVISIONED");
    }
}
```

- [ ] **Step 3: logs.rs 작성**

`src-tauri/src/adapters/logs.rs`:
```rust
use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_cloudwatchlogs::types::LogGroup;

use super::util::{dt_millis, opt, region, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Logs;

#[async_trait]
impl ResourceAdapter for Logs {
    fn service_id(&self) -> &'static str {
        "logs"
    }
    fn display_name(&self) -> &'static str {
        "CloudWatch Logs"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "log-groups",
            name: "Log Groups",
            columns: vec![
                col("name", "Name", Text),
                col("retention", "Retention", Text),
                col("stored", "Stored bytes", Bytes),
                col("created", "Created", Datetime),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "log-groups" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_cloudwatchlogs::Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        let mut pages = client.describe_log_groups().into_paginator().send();
        'pages: while let Some(page) = pages.next().await {
            let page = page.map_err(|e| from_sdk(e, "logs:DescribeLogGroups"))?;
            for g in page.log_groups() {
                if !out.push(log_group(g, &region)) {
                    break 'pages;
                }
            }
        }
        Ok(out.finish())
    }
}

fn log_group(g: &LogGroup, region: &str) -> Resource {
    let name = s(g.log_group_name());
    let retention = g.retention_in_days().map(|d| format!("{d}일")).unwrap_or_else(|| "만료 없음".to_string());
    Resource::new(&name, &name)
        .arn(g.arn().map(|a| a.trim_end_matches(":*").to_string()))
        .value("name", &name)
        .value("retention", retention)
        .value("stored", opt(g.stored_bytes()))
        .value("created", dt_millis(g.creation_time()))
        .field("Class", s(g.log_group_class().map(|c| c.as_str())))
        .field("KMS key", s(g.kms_key_id()))
        .raw(g)
        .console(format!(
            "https://{region}.console.aws.amazon.com/cloudwatch/home?region={region}#logsV2:log-groups/log-group/{}",
            name.replace('/', "$252F")
        ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_group_resource() {
        let g = LogGroup::builder()
            .log_group_name("/aws/lambda/order-processor")
            .arn("arn:aws:logs:r:1:log-group:/aws/lambda/order-processor:*")
            .retention_in_days(14)
            .stored_bytes(4096)
            .creation_time(0)
            .build();
        let r = log_group(&g, "ap-northeast-2");
        assert_eq!(r.values["retention"], "14일");
        assert_eq!(r.values["stored"], "4096");
        assert_eq!(r.values["created"], "1970-01-01T00:00:00Z");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:logs:r:1:log-group:/aws/lambda/order-processor"));
        assert!(r.console_url.unwrap().ends_with("$252Faws$252Flambda$252Forder-processor"));
    }

    #[test]
    fn missing_retention_means_never_expire() {
        let g = LogGroup::builder().log_group_name("app").build();
        assert_eq!(log_group(&g, "us-east-1").values["retention"], "만료 없음");
    }
}
```

- [ ] **Step 4: 레지스트리 등록**

`adapters/mod.rs`에 `pub mod dynamodb;`, `pub mod logs;` 추가, `registry()`에 두 어댑터 추가.

- [ ] **Step 5: 테스트 실행**

Run: `cd src-tauri && cargo test adapters:: && cargo build`
Expected: dynamodb 2개, logs 2개 포함 모두 PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri
git commit -m "feat(backend): add DynamoDB and CloudWatch Logs adapters"
```

---

### Task 13: SQS, SNS 어댑터

**Files:**
- Create: `src-tauri/src/adapters/sqs.rs`, `src-tauri/src/adapters/sns.rs`
- Modify: `src-tauri/src/adapters/mod.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Produces: `sqs::Sqs` (id `sqs`, type `queues`), `sns::Sns` (id `sns`, type `topics`)

- [ ] **Step 1: 의존성 추가**

```bash
cd src-tauri && cargo add aws-sdk-sqs@1 aws-sdk-sns@1
```

- [ ] **Step 2: sqs.rs 작성**

`src-tauri/src/adapters/sqs.rs`:
```rust
use std::collections::HashMap;

use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_sqs::types::QueueAttributeName as A;

use super::util::{dt_millis, last_segment, map_concurrent, region, unknown_type, url_encode, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Sqs;

#[async_trait]
impl ResourceAdapter for Sqs {
    fn service_id(&self) -> &'static str {
        "sqs"
    }
    fn display_name(&self) -> &'static str {
        "SQS"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "queues",
            name: "Queues",
            columns: vec![
                col("name", "Name", Text),
                col("type", "Type", Text),
                col("messages", "Messages", Text),
                col("url", "URL", Mono),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "queues" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_sqs::Client::new(cfg);
        let region = region(cfg);
        let mut urls = Capped::new();
        let mut pages = client.list_queues().into_paginator().send();
        'pages: while let Some(page) = pages.next().await {
            let page = page.map_err(|e| from_sdk(e, "sqs:ListQueues"))?;
            for u in page.queue_urls() {
                if !urls.push(u.clone()) {
                    break 'pages;
                }
            }
        }
        let results = map_concurrent(urls.items.clone(), |url| {
            let client = client.clone();
            async move { client.get_queue_attributes().queue_url(url).attribute_names(A::All).send().await }
        })
        .await;
        let mut items = Vec::new();
        for (url, res) in urls.items.iter().zip(results) {
            let res = res.map_err(|e| from_sdk(e, "sqs:GetQueueAttributes"))?;
            let empty = HashMap::new();
            items.push(queue(url, res.attributes().unwrap_or(&empty), &region));
        }
        Ok(ListResult { items, truncated: urls.truncated })
    }
}

fn queue(url: &str, attrs: &HashMap<A, String>, region: &str) -> Resource {
    let name = last_segment(url, '/');
    let get = |k: A| attrs.get(&k).cloned().unwrap_or_default();
    let created = get(A::CreatedTimestamp).parse::<i64>().ok().map(|secs| secs * 1000);
    Resource::new(url, &name)
        .arn(Some(get(A::QueueArn)).filter(|a| !a.is_empty()))
        .value("name", &name)
        .value("type", if name.ends_with(".fifo") { "FIFO" } else { "Standard" })
        .value("messages", get(A::ApproximateNumberOfMessages))
        .value("url", url)
        .field("In flight", get(A::ApproximateNumberOfMessagesNotVisible))
        .field("Visibility timeout (s)", get(A::VisibilityTimeout))
        .field("Retention (s)", get(A::MessageRetentionPeriod))
        .field("Redrive policy", get(A::RedrivePolicy))
        .field("Created", dt_millis(created))
        .raw(attrs)
        .console(format!("https://{region}.console.aws.amazon.com/sqs/v3/home?region={region}#/queues/{}", url_encode(url)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_from_attributes() {
        let attrs = HashMap::from([
            (A::QueueArn, "arn:aws:sqs:r:1:jobs.fifo".to_string()),
            (A::ApproximateNumberOfMessages, "5".to_string()),
            (A::CreatedTimestamp, "0".to_string()),
        ]);
        let r = queue("https://sqs.r.amazonaws.com/1/jobs.fifo", &attrs, "ap-northeast-2");
        assert_eq!(r.name, "jobs.fifo");
        assert_eq!(r.values["type"], "FIFO");
        assert_eq!(r.values["messages"], "5");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:sqs:r:1:jobs.fifo"));
        assert!(r.fields.iter().any(|f| f.label == "Created" && f.value == "1970-01-01T00:00:00Z"));
    }

    #[test]
    fn standard_queue_without_attrs() {
        let r = queue("https://sqs.r.amazonaws.com/1/emails", &HashMap::new(), "us-east-1");
        assert_eq!(r.values["type"], "Standard");
        assert_eq!(r.arn, None);
    }
}
```

- [ ] **Step 3: sns.rs 작성**

`src-tauri/src/adapters/sns.rs`:
```rust
use std::collections::HashMap;

use async_trait::async_trait;
use aws_config::SdkConfig;

use super::util::{last_segment, map_concurrent, region, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Sns;

#[async_trait]
impl ResourceAdapter for Sns {
    fn service_id(&self) -> &'static str {
        "sns"
    }
    fn display_name(&self) -> &'static str {
        "SNS"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "topics",
            name: "Topics",
            columns: vec![
                col("name", "Name", Text),
                col("arn", "ARN", Mono),
                col("subscriptions", "Subscriptions", Text),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "topics" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_sns::Client::new(cfg);
        let region = region(cfg);
        let mut arns = Capped::new();
        let mut pages = client.list_topics().into_paginator().send();
        'pages: while let Some(page) = pages.next().await {
            let page = page.map_err(|e| from_sdk(e, "sns:ListTopics"))?;
            for t in page.topics() {
                if let Some(arn) = t.topic_arn() {
                    if !arns.push(arn.to_string()) {
                        break 'pages;
                    }
                }
            }
        }
        let results = map_concurrent(arns.items.clone(), |arn| {
            let client = client.clone();
            async move { client.get_topic_attributes().topic_arn(arn).send().await }
        })
        .await;
        let mut items = Vec::new();
        for (arn, res) in arns.items.iter().zip(results) {
            let res = res.map_err(|e| from_sdk(e, "sns:GetTopicAttributes"))?;
            let empty = HashMap::new();
            items.push(topic(arn, res.attributes().unwrap_or(&empty), &region));
        }
        Ok(ListResult { items, truncated: arns.truncated })
    }
}

fn topic(arn: &str, attrs: &HashMap<String, String>, region: &str) -> Resource {
    let name = last_segment(arn, ':');
    let get = |k: &str| attrs.get(k).cloned().unwrap_or_default();
    Resource::new(arn, &name)
        .arn(Some(arn))
        .value("name", &name)
        .value("arn", arn)
        .value("subscriptions", get("SubscriptionsConfirmed"))
        .field("Pending subscriptions", get("SubscriptionsPending"))
        .field("Display name", get("DisplayName"))
        .field("Owner", get("Owner"))
        .field("FIFO", get("FifoTopic"))
        .raw(attrs)
        .console(format!("https://{region}.console.aws.amazon.com/sns/v3/home?region={region}#/topic/{arn}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_from_attributes() {
        let attrs = HashMap::from([("SubscriptionsConfirmed".to_string(), "3".to_string())]);
        let r = topic("arn:aws:sns:ap-northeast-2:1:alerts", &attrs, "ap-northeast-2");
        assert_eq!(r.name, "alerts");
        assert_eq!(r.values["subscriptions"], "3");
        assert!(r.console_url.unwrap().ends_with("#/topic/arn:aws:sns:ap-northeast-2:1:alerts"));
    }
}
```

- [ ] **Step 4: 레지스트리 등록**

`adapters/mod.rs`에 `pub mod sns;`, `pub mod sqs;` 추가, `registry()`에 두 어댑터 추가.

- [ ] **Step 5: 테스트 실행**

Run: `cd src-tauri && cargo test adapters:: && cargo build`
Expected: sqs 2개, sns 1개 포함 모두 PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri
git commit -m "feat(backend): add SQS and SNS adapters"
```

---

### Task 14: ECR, Secrets Manager 어댑터 + 레지스트리 순서 확정

**Files:**
- Create: `src-tauri/src/adapters/ecr.rs`, `src-tauri/src/adapters/secretsmanager.rs`
- Modify: `src-tauri/src/adapters/mod.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Produces: `ecr::Ecr` (id `ecr`, type `repositories`), `secretsmanager::SecretsManager` (id `secretsmanager`, display `Secrets Manager`, type `secrets`)
- Produces: 최종 `registry()` — Global Constraints의 16개 순서

- [ ] **Step 1: 의존성 추가**

```bash
cd src-tauri && cargo add aws-sdk-ecr@1 aws-sdk-secretsmanager@1
```

- [ ] **Step 2: ecr.rs 작성**

`src-tauri/src/adapters/ecr.rs`:
```rust
use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_ecr::types::Repository;

use super::util::{dt, region, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Ecr;

#[async_trait]
impl ResourceAdapter for Ecr {
    fn service_id(&self) -> &'static str {
        "ecr"
    }
    fn display_name(&self) -> &'static str {
        "ECR"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "repositories",
            name: "Repositories",
            columns: vec![
                col("name", "Name", Text),
                col("uri", "URI", Mono),
                col("created", "Created", Datetime),
                col("scanOnPush", "Scan on push", Text),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "repositories" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_ecr::Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        let mut pages = client.describe_repositories().into_paginator().send();
        'pages: while let Some(page) = pages.next().await {
            let page = page.map_err(|e| from_sdk(e, "ecr:DescribeRepositories"))?;
            for r in page.repositories() {
                if !out.push(repository(r, &region)) {
                    break 'pages;
                }
            }
        }
        Ok(out.finish())
    }
}

fn repository(r: &Repository, region: &str) -> Resource {
    let name = s(r.repository_name());
    let account = s(r.registry_id());
    let scan = r.image_scanning_configuration().map(|c| c.scan_on_push()).unwrap_or(false);
    Resource::new(&name, &name)
        .arn(r.repository_arn())
        .value("name", &name)
        .value("uri", s(r.repository_uri()))
        .value("created", dt(r.created_at()))
        .value("scanOnPush", if scan { "Yes" } else { "No" })
        .field("Tag mutability", s(r.image_tag_mutability().map(|m| m.as_str())))
        .field("Encryption", s(r.encryption_configuration().map(|e| e.encryption_type().as_str())))
        .raw(r)
        .console(format!("https://{region}.console.aws.amazon.com/ecr/repositories/private/{account}/{name}?region={region}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_ecr::types::ImageScanningConfiguration;

    #[test]
    fn repository_resource() {
        let r = Repository::builder()
            .repository_name("api")
            .repository_uri("1.dkr.ecr.r.amazonaws.com/api")
            .registry_id("1")
            .image_scanning_configuration(ImageScanningConfiguration::builder().scan_on_push(true).build())
            .build();
        let res = repository(&r, "ap-northeast-2");
        assert_eq!(res.values["scanOnPush"], "Yes");
        assert_eq!(res.values["uri"], "1.dkr.ecr.r.amazonaws.com/api");
        assert!(res.console_url.unwrap().contains("/private/1/api"));
    }
}
```

- [ ] **Step 3: secretsmanager.rs 작성**

`src-tauri/src/adapters/secretsmanager.rs`:
```rust
use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_secretsmanager::types::SecretListEntry;

use super::util::{dt, region, s, unknown_type, url_encode, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

/// 메타데이터만 조회한다. GetSecretValue는 절대 호출하지 않는다.
pub struct SecretsManager;

#[async_trait]
impl ResourceAdapter for SecretsManager {
    fn service_id(&self) -> &'static str {
        "secretsmanager"
    }
    fn display_name(&self) -> &'static str {
        "Secrets Manager"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "secrets",
            name: "Secrets",
            columns: vec![
                col("name", "Name", Text),
                col("description", "Description", Text),
                col("lastChanged", "Last changed", Datetime),
                col("rotation", "Rotation", Text),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "secrets" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_secretsmanager::Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        let mut pages = client.list_secrets().into_paginator().send();
        'pages: while let Some(page) = pages.next().await {
            let page = page.map_err(|e| from_sdk(e, "secretsmanager:ListSecrets"))?;
            for sec in page.secret_list() {
                if !out.push(secret(sec, &region)) {
                    break 'pages;
                }
            }
        }
        Ok(out.finish())
    }
}

fn secret(sec: &SecretListEntry, region: &str) -> Resource {
    let name = s(sec.name());
    Resource::new(s(sec.arn()), &name)
        .arn(sec.arn())
        .value("name", &name)
        .value("description", s(sec.description()))
        .value("lastChanged", dt(sec.last_changed_date()))
        .value("rotation", if sec.rotation_enabled() == Some(true) { "Enabled" } else { "Disabled" })
        .field("Last accessed", dt(sec.last_accessed_date()))
        .field("Created", dt(sec.created_date()))
        .field("KMS key", s(sec.kms_key_id()))
        .tags(sec.tags().iter().map(|t| (t.key(), t.value())))
        .raw(sec)
        .console(format!(
            "https://{region}.console.aws.amazon.com/secretsmanager/secret?name={}&region={region}",
            url_encode(&name)
        ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_secretsmanager::types::Tag;

    #[test]
    fn secret_metadata_only() {
        let sec = SecretListEntry::builder()
            .name("prod/db/password")
            .arn("arn:aws:secretsmanager:r:1:secret:prod/db/password-abc")
            .rotation_enabled(true)
            .tags(Tag::builder().key("team").value("platform").build())
            .build();
        let r = secret(&sec, "ap-northeast-2");
        assert_eq!(r.name, "prod/db/password");
        assert_eq!(r.values["rotation"], "Enabled");
        assert_eq!(r.tags["team"], "platform");
        assert!(r.console_url.unwrap().contains("name=prod%2Fdb%2Fpassword"));
    }
}
```

- [ ] **Step 4: 레지스트리 최종 순서 테스트 추가 (실패 확인)**

`adapters/mod.rs`의 `tests` 모듈에 추가:
```rust
    #[test]
    fn registry_has_all_services_in_display_order() {
        let ids: Vec<_> = registry().iter().map(|a| a.service_id()).collect();
        assert_eq!(
            ids,
            vec![
                "ec2", "s3", "lambda", "rds", "ecs", "eks", "vpc", "iam", "dynamodb", "logs", "cloudfront", "sqs",
                "sns", "ecr", "route53", "secretsmanager"
            ]
        );
    }

    #[test]
    fn every_service_has_types_with_name_or_id_column() {
        for a in registry() {
            let types = a.resource_types();
            assert!(!types.is_empty(), "{} has no types", a.service_id());
            for t in types {
                assert!(
                    t.columns.first().is_some_and(|c| c.key == "name" || c.key == "id"),
                    "{}/{} first column must be name or id",
                    a.service_id(),
                    t.id
                );
            }
        }
    }
```

Run: `cd src-tauri && cargo test registry_has_all`
Expected: FAIL (ecr, secretsmanager 미등록 / 순서 불일치).

- [ ] **Step 5: mod 선언과 registry 확정**

`adapters/mod.rs` 상단 모듈 선언을 다음으로 교체:
```rust
pub mod cloudfront;
pub mod dynamodb;
pub mod ec2;
pub mod ecr;
pub mod ecs;
pub mod eks;
pub mod iam;
pub mod lambda;
pub mod logs;
pub mod rds;
pub mod route53;
pub mod s3;
pub mod secretsmanager;
pub mod sns;
pub mod sqs;
pub mod util;
pub mod vpc;
```

`registry()`를 교체:
```rust
pub fn registry() -> Vec<AdapterRef> {
    vec![
        Arc::new(ec2::Ec2),
        Arc::new(s3::S3),
        Arc::new(lambda::Lambda),
        Arc::new(rds::Rds),
        Arc::new(ecs::Ecs),
        Arc::new(eks::Eks),
        Arc::new(vpc::Vpc),
        Arc::new(iam::Iam),
        Arc::new(dynamodb::DynamoDb),
        Arc::new(logs::Logs),
        Arc::new(cloudfront::CloudFront),
        Arc::new(sqs::Sqs),
        Arc::new(sns::Sns),
        Arc::new(ecr::Ecr),
        Arc::new(route53::Route53),
        Arc::new(secretsmanager::SecretsManager),
    ]
}
```

- [ ] **Step 6: 전체 테스트, 빌드, GetSecretValue 미사용 확인**

Run: `cd src-tauri && cargo test && cargo build && ! grep -rn "get_secret_value" src/`
Expected: 모든 테스트 PASS, 빌드 성공, grep 결과 없음(명령 종료 코드 0).

- [ ] **Step 7: Commit**

```bash
git add src-tauri
git commit -m "feat(backend): add ECR and Secrets Manager adapters, finalize registry"
```

---

### Task 15: 프론트엔드 API 계층과 포맷 유틸

**Files:**
- Create: `src/api/types.ts`, `src/api/client.ts`, `src/api/errors.ts`, `src/api/desktop.ts`, `src/api/queries.ts`
- Create: `src/lib/format.ts`, `src/lib/regions.ts`
- Test: `src/lib/format.test.ts`, `src/api/errors.test.ts`

**Interfaces:**
- Consumes: Tauri 커맨드 (Task 5, 7)
- Produces:
  - `src/api/types.ts`: `ColumnKind, Column, ResourceType, ServiceInfo, Field, Resource, ListResult, ProfileInfo, Favorite, Settings, S3Entry, S3Listing, AppError`
  - `src/api/client.ts`: `api.{listProfiles, getAccount, listServices, listResources, listS3Objects, ssoLogin, getSettings, saveSettings}`
  - `src/api/errors.ts`: `isAppError(e): e is AppError`, `errorMessage(e): string`
  - `src/api/desktop.ts`: `desktop.{openUrl(url), copy(text)}`
  - `src/api/queries.ts`: `GLOBAL`, `resourcesKey`, `useServices`, `useProfiles`, `useAccount`, `useResources`, `useS3Objects`, `useSettings`
  - `src/lib/format.ts`: `formatBytes, formatDate, formatValue, stateColor, compareValues`
  - `src/lib/regions.ts`: `REGIONS: string[]`

- [ ] **Step 1: 타입과 API 래퍼 작성**

`src/api/types.ts`:
```ts
export type ColumnKind = "text" | "mono" | "state" | "datetime" | "bytes";

export interface Column {
  key: string;
  label: string;
  kind: ColumnKind;
}

export interface ResourceType {
  id: string;
  name: string;
  columns: Column[];
}

export interface ServiceInfo {
  id: string;
  name: string;
  global: boolean;
  types: ResourceType[];
}

export interface Field {
  label: string;
  value: string;
}

export interface Resource {
  id: string;
  name: string;
  arn: string | null;
  values: Record<string, string>;
  tags: Record<string, string>;
  fields: Field[];
  raw: string;
  consoleUrl: string | null;
}

export interface ListResult {
  items: Resource[];
  truncated: boolean;
}

export interface ProfileInfo {
  name: string;
  region: string | null;
}

/** 즐겨찾기이자 사이드바 선택 상태 */
export interface Favorite {
  service: string;
  type: string;
}

export interface Settings {
  enabledServices: string[];
  favorites: Favorite[];
  lastProfile: string | null;
  lastRegion: string | null;
}

export interface S3Entry {
  name: string;
  key: string;
  isFolder: boolean;
  size: number | null;
  lastModified: string | null;
  storageClass: string | null;
}

export interface S3Listing {
  entries: S3Entry[];
  nextToken: string | null;
}

export type AppError =
  | { kind: "ssoExpired" }
  | { kind: "accessDenied"; action: string }
  | { kind: "throttled" }
  | { kind: "network"; message: string }
  | { kind: "other"; message: string };
```

`src/api/client.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";
import type { ListResult, ProfileInfo, S3Listing, ServiceInfo, Settings } from "./types";

export const api = {
  listProfiles: () => invoke<ProfileInfo[]>("list_profiles"),
  getAccount: (profile: string) => invoke<string>("get_account", { profile }),
  listServices: () => invoke<ServiceInfo[]>("list_services"),
  listResources: (profile: string, region: string, service: string, typeId: string) =>
    invoke<ListResult>("list_resources", { profile, region, service, typeId }),
  listS3Objects: (profile: string, region: string, bucket: string, prefix: string, continuationToken: string | null) =>
    invoke<S3Listing>("list_s3_objects", { profile, region, bucket, prefix, continuationToken }),
  ssoLogin: (profile: string) => invoke<void>("sso_login", { profile }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
};
```

`src/api/desktop.ts`:
```ts
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";

export const desktop = {
  openUrl: (url: string) => openUrl(url),
  copy: (text: string) => writeText(text),
};
```

`src/lib/regions.ts`:
```ts
export const REGIONS = [
  "ap-northeast-2",
  "ap-northeast-1",
  "ap-northeast-3",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-south-1",
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-central-1",
  "eu-north-1",
  "sa-east-1",
];
```

- [ ] **Step 2: 실패하는 테스트 작성**

`src/lib/format.test.ts`:
```ts
import { compareValues, formatBytes, formatDate, formatValue, stateColor } from "./format";

test("formatBytes", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(1048576)).toBe("1.0 MB");
});

test("formatDate uses local time and falls back on invalid input", () => {
  const iso = new Date(2026, 9, 26, 14, 5).toISOString();
  expect(formatDate(iso)).toBe("2026-10-26 14:05");
  expect(formatDate("not a date")).toBe("not a date");
});

test("formatValue by kind", () => {
  expect(formatValue("bytes", "2048")).toBe("2.0 KB");
  expect(formatValue("bytes", "abc")).toBe("abc");
  expect(formatValue("text", "x")).toBe("x");
  expect(formatValue("datetime", "")).toBe("");
  expect(formatValue("text", undefined)).toBe("");
});

test("stateColor", () => {
  expect(stateColor("running")).toBe("green");
  expect(stateColor("ACTIVE")).toBe("green");
  expect(stateColor("stopped")).toBe("red");
  expect(stateColor("pending")).toBe("yellow");
  expect(stateColor("weird")).toBe("gray");
});

test("compareValues sorts numbers numerically and text by locale", () => {
  expect(["10", "9", "100"].sort(compareValues)).toEqual(["9", "10", "100"]);
  expect(["b", "a", "C"].sort(compareValues)).toEqual(["a", "b", "C"]);
  expect(["", "1"].sort(compareValues)).toEqual(["", "1"]);
});
```

`src/api/errors.test.ts`:
```ts
import { errorMessage, isAppError } from "./errors";

test("isAppError detects tagged errors", () => {
  expect(isAppError({ kind: "throttled" })).toBe(true);
  expect(isAppError("boom")).toBe(false);
  expect(isAppError(null)).toBe(false);
});

test("errorMessage", () => {
  expect(errorMessage({ kind: "ssoExpired" })).toBe("SSO 세션이 만료됐어요");
  expect(errorMessage({ kind: "accessDenied", action: "ec2:DescribeInstances" })).toBe("권한 없음 (ec2:DescribeInstances)");
  expect(errorMessage({ kind: "throttled" })).toBe("요청이 너무 많아요. 잠시 후 다시 시도하세요");
  expect(errorMessage({ kind: "network", message: "timeout" })).toBe("네트워크 오류: timeout");
  expect(errorMessage({ kind: "other", message: "bad" })).toBe("bad");
  expect(errorMessage(new Error("plain"))).toBe("plain");
  expect(errorMessage("text")).toBe("text");
});
```

Run: `npm test`
Expected: FAIL — `./format`, `./errors` 모듈 없음.

- [ ] **Step 3: 구현**

`src/lib/format.ts`:
```ts
import type { ColumnKind } from "../api/types";

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatValue(kind: ColumnKind, raw: string | undefined): string {
  if (!raw) return "";
  if (kind === "bytes") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : formatBytes(n);
  }
  if (kind === "datetime") return formatDate(raw);
  return raw;
}

const GREEN = ["running", "available", "active", "in-use", "enabled", "deployed", "issued", "succeeded"];
const RED = ["stopped", "stopping", "failed", "deleted", "deleting", "error", "inactive", "disabled", "terminated", "shutting-down"];
const YELLOW = ["pending", "creating", "updating", "modifying", "provisioning", "inprogress", "in progress", "backing-up", "draining"];

export function stateColor(state: string): "green" | "red" | "yellow" | "gray" {
  const s = state.toLowerCase();
  if (GREEN.includes(s)) return "green";
  if (RED.includes(s)) return "red";
  if (YELLOW.includes(s)) return "yellow";
  return "gray";
}

export function compareValues(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a !== "" && b !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b, "ko", { sensitivity: "base" });
}
```

`src/api/errors.ts`:
```ts
import type { AppError } from "./types";

export function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "kind" in e;
}

export function errorMessage(e: unknown): string {
  if (isAppError(e)) {
    switch (e.kind) {
      case "ssoExpired":
        return "SSO 세션이 만료됐어요";
      case "accessDenied":
        return `권한 없음 (${e.action})`;
      case "throttled":
        return "요청이 너무 많아요. 잠시 후 다시 시도하세요";
      case "network":
        return `네트워크 오류: ${e.message}`;
      case "other":
        return e.message;
    }
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
```

- [ ] **Step 4: 쿼리 훅 작성**

`src/api/queries.ts`:
```ts
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { AppError, ListResult, ServiceInfo, Settings } from "./types";

export const GLOBAL = "global";

export function resourcesKey(profile: string, region: string, service: ServiceInfo, typeId: string) {
  return ["resources", profile, service.global ? GLOBAL : region, service.id, typeId] as const;
}

export function useServices() {
  return useQuery({ queryKey: ["services"], queryFn: api.listServices, staleTime: Infinity });
}

export function useProfiles() {
  return useQuery({ queryKey: ["profiles"], queryFn: api.listProfiles, staleTime: Infinity });
}

export function useAccount(profile: string | null) {
  return useQuery({
    queryKey: ["account", profile],
    queryFn: () => api.getAccount(profile!),
    enabled: !!profile,
    staleTime: Infinity,
    retry: false,
  });
}

/** fetch=false면 호출하지 않고 캐시된 값만 돌려준다(즐겨찾기 개수 표시용). */
export function useResources(profile: string | null, region: string, service: ServiceInfo, typeId: string, fetch = true) {
  return useQuery<ListResult, AppError>({
    queryKey: resourcesKey(profile ?? "", region, service, typeId),
    queryFn: () => api.listResources(profile!, region, service.id, typeId),
    enabled: fetch && !!profile,
    staleTime: Infinity,
    retry: false,
  });
}

export function useS3Objects(profile: string, region: string, bucket: string, prefix: string) {
  return useInfiniteQuery({
    queryKey: ["s3", profile, bucket, prefix],
    queryFn: ({ pageParam }) => api.listS3Objects(profile, region, bucket, prefix, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextToken,
    staleTime: Infinity,
    retry: false,
  });
}

export function useSettings() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["settings"], queryFn: api.getSettings, staleTime: Infinity });
  const update = (patch: Partial<Settings>) => {
    const current = qc.getQueryData<Settings>(["settings"]);
    if (!current) return;
    const next = { ...current, ...patch };
    qc.setQueryData(["settings"], next);
    void api.saveSettings(next);
  };
  return { settings: query.data, update };
}
```

- [ ] **Step 5: 테스트와 타입 체크**

Run: `npm test && npx tsc --noEmit`
Expected: format 5개, errors 2개, App 스모크 1개 PASS. 타입 오류 없음.

- [ ] **Step 6: Commit**

```bash
git add src
git commit -m "feat(frontend): add API layer, query hooks, and formatting utils"
```

---

### Task 16: 공통 컴포넌트 — 배지, 셀, 리소스 표

**Files:**
- Create: `src/components/ServiceBadge.tsx`, `src/components/Cell.tsx`, `src/components/ResourceTable.tsx`
- Create: `src/test/utils.tsx`
- Test: `src/components/ResourceTable.test.tsx`

**Interfaces:**
- Consumes: `types.ts`, `format.ts`
- Produces:
  - `ServiceBadge({ service }: { service: { id: string; name: string } })`
  - `Cell({ kind, value }: { kind: ColumnKind; value: string | undefined })`
  - `ResourceTable({ columns, items, filter, selectedId, onSelect, onOpen }: { columns: Column[]; items: Resource[]; filter: string; selectedId: string | null; onSelect(id: string): void; onOpen(id: string): void })` — 헤더 클릭 정렬, 이름/ID 필터, ↑↓ 이동, Enter/더블클릭 열기
  - `src/test/utils.tsx`: `renderWithClient(ui)`, `makeResource(id, values, extra?)`, `sampleServices`

- [ ] **Step 1: 테스트 유틸 작성**

`src/test/utils.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import type { Resource, ServiceInfo } from "../api/types";

export function renderWithClient(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { qc, ...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>) };
}

export function makeResource(id: string, values: Record<string, string>, extra: Partial<Resource> = {}): Resource {
  return { id, name: values.name ?? id, arn: null, values, tags: {}, fields: [], raw: "", consoleUrl: null, ...extra };
}

export const sampleServices: ServiceInfo[] = [
  {
    id: "ec2",
    name: "EC2",
    global: false,
    types: [
      {
        id: "instances",
        name: "Instances",
        columns: [
          { key: "name", label: "Name", kind: "text" },
          { key: "id", label: "Instance ID", kind: "mono" },
          { key: "state", label: "State", kind: "state" },
        ],
      },
      { id: "volumes", name: "Volumes", columns: [{ key: "name", label: "Name", kind: "text" }] },
    ],
  },
  {
    id: "s3",
    name: "S3",
    global: true,
    types: [
      {
        id: "buckets",
        name: "Buckets",
        columns: [
          { key: "name", label: "Bucket name", kind: "text" },
          { key: "region", label: "Region", kind: "text" },
        ],
      },
    ],
  },
  { id: "iam", name: "IAM", global: true, types: [{ id: "users", name: "Users", columns: [{ key: "name", label: "Name", kind: "text" }] }] },
];
```

- [ ] **Step 2: 실패하는 테스트 작성**

`src/components/ResourceTable.test.tsx`:
```tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ResourceTable } from "./ResourceTable";
import { makeResource, sampleServices } from "../test/utils";

const columns = sampleServices[0].types[0].columns;
const items = [
  makeResource("i-2", { name: "web-2", id: "i-2", state: "stopped" }),
  makeResource("i-1", { name: "web-1", id: "i-1", state: "running" }),
  makeResource("i-3", { name: "batch", id: "i-3", state: "running" }),
];

function rowNames() {
  return screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent);
}

test("sorts by first column ascending, toggles on header click", () => {
  render(<ResourceTable columns={columns} items={items} filter="" selectedId={null} onSelect={() => {}} onOpen={() => {}} />);
  expect(rowNames()).toEqual(["batch", "web-1", "web-2"]);
  fireEvent.click(screen.getByRole("columnheader", { name: /Name/ }));
  expect(rowNames()).toEqual(["web-2", "web-1", "batch"]);
  fireEvent.click(screen.getByRole("columnheader", { name: /State/ }));
  expect(rowNames()[0]).toMatch(/batch|web-1/);
});

test("filters by name or id, case-insensitive", () => {
  render(<ResourceTable columns={columns} items={items} filter="WEB" selectedId={null} onSelect={() => {}} onOpen={() => {}} />);
  expect(rowNames()).toEqual(["web-1", "web-2"]);
});

test("filters by id", () => {
  render(<ResourceTable columns={columns} items={items} filter="i-3" selectedId={null} onSelect={() => {}} onOpen={() => {}} />);
  expect(rowNames()).toEqual(["batch"]);
});

test("click selects, double click opens", () => {
  const onSelect = vi.fn();
  const onOpen = vi.fn();
  render(<ResourceTable columns={columns} items={items} filter="" selectedId={null} onSelect={onSelect} onOpen={onOpen} />);
  const row = screen.getByText("web-1").closest("tr")!;
  fireEvent.click(row);
  expect(onSelect).toHaveBeenCalledWith("i-1");
  fireEvent.doubleClick(row);
  expect(onOpen).toHaveBeenCalledWith("i-1");
});

test("arrow keys move selection in sorted order, Enter opens", () => {
  const onSelect = vi.fn();
  const onOpen = vi.fn();
  render(<ResourceTable columns={columns} items={items} filter="" selectedId="i-3" onSelect={onSelect} onOpen={onOpen} />);
  const table = screen.getByTestId("resource-table");
  fireEvent.keyDown(table, { key: "ArrowDown" });
  expect(onSelect).toHaveBeenLastCalledWith("i-1");
  fireEvent.keyDown(table, { key: "ArrowUp" });
  expect(onSelect).toHaveBeenLastCalledWith("i-3");
  fireEvent.keyDown(table, { key: "Enter" });
  expect(onOpen).toHaveBeenCalledWith("i-3");
});

test("selected row is marked", () => {
  render(<ResourceTable columns={columns} items={items} filter="" selectedId="i-2" onSelect={() => {}} onOpen={() => {}} />);
  expect(screen.getByText("web-2").closest("tr")).toHaveAttribute("aria-selected", "true");
});

test("shows empty message when nothing matches", () => {
  render(<ResourceTable columns={columns} items={items} filter="zzz" selectedId={null} onSelect={() => {}} onOpen={() => {}} />);
  expect(screen.getByText("표시할 리소스가 없어요")).toBeInTheDocument();
});
```

Run: `npm test -- ResourceTable`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`src/components/ServiceBadge.tsx`:
```tsx
const COLORS: Record<string, string> = {
  ec2: "#f58536",
  s3: "#3f8624",
  lambda: "#ed7100",
  rds: "#3b48cc",
  ecs: "#ed7100",
  eks: "#ed7100",
  vpc: "#8c4fff",
  iam: "#dd344c",
  dynamodb: "#3b48cc",
  logs: "#e7157b",
  cloudfront: "#8c4fff",
  sqs: "#e7157b",
  sns: "#e7157b",
  ecr: "#ed7100",
  route53: "#8c4fff",
  secretsmanager: "#dd344c",
};

export function ServiceBadge({ service }: { service: { id: string; name: string } }) {
  return (
    <span className="badge" style={{ background: COLORS[service.id] ?? "#666" }} aria-hidden="true">
      {service.name.slice(0, 2).toUpperCase()}
    </span>
  );
}
```

`src/components/Cell.tsx`:
```tsx
import type { ColumnKind } from "../api/types";
import { formatValue, stateColor } from "../lib/format";

export function Cell({ kind, value }: { kind: ColumnKind; value: string | undefined }) {
  const text = formatValue(kind, value);
  if (kind === "state" && text) {
    return (
      <>
        <span className={`dot ${stateColor(text)}`} />
        {text}
      </>
    );
  }
  if (kind === "mono") return <span className="mono">{text}</span>;
  return <>{text}</>;
}
```

`src/components/ResourceTable.tsx`:
```tsx
import { useMemo, useState, type KeyboardEvent } from "react";
import type { Column, Resource } from "../api/types";
import { compareValues } from "../lib/format";
import { Cell } from "./Cell";

interface Props {
  columns: Column[];
  items: Resource[];
  filter: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}

export function ResourceTable({ columns, items, filter, selectedId, onSelect, onOpen }: Props) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: columns[0]?.key ?? "", dir: 1 });

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const filtered = f
      ? items.filter((r) => r.name.toLowerCase().includes(f) || r.id.toLowerCase().includes(f))
      : items;
    return [...filtered].sort((a, b) => compareValues(a.values[sort.key] ?? "", b.values[sort.key] ?? "") * sort.dir);
  }, [items, filter, sort]);

  const toggleSort = (key: string) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && selectedId) {
      onOpen(selectedId);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = rows.findIndex((r) => r.id === selectedId);
    const next = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
    if (rows[next]) onSelect(rows[next].id);
  };

  return (
    <div className="tbl" tabIndex={0} onKeyDown={onKeyDown} data-testid="resource-table">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} onClick={() => toggleSort(c.key)}>
                {c.label} {sort.key === c.key ? (sort.dir === 1 ? "▲" : "▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className={r.id === selectedId ? "on" : undefined}
              aria-selected={r.id === selectedId}
              onClick={() => onSelect(r.id)}
              onDoubleClick={() => onOpen(r.id)}
            >
              {columns.map((c) => (
                <td key={c.key}>
                  <Cell kind={c.kind} value={r.values[c.key]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="empty small">표시할 리소스가 없어요</div>}
    </div>
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- ResourceTable`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(frontend): add sortable, filterable resource table"
```

---

### Task 17: 사이드바와 서비스 설정 창

**Files:**
- Create: `src/components/Sidebar.tsx`, `src/components/ServiceSettings.tsx`
- Test: `src/components/Sidebar.test.tsx`, `src/components/ServiceSettings.test.tsx`

**Interfaces:**
- Consumes: `useResources` (queries.ts), `ServiceBadge`, `api` (테스트에서 mock)
- Produces:
  - `Sidebar({ services, profile, region, selection, favorites, onSelect, onToggleFavorite })` — `services`는 이미 활성화된 것만 전달. 서비스 클릭 시 펼침/접힘, 펼친 서비스의 타입별 개수 조회, 타입 우클릭으로 즐겨찾기 토글
  - `ServiceSettings({ services, enabled, onChange, onClose })` — `onChange(ids: string[])`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/components/Sidebar.test.tsx`:
```tsx
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { makeResource, renderWithClient, sampleServices } from "../test/utils";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: { listResources: vi.fn() },
}));

const listResources = vi.mocked(api.listResources);

beforeEach(() => {
  listResources.mockReset();
  listResources.mockResolvedValue({ items: [makeResource("a", {}), makeResource("b", {})], truncated: false });
});

const base = {
  services: sampleServices,
  profile: "prod",
  region: "ap-northeast-2",
  selection: null,
  favorites: [],
  onSelect: () => {},
  onToggleFavorite: () => {},
};

test("shows services collapsed and fetches counts only when expanded", async () => {
  renderWithClient(<Sidebar {...base} />);
  expect(screen.getByText("EC2")).toBeInTheDocument();
  expect(screen.queryByText("Instances")).not.toBeInTheDocument();
  expect(listResources).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText("EC2"));
  expect(screen.getByText("Instances")).toBeInTheDocument();
  await waitFor(() => expect(listResources).toHaveBeenCalledWith("prod", "ap-northeast-2", "ec2", "instances"));
  expect(listResources).toHaveBeenCalledWith("prod", "ap-northeast-2", "ec2", "volumes");
  await waitFor(() => expect(screen.getAllByText("2")).toHaveLength(2));
});

test("shows dash when count fetch fails", async () => {
  listResources.mockRejectedValue({ kind: "accessDenied", action: "iam:ListUsers" });
  renderWithClient(<Sidebar {...base} />);
  fireEvent.click(screen.getByText("IAM"));
  await waitFor(() => expect(screen.getByText("—")).toBeInTheDocument());
});

test("selected service starts expanded and clicking type selects", () => {
  const onSelect = vi.fn();
  renderWithClient(<Sidebar {...base} selection={{ service: "ec2", type: "volumes" }} onSelect={onSelect} />);
  expect(screen.getByText("Volumes").closest("[role=button]")).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByText("Instances"));
  expect(onSelect).toHaveBeenCalledWith({ service: "ec2", type: "instances" });
});

test("right click toggles favorite and favorites section lists entries", () => {
  const onToggleFavorite = vi.fn();
  renderWithClient(
    <Sidebar {...base} favorites={[{ service: "s3", type: "buckets" }]} onToggleFavorite={onToggleFavorite} />,
  );
  expect(screen.getByText("즐겨찾기")).toBeInTheDocument();
  expect(screen.getByText("S3 › Buckets")).toBeInTheDocument();
  fireEvent.contextMenu(screen.getByText("S3 › Buckets"));
  expect(onToggleFavorite).toHaveBeenCalledWith({ service: "s3", type: "buckets" });
  // 즐겨찾기 행은 조회를 일으키지 않는다
  expect(listResources).not.toHaveBeenCalled();
});

test("favorite of a disabled service is hidden", () => {
  renderWithClient(<Sidebar {...base} favorites={[{ service: "lambda", type: "functions" }]} />);
  expect(screen.queryByText("즐겨찾기")).not.toBeInTheDocument();
});
```

`src/components/ServiceSettings.test.tsx`:
```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { ServiceSettings } from "./ServiceSettings";
import { sampleServices } from "../test/utils";

test("toggling checkboxes reports new enabled list", () => {
  const onChange = vi.fn();
  render(<ServiceSettings services={sampleServices} enabled={["ec2"]} onChange={onChange} onClose={() => {}} />);
  expect(screen.getByLabelText(/EC2/)).toBeChecked();
  expect(screen.getByLabelText(/IAM/)).not.toBeChecked();
  fireEvent.click(screen.getByLabelText(/IAM/));
  expect(onChange).toHaveBeenLastCalledWith(["ec2", "iam"]);
  fireEvent.click(screen.getByLabelText(/EC2/));
  expect(onChange).toHaveBeenLastCalledWith([]);
});

test("done button and backdrop close the sheet", () => {
  const onClose = vi.fn();
  render(<ServiceSettings services={sampleServices} enabled={[]} onChange={() => {}} onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "완료" }));
  fireEvent.click(screen.getByTestId("modal-backdrop"));
  expect(onClose).toHaveBeenCalledTimes(2);
});
```

Run: `npm test -- Sidebar ServiceSettings`
Expected: FAIL — 모듈 없음.

- [ ] **Step 2: Sidebar 구현**

`src/components/Sidebar.tsx`:
```tsx
import { useState } from "react";
import { useResources } from "../api/queries";
import type { Favorite, ResourceType, ServiceInfo } from "../api/types";
import { ServiceBadge } from "./ServiceBadge";

interface Props {
  services: ServiceInfo[];
  profile: string | null;
  region: string;
  selection: Favorite | null;
  favorites: Favorite[];
  onSelect: (sel: Favorite) => void;
  onToggleFavorite: (sel: Favorite) => void;
}

export function Sidebar({ services, profile, region, selection, favorites, onSelect, onToggleFavorite }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(selection ? [selection.service] : []));

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const select = (sel: Favorite) => {
    setExpanded((prev) => new Set(prev).add(sel.service));
    onSelect(sel);
  };

  const isSelected = (svc: ServiceInfo, t: ResourceType) =>
    selection?.service === svc.id && selection?.type === t.id;

  const favRows = favorites.flatMap((f) => {
    const svc = services.find((s) => s.id === f.service);
    const type = svc?.types.find((t) => t.id === f.type);
    return svc && type ? [{ svc, type }] : [];
  });

  const rowProps = { profile, region, onSelect: select, onToggleFavorite };

  return (
    <nav className="side" aria-label="서비스">
      {favRows.length > 0 && (
        <>
          <div className="grp">즐겨찾기</div>
          {favRows.map(({ svc, type }) => (
            <TypeRow
              key={`fav-${svc.id}-${type.id}`}
              label={`${svc.name} › ${type.name}`}
              service={svc}
              type={type}
              fetch={false}
              selected={false}
              fav
              {...rowProps}
            />
          ))}
        </>
      )}
      <div className="grp">서비스</div>
      {services.map((svc) => (
        <div key={svc.id}>
          <div className="svc" role="button" onClick={() => toggle(svc.id)}>
            <span className="tw">{expanded.has(svc.id) ? "▼" : "▶"}</span>
            <ServiceBadge service={svc} />
            {svc.name}
          </div>
          {expanded.has(svc.id) &&
            svc.types.map((t) => (
              <TypeRow key={t.id} label={t.name} service={svc} type={t} fetch selected={isSelected(svc, t)} {...rowProps} />
            ))}
        </div>
      ))}
    </nav>
  );
}

interface RowProps {
  label: string;
  service: ServiceInfo;
  type: ResourceType;
  fetch: boolean;
  selected: boolean;
  fav?: boolean;
  profile: string | null;
  region: string;
  onSelect: (sel: Favorite) => void;
  onToggleFavorite: (sel: Favorite) => void;
}

function TypeRow({ label, service, type, fetch, selected, fav, profile, region, onSelect, onToggleFavorite }: RowProps) {
  const q = useResources(profile, region, service, type.id, fetch);
  const count = q.data
    ? `${q.data.items.length}${q.data.truncated ? "+" : ""}`
    : q.isError
      ? "—"
      : q.isFetching
        ? "…"
        : "";
  const sel = { service: service.id, type: type.id };
  return (
    <div
      className={`typ${fav ? " fav" : ""}${selected ? " on" : ""}`}
      role="button"
      aria-current={selected || undefined}
      title="우클릭: 즐겨찾기 추가/제거"
      onClick={() => onSelect(sel)}
      onContextMenu={(e) => {
        e.preventDefault();
        onToggleFavorite(sel);
      }}
    >
      <span>{label}</span>
      <span className="count">{count}</span>
    </div>
  );
}
```

- [ ] **Step 3: ServiceSettings 구현**

`src/components/ServiceSettings.tsx`:
```tsx
import type { ServiceInfo } from "../api/types";
import { ServiceBadge } from "./ServiceBadge";

interface Props {
  services: ServiceInfo[];
  enabled: string[];
  onChange: (ids: string[]) => void;
  onClose: () => void;
}

export function ServiceSettings({ services, enabled, onChange, onClose }: Props) {
  const toggle = (id: string, on: boolean) => onChange(on ? [...enabled, id] : enabled.filter((x) => x !== id));
  return (
    <div
      className="modal"
      data-testid="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-label="표시할 서비스">
        <h3>표시할 서비스</h3>
        <p>체크한 서비스만 사이드바에 나오고 조회해요.</p>
        <div className="grid">
          {services.map((s) => (
            <label key={s.id}>
              <input type="checkbox" checked={enabled.includes(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
              <ServiceBadge service={s} /> {s.name}
            </label>
          ))}
        </div>
        <div className="foot">
          <button className="btn primary" onClick={onClose}>
            완료
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- Sidebar ServiceSettings`
Expected: Sidebar 5개, ServiceSettings 2개 PASS.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(frontend): add sidebar with counts/favorites and service settings"
```

---

### Task 18: 상세 패널, 원본 데이터 모달, 오류 상태

**Files:**
- Create: `src/lib/detail.ts`, `src/components/DetailPanel.tsx`, `src/components/RawModal.tsx`, `src/components/ErrorState.tsx`, `src/hooks/useCopyShortcut.ts`
- Test: `src/lib/detail.test.ts`, `src/components/DetailPanel.test.tsx`, `src/components/ErrorState.test.tsx`

**Interfaces:**
- Consumes: `formatValue`, `formatBytes`, `desktop`, `api.ssoLogin`, `errorMessage`, `isAppError`
- Produces:
  - `interface DetailData { title: string; subtitle: string; rows: Field[]; tags: Record<string,string>; copy: { label: string; value: string } | null; consoleUrl: string | null; raw: string | null }`
  - `resourceDetail(resource: Resource, type: ResourceType, service: ServiceInfo): DetailData`
  - `s3EntryDetail(entry: S3Entry, bucket: string, region: string): DetailData`
  - `DetailPanel({ detail, onShowRaw }: { detail: DetailData | null; onShowRaw(): void })`
  - `RawModal({ title, text, onClose })`
  - `ErrorState({ error, profile, onRetry })`
  - `useCopyShortcut(value: string | null): void` — ⌘C로 `value` 복사(입력란 포커스나 텍스트 선택 중이면 무시)

- [ ] **Step 1: 실패하는 테스트 작성**

`src/lib/detail.test.ts`:
```ts
import { resourceDetail, s3EntryDetail } from "./detail";
import { makeResource, sampleServices } from "../test/utils";

const ec2 = sampleServices[0];

test("resourceDetail builds rows from columns (except name) then fields", () => {
  const r = makeResource(
    "i-1",
    { name: "web", id: "i-1", state: "running" },
    { arn: "arn:aws:ec2:r:1:instance/i-1", fields: [{ label: "AMI", value: "ami-1" }], tags: { env: "prod" }, raw: "Instance {}" },
  );
  const d = resourceDetail(r, ec2.types[0], ec2);
  expect(d.title).toBe("web");
  expect(d.subtitle).toBe("EC2 · Instances");
  expect(d.rows).toEqual([
    { label: "Instance ID", value: "i-1" },
    { label: "State", value: "running" },
    { label: "AMI", value: "ami-1" },
  ]);
  expect(d.copy).toEqual({ label: "ARN", value: "arn:aws:ec2:r:1:instance/i-1" });
  expect(d.tags).toEqual({ env: "prod" });
  expect(d.raw).toBe("Instance {}");
});

test("resourceDetail copies ID when there is no ARN and drops empty rows", () => {
  const d = resourceDetail(makeResource("vol-1", { name: "vol-1", id: "", state: "" }), ec2.types[0], ec2);
  expect(d.copy).toEqual({ label: "ID", value: "vol-1" });
  expect(d.rows).toEqual([]);
  expect(d.raw).toBeNull();
});

test("s3EntryDetail for object and folder", () => {
  const obj = s3EntryDetail(
    { name: "logo.svg", key: "images/logo.svg", isFolder: false, size: 2048, lastModified: null, storageClass: "STANDARD" },
    "assets",
    "ap-northeast-2",
  );
  expect(obj.subtitle).toBe("S3 Object");
  expect(obj.copy).toEqual({ label: "S3 URI", value: "s3://assets/images/logo.svg" });
  expect(obj.rows).toContainEqual({ label: "Size", value: "2.0 KB" });
  expect(obj.consoleUrl).toBe(
    "https://s3.console.aws.amazon.com/s3/object/assets?region=ap-northeast-2&prefix=images%2Flogo.svg",
  );
  const folder = s3EntryDetail(
    { name: "images", key: "images/", isFolder: true, size: null, lastModified: null, storageClass: null },
    "assets",
    "ap-northeast-2",
  );
  expect(folder.subtitle).toBe("S3 Folder");
  expect(folder.consoleUrl).toContain("/s3/buckets/assets?");
});
```

`src/components/DetailPanel.test.tsx`:
```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { DetailPanel } from "./DetailPanel";
import { desktop } from "../api/desktop";
import type { DetailData } from "../lib/detail";

vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));

const detail: DetailData = {
  title: "web",
  subtitle: "EC2 · Instances",
  rows: [{ label: "Instance ID", value: "i-1" }],
  tags: { env: "prod" },
  copy: { label: "ARN", value: "arn:x" },
  consoleUrl: "https://console",
  raw: "raw text",
};

test("empty state", () => {
  render(<DetailPanel detail={null} onShowRaw={() => {}} />);
  expect(screen.getByText("리소스를 선택하세요")).toBeInTheDocument();
});

test("renders rows, tags and actions", () => {
  const onShowRaw = vi.fn();
  render(<DetailPanel detail={detail} onShowRaw={onShowRaw} />);
  expect(screen.getByText("web")).toBeInTheDocument();
  expect(screen.getByText("i-1")).toBeInTheDocument();
  expect(screen.getByText("env=prod")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "복사" }));
  expect(desktop.copy).toHaveBeenCalledWith("arn:x");
  fireEvent.click(screen.getByRole("button", { name: /콘솔에서 열기/ }));
  expect(desktop.openUrl).toHaveBeenCalledWith("https://console");
  fireEvent.click(screen.getByRole("button", { name: "원본 데이터 보기" }));
  expect(onShowRaw).toHaveBeenCalled();
});
```

`src/components/ErrorState.test.tsx`:
```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ErrorState } from "./ErrorState";
import { api } from "../api/client";

vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

test("access denied shows action and no retry button", () => {
  render(<ErrorState error={{ kind: "accessDenied", action: "ec2:DescribeInstances" }} profile="p" onRetry={() => {}} />);
  expect(screen.getByText("권한 없음 (ec2:DescribeInstances)")).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("network error offers retry", () => {
  const onRetry = vi.fn();
  render(<ErrorState error={{ kind: "network", message: "timeout" }} profile="p" onRetry={onRetry} />);
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(onRetry).toHaveBeenCalled();
});

test("sso expired logs in then retries", async () => {
  vi.mocked(api.ssoLogin).mockResolvedValue(undefined);
  const onRetry = vi.fn();
  render(<ErrorState error={{ kind: "ssoExpired" }} profile="prod" onRetry={onRetry} />);
  expect(screen.getByText(/SSO 세션이 만료됐어요/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "로그인" }));
  await waitFor(() => expect(onRetry).toHaveBeenCalled());
  expect(api.ssoLogin).toHaveBeenCalledWith("prod");
});

test("sso login failure is shown", async () => {
  vi.mocked(api.ssoLogin).mockRejectedValue({ kind: "other", message: "aws CLI를 찾을 수 없어요" });
  render(<ErrorState error={{ kind: "ssoExpired" }} profile="prod" onRetry={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "로그인" }));
  expect(await screen.findByText("aws CLI를 찾을 수 없어요")).toBeInTheDocument();
});
```

Run: `npm test -- detail DetailPanel ErrorState`
Expected: FAIL — 모듈 없음.

- [ ] **Step 2: detail.ts 구현**

`src/lib/detail.ts`:
```ts
import type { Field, Resource, ResourceType, S3Entry, ServiceInfo } from "../api/types";
import { formatBytes, formatDate, formatValue } from "./format";

export interface DetailData {
  title: string;
  subtitle: string;
  rows: Field[];
  tags: Record<string, string>;
  copy: { label: string; value: string } | null;
  consoleUrl: string | null;
  raw: string | null;
}

export function resourceDetail(resource: Resource, type: ResourceType, service: ServiceInfo): DetailData {
  const columnRows = type.columns
    .filter((c) => c.key !== "name")
    .map((c) => ({ label: c.label, value: formatValue(c.kind, resource.values[c.key]) }))
    .filter((r) => r.value !== "");
  return {
    title: resource.name,
    subtitle: `${service.name} · ${type.name}`,
    rows: [...columnRows, ...resource.fields],
    tags: resource.tags,
    copy: resource.arn ? { label: "ARN", value: resource.arn } : { label: "ID", value: resource.id },
    consoleUrl: resource.consoleUrl,
    raw: resource.raw || null,
  };
}

export function s3EntryDetail(entry: S3Entry, bucket: string, region: string): DetailData {
  const rows: Field[] = [{ label: "Key", value: entry.key }];
  if (entry.size !== null) rows.push({ label: "Size", value: formatBytes(entry.size) });
  if (entry.storageClass) rows.push({ label: "Storage", value: entry.storageClass });
  if (entry.lastModified) rows.push({ label: "Modified", value: formatDate(entry.lastModified) });
  const prefix = encodeURIComponent(entry.key);
  return {
    title: entry.name,
    subtitle: entry.isFolder ? "S3 Folder" : "S3 Object",
    rows,
    tags: {},
    copy: { label: "S3 URI", value: `s3://${bucket}/${entry.key}` },
    consoleUrl: entry.isFolder
      ? `https://s3.console.aws.amazon.com/s3/buckets/${bucket}?region=${region}&prefix=${prefix}`
      : `https://s3.console.aws.amazon.com/s3/object/${bucket}?region=${region}&prefix=${prefix}`,
    raw: null,
  };
}
```

- [ ] **Step 3: 컴포넌트와 훅 구현**

`src/components/DetailPanel.tsx`:
```tsx
import { Fragment } from "react";
import { desktop } from "../api/desktop";
import type { DetailData } from "../lib/detail";

export function DetailPanel({ detail, onShowRaw }: { detail: DetailData | null; onShowRaw: () => void }) {
  if (!detail) {
    return (
      <aside className="detail">
        <div className="empty">리소스를 선택하세요</div>
      </aside>
    );
  }
  const tags = Object.entries(detail.tags);
  return (
    <aside className="detail">
      <h3>{detail.title}</h3>
      <div className="sub">{detail.subtitle}</div>
      <dl className="kv">
        {detail.rows.map((r) => (
          <Fragment key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </Fragment>
        ))}
      </dl>
      {tags.length > 0 && (
        <>
          <div className="sect">Tags</div>
          <div>
            {tags.map(([k, v]) => (
              <span className="tag" key={k}>
                {k}={v}
              </span>
            ))}
          </div>
        </>
      )}
      {detail.copy && (
        <>
          <div className="sect">{detail.copy.label}</div>
          <div className="mono copyable">
            {detail.copy.value}{" "}
            <button className="link" onClick={() => void desktop.copy(detail.copy!.value)}>
              복사
            </button>
          </div>
        </>
      )}
      {detail.consoleUrl && (
        <button className="btn" onClick={() => void desktop.openUrl(detail.consoleUrl!)}>
          AWS 콘솔에서 열기 ↗
        </button>
      )}
      {detail.raw && (
        <button className="btn" onClick={onShowRaw}>
          원본 데이터 보기
        </button>
      )}
    </aside>
  );
}
```

`src/components/RawModal.tsx`:
```tsx
export function RawModal({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet wide" role="dialog" aria-label={`${title} 원본 데이터`}>
        <h3>{title}</h3>
        <pre className="raw">{text}</pre>
        <div className="foot">
          <button className="btn primary" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
```

`src/components/ErrorState.tsx`:
```tsx
import { useState } from "react";
import { api } from "../api/client";
import { errorMessage, isAppError } from "../api/errors";

export function ErrorState({ error, profile, onRetry }: { error: unknown; profile: string; onRetry: () => void }) {
  const [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  if (isAppError(error) && error.kind === "ssoExpired") {
    const login = async () => {
      setBusy(true);
      setLoginError(null);
      try {
        await api.ssoLogin(profile);
        onRetry();
      } catch (e) {
        setLoginError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="empty">
        <div>
          <p>SSO 세션이 만료됐어요 ({profile})</p>
          <button className="btn primary" disabled={busy} onClick={login}>
            {busy ? "브라우저에서 로그인을 완료하세요…" : "로그인"}
          </button>
          {loginError && <p className="err">{loginError}</p>}
        </div>
      </div>
    );
  }

  const retryable = !(isAppError(error) && error.kind === "accessDenied");
  return (
    <div className="empty">
      <div>
        <p className="err">{errorMessage(error)}</p>
        {retryable && (
          <button className="btn" onClick={onRetry}>
            다시 시도
          </button>
        )}
      </div>
    </div>
  );
}
```

`src/hooks/useCopyShortcut.ts`:
```ts
import { useEffect } from "react";
import { desktop } from "../api/desktop";

export function useCopyShortcut(value: string | null) {
  useEffect(() => {
    if (!value) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.key !== "c") return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (window.getSelection()?.toString() || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      void desktop.copy(value);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [value]);
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- detail DetailPanel ErrorState`
Expected: detail 3개, DetailPanel 2개, ErrorState 4개 PASS.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(frontend): add detail panel, raw data modal, and error states"
```

---

### Task 19: 메인 영역 — 리소스 목록과 S3 탐색

**Files:**
- Create: `src/lib/s3.ts`, `src/components/Breadcrumb.tsx`, `src/components/StatusBar.tsx`, `src/components/ResourceArea.tsx`, `src/components/S3Area.tsx`, `src/components/MainArea.tsx`
- Test: `src/lib/s3.test.ts`, `src/components/ResourceArea.test.tsx`, `src/components/S3Area.test.tsx`

**Interfaces:**
- Consumes: `useResources`, `useS3Objects`, `ResourceTable`, `DetailPanel`, `RawModal`, `ErrorState`, `resourceDetail`, `s3EntryDetail`, `useCopyShortcut`
- Produces:
  - `interface S3Location { bucket: string; region: string; prefix: string }` (in `src/lib/s3.ts`)
  - `prefixSegments(prefix: string): { label: string; prefix: string }[]`, `s3EntryToRow(entry: S3Entry): Resource`, `S3_COLUMNS: Column[]`
  - `Breadcrumb({ service, segments, count })`, `segments: { label: string; onClick?: () => void }[]`
  - `StatusBar({ profile, account, region, updatedAt })`
  - `ResourceArea({ service, type, profile, region, account, filter, onOpenBucket, onRefresh })`
  - `S3Area({ profile, account, location, filter, onNavigate, onBack, onRefresh })` — `onNavigate(prefix: string)`
  - `MainArea({ services, selection, profile, region, account, filter, s3, onS3Change, onRefresh })`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/lib/s3.test.ts`:
```ts
import { prefixSegments, s3EntryToRow } from "./s3";

test("prefixSegments splits nested prefix", () => {
  expect(prefixSegments("")).toEqual([]);
  expect(prefixSegments("images/products/")).toEqual([
    { label: "images", prefix: "images/" },
    { label: "products", prefix: "images/products/" },
  ]);
});

test("s3EntryToRow marks folders and keeps raw size", () => {
  const folder = s3EntryToRow({ name: "images", key: "images/", isFolder: true, size: null, lastModified: null, storageClass: null });
  expect(folder.id).toBe("images/");
  expect(folder.values.name).toBe("📁 images");
  expect(folder.values.kind).toBe("Folder");
  const obj = s3EntryToRow({ name: "a.txt", key: "a.txt", isFolder: false, size: 10, lastModified: "2026-01-01T00:00:00Z", storageClass: null });
  expect(obj.values.name).toBe("📄 a.txt");
  expect(obj.values.size).toBe("10");
  expect(obj.name).toBe("a.txt");
});
```

`src/components/ResourceArea.test.tsx`:
```tsx
import { fireEvent, screen } from "@testing-library/react";
import { ResourceArea } from "./ResourceArea";
import { makeResource, renderWithClient, sampleServices } from "../test/utils";
import { api } from "../api/client";

vi.mock("../api/client", () => ({ api: { listResources: vi.fn(), ssoLogin: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));

const [ec2, s3] = sampleServices;

const props = {
  profile: "prod",
  region: "ap-northeast-2",
  account: "123456789012",
  filter: "",
  onOpenBucket: vi.fn(),
  onRefresh: vi.fn(),
};

test("lists resources and shows detail on selection", async () => {
  vi.mocked(api.listResources).mockResolvedValue({
    items: [makeResource("i-1", { name: "web-1", id: "i-1", state: "running" }, { fields: [{ label: "AMI", value: "ami-9" }] })],
    truncated: false,
  });
  renderWithClient(<ResourceArea {...props} service={ec2} type={ec2.types[0]} />);
  fireEvent.click(await screen.findByText("web-1"));
  expect(screen.getByText("ami-9")).toBeInTheDocument();
  expect(screen.getByText(/prod · 123456789012 · ap-northeast-2/)).toBeInTheDocument();
});

test("shows truncation notice", async () => {
  vi.mocked(api.listResources).mockResolvedValue({ items: [makeResource("a", { name: "a" })], truncated: true });
  renderWithClient(<ResourceArea {...props} service={ec2} type={ec2.types[0]} />);
  expect(await screen.findByText("1,000개까지만 표시해요")).toBeInTheDocument();
});

test("shows error state", async () => {
  vi.mocked(api.listResources).mockRejectedValue({ kind: "accessDenied", action: "ec2:DescribeInstances" });
  renderWithClient(<ResourceArea {...props} service={ec2} type={ec2.types[0]} />);
  expect(await screen.findByText("권한 없음 (ec2:DescribeInstances)")).toBeInTheDocument();
});

test("double clicking a bucket opens it with its region", async () => {
  vi.mocked(api.listResources).mockResolvedValue({
    items: [makeResource("assets", { name: "assets", region: "us-west-2" })],
    truncated: false,
  });
  const onOpenBucket = vi.fn();
  renderWithClient(<ResourceArea {...props} onOpenBucket={onOpenBucket} service={s3} type={s3.types[0]} />);
  fireEvent.doubleClick(await screen.findByText("assets"));
  expect(onOpenBucket).toHaveBeenCalledWith({ bucket: "assets", region: "us-west-2", prefix: "" });
  expect(screen.getByText(/· global/)).toBeInTheDocument();
});
```

`src/components/S3Area.test.tsx`:
```tsx
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { S3Area } from "./S3Area";
import { renderWithClient } from "../test/utils";
import { api } from "../api/client";

vi.mock("../api/client", () => ({ api: { listS3Objects: vi.fn(), ssoLogin: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));

const location = { bucket: "assets", region: "ap-northeast-2", prefix: "images/" };

test("lists entries, navigates into folders and via breadcrumb", async () => {
  vi.mocked(api.listS3Objects).mockResolvedValue({
    entries: [
      { name: "products", key: "images/products/", isFolder: true, size: null, lastModified: null, storageClass: null },
      { name: "logo.svg", key: "images/logo.svg", isFolder: false, size: 12, lastModified: null, storageClass: "STANDARD" },
    ],
    nextToken: null,
  });
  const onNavigate = vi.fn();
  const onBack = vi.fn();
  renderWithClient(
    <S3Area profile="prod" account="1" location={location} filter="" onNavigate={onNavigate} onBack={onBack} onRefresh={() => {}} />,
  );
  expect(api.listS3Objects).toHaveBeenCalledWith("prod", "ap-northeast-2", "assets", "images/", null);
  fireEvent.doubleClick(await screen.findByText("📁 products"));
  expect(onNavigate).toHaveBeenCalledWith("images/products/");
  fireEvent.doubleClick(screen.getByText("📄 logo.svg"));
  expect(onNavigate).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText("📄 logo.svg"));
  expect(screen.getByText("s3://assets/images/logo.svg")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "assets" }));
  expect(onNavigate).toHaveBeenLastCalledWith("");
  fireEvent.click(screen.getByRole("button", { name: "Buckets" }));
  expect(onBack).toHaveBeenCalled();
});

test("loads more pages", async () => {
  vi.mocked(api.listS3Objects)
    .mockResolvedValueOnce({
      entries: [{ name: "a", key: "images/a", isFolder: false, size: 1, lastModified: null, storageClass: null }],
      nextToken: "t1",
    })
    .mockResolvedValueOnce({
      entries: [{ name: "b", key: "images/b", isFolder: false, size: 1, lastModified: null, storageClass: null }],
      nextToken: null,
    });
  renderWithClient(
    <S3Area profile="prod" account="1" location={location} filter="" onNavigate={() => {}} onBack={() => {}} onRefresh={() => {}} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "더 보기" }));
  await waitFor(() => expect(screen.getByText("📄 b")).toBeInTheDocument());
  expect(api.listS3Objects).toHaveBeenLastCalledWith("prod", "ap-northeast-2", "assets", "images/", "t1");
  expect(screen.queryByRole("button", { name: "더 보기" })).not.toBeInTheDocument();
});
```

Run: `npm test -- s3 ResourceArea S3Area`
Expected: FAIL — 모듈 없음.

- [ ] **Step 2: s3.ts, Breadcrumb, StatusBar 구현**

`src/lib/s3.ts`:
```ts
import type { Column, Resource, S3Entry } from "../api/types";

export interface S3Location {
  bucket: string;
  region: string;
  prefix: string;
}

export const S3_COLUMNS: Column[] = [
  { key: "name", label: "Name", kind: "text" },
  { key: "size", label: "Size", kind: "bytes" },
  { key: "kind", label: "Kind", kind: "text" },
  { key: "lastModified", label: "Last modified", kind: "datetime" },
];

export function prefixSegments(prefix: string): { label: string; prefix: string }[] {
  const parts = prefix.split("/").filter(Boolean);
  return parts.map((label, i) => ({ label, prefix: parts.slice(0, i + 1).join("/") + "/" }));
}

export function s3EntryToRow(e: S3Entry): Resource {
  return {
    id: e.key,
    name: e.name,
    arn: null,
    values: {
      name: `${e.isFolder ? "📁" : "📄"} ${e.name}`,
      size: e.size !== null ? String(e.size) : "",
      kind: e.isFolder ? "Folder" : "Object",
      lastModified: e.lastModified ?? "",
    },
    tags: {},
    fields: [],
    raw: "",
    consoleUrl: null,
  };
}
```

`src/components/Breadcrumb.tsx`:
```tsx
import type { ServiceInfo } from "../api/types";
import { ServiceBadge } from "./ServiceBadge";

export interface Segment {
  label: string;
  onClick?: () => void;
}

export function Breadcrumb({ service, segments, count }: { service: ServiceInfo; segments: Segment[]; count?: number }) {
  return (
    <div className="crumb">
      <ServiceBadge service={service} />
      <span>{service.name}</span>
      {segments.map((s, i) => (
        <span key={i}>
          {" › "}
          {s.onClick ? (
            <button className="link crumb-link" onClick={s.onClick}>
              {s.label}
            </button>
          ) : (
            <b>{s.label}</b>
          )}
        </span>
      ))}
      {count !== undefined && <span className="crumb-count">{count}개</span>}
    </div>
  );
}
```

`src/components/StatusBar.tsx`:
```tsx
export function StatusBar({
  profile,
  account,
  region,
  updatedAt,
}: {
  profile: string;
  account: string | undefined;
  region: string;
  updatedAt: number;
}) {
  const time = updatedAt ? new Date(updatedAt).toLocaleTimeString("ko-KR") : "";
  return (
    <div className="status">
      <span>
        {profile} · {account ?? "…"} · {region}
      </span>
      <span>{time && `${time} 새로고침`}</span>
    </div>
  );
}
```

- [ ] **Step 3: ResourceArea, S3Area, MainArea 구현**

`src/components/ResourceArea.tsx`:
```tsx
import { useState } from "react";
import { GLOBAL, useResources } from "../api/queries";
import type { ResourceType, ServiceInfo } from "../api/types";
import { useCopyShortcut } from "../hooks/useCopyShortcut";
import { resourceDetail } from "../lib/detail";
import type { S3Location } from "../lib/s3";
import { Breadcrumb } from "./Breadcrumb";
import { DetailPanel } from "./DetailPanel";
import { ErrorState } from "./ErrorState";
import { RawModal } from "./RawModal";
import { ResourceTable } from "./ResourceTable";
import { StatusBar } from "./StatusBar";

interface Props {
  service: ServiceInfo;
  type: ResourceType;
  profile: string;
  region: string;
  account: string | undefined;
  filter: string;
  onOpenBucket: (loc: S3Location) => void;
  onRefresh: () => void;
}

export function ResourceArea({ service, type, profile, region, account, filter, onOpenBucket, onRefresh }: Props) {
  const q = useResources(profile, region, service, type.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const items = q.data?.items ?? [];
  const selected = items.find((r) => r.id === selectedId) ?? null;
  useCopyShortcut(selected?.id ?? null);

  const open = (id: string) => {
    if (service.id !== "s3" || type.id !== "buckets") return;
    const bucket = items.find((r) => r.id === id);
    if (bucket) onOpenBucket({ bucket: bucket.id, region: bucket.values.region || region, prefix: "" });
  };

  return (
    <>
      <section className="center">
        <Breadcrumb service={service} segments={[{ label: type.name }]} count={q.data ? items.length : undefined} />
        {q.data?.truncated && <div className="notice">1,000개까지만 표시해요</div>}
        {q.isError ? (
          <ErrorState error={q.error} profile={profile} onRetry={onRefresh} />
        ) : q.isPending ? (
          <div className="empty">불러오는 중…</div>
        ) : (
          <ResourceTable
            columns={type.columns}
            items={items}
            filter={filter}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onOpen={open}
          />
        )}
        <StatusBar profile={profile} account={account} region={service.global ? GLOBAL : region} updatedAt={q.dataUpdatedAt} />
      </section>
      <DetailPanel detail={selected ? resourceDetail(selected, type, service) : null} onShowRaw={() => setShowRaw(true)} />
      {showRaw && selected && <RawModal title={selected.name} text={selected.raw} onClose={() => setShowRaw(false)} />}
    </>
  );
}
```

`src/components/S3Area.tsx`:
```tsx
import { useState } from "react";
import { useS3Objects } from "../api/queries";
import type { ServiceInfo } from "../api/types";
import { useCopyShortcut } from "../hooks/useCopyShortcut";
import { s3EntryDetail } from "../lib/detail";
import { prefixSegments, s3EntryToRow, S3_COLUMNS, type S3Location } from "../lib/s3";
import { Breadcrumb, type Segment } from "./Breadcrumb";
import { DetailPanel } from "./DetailPanel";
import { ErrorState } from "./ErrorState";
import { ResourceTable } from "./ResourceTable";
import { StatusBar } from "./StatusBar";

const S3_SERVICE: ServiceInfo = { id: "s3", name: "S3", global: true, types: [] };

interface Props {
  profile: string;
  account: string | undefined;
  location: S3Location;
  filter: string;
  onNavigate: (prefix: string) => void;
  onBack: () => void;
  onRefresh: () => void;
}

export function S3Area({ profile, account, location, filter, onNavigate, onBack, onRefresh }: Props) {
  const q = useS3Objects(profile, location.region, location.bucket, location.prefix);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  const selected = entries.find((e) => e.key === selectedKey) ?? null;
  useCopyShortcut(selected ? `s3://${location.bucket}/${selected.key}` : null);

  const segments: Segment[] = [
    { label: "Buckets", onClick: onBack },
    { label: location.bucket, onClick: () => onNavigate("") },
    ...prefixSegments(location.prefix).map((s) => ({ label: s.label, onClick: () => onNavigate(s.prefix) })),
  ];

  const open = (key: string) => {
    const entry = entries.find((e) => e.key === key);
    if (entry?.isFolder) onNavigate(entry.key);
  };

  return (
    <>
      <section className="center">
        <Breadcrumb service={S3_SERVICE} segments={segments} count={q.data ? entries.length : undefined} />
        {q.isError ? (
          <ErrorState error={q.error} profile={profile} onRetry={onRefresh} />
        ) : q.isPending ? (
          <div className="empty">불러오는 중…</div>
        ) : (
          <>
            <ResourceTable
              columns={S3_COLUMNS}
              items={entries.map(s3EntryToRow)}
              filter={filter}
              selectedId={selectedKey}
              onSelect={setSelectedKey}
              onOpen={open}
            />
            {q.hasNextPage && (
              <button className="btn more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                더 보기
              </button>
            )}
          </>
        )}
        <StatusBar profile={profile} account={account} region={location.region} updatedAt={q.dataUpdatedAt} />
      </section>
      <DetailPanel detail={selected ? s3EntryDetail(selected, location.bucket, location.region) : null} onShowRaw={() => {}} />
    </>
  );
}
```

`src/components/MainArea.tsx`:
```tsx
import type { Favorite, ServiceInfo } from "../api/types";
import type { S3Location } from "../lib/s3";
import { ResourceArea } from "./ResourceArea";
import { S3Area } from "./S3Area";

interface Props {
  services: ServiceInfo[];
  selection: Favorite | null;
  profile: string | null;
  region: string;
  account: string | undefined;
  filter: string;
  s3: S3Location | null;
  onS3Change: (loc: S3Location | null) => void;
  onRefresh: () => void;
}

export function MainArea({ services, selection, profile, region, account, filter, s3, onS3Change, onRefresh }: Props) {
  const service = services.find((s) => s.id === selection?.service);
  const type = service?.types.find((t) => t.id === selection?.type);
  if (!profile || !service || !type) {
    return (
      <section className="center">
        <div className="empty">왼쪽에서 리소스 타입을 고르세요</div>
      </section>
    );
  }
  if (service.id === "s3" && s3) {
    return (
      <S3Area
        profile={profile}
        account={account}
        location={s3}
        filter={filter}
        onNavigate={(prefix) => onS3Change({ ...s3, prefix })}
        onBack={() => onS3Change(null)}
        onRefresh={onRefresh}
      />
    );
  }
  return (
    <ResourceArea
      service={service}
      type={type}
      profile={profile}
      region={region}
      account={account}
      filter={filter}
      onOpenBucket={onS3Change}
      onRefresh={onRefresh}
    />
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- s3 ResourceArea S3Area`
Expected: s3 2개, ResourceArea 4개, S3Area 2개 PASS.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(frontend): add resource list area and S3 object browser"
```

---

### Task 20: 앱 조립 — 툴바, 상태 관리, 단축키, 스타일

**Files:**
- Create: `src/components/Toolbar.tsx`, `src/components/NoProfiles.tsx`
- Modify: `src/App.tsx`, `src/main.tsx`, `src/styles.css`
- Test: `src/App.test.tsx` (교체)

**Interfaces:**
- Consumes: 모든 이전 컴포넌트와 훅
- Produces: 완성된 앱. `Toolbar({ profiles, profile, onProfile, region, onRegion, filter, onFilter, filterRef, onRefresh, onOpenSettings })`

- [ ] **Step 1: 실패하는 App 테스트 작성 (기존 스모크 테스트 교체)**

`src/App.test.tsx`:
```tsx
import { fireEvent, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { api } from "./api/client";
import { makeResource, renderWithClient, sampleServices } from "./test/utils";

vi.mock("./api/client", () => ({
  api: {
    listProfiles: vi.fn(),
    getAccount: vi.fn(),
    listServices: vi.fn(),
    listResources: vi.fn(),
    listS3Objects: vi.fn(),
    ssoLogin: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
  },
}));
vi.mock("./api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));

const m = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  m.listProfiles.mockResolvedValue([
    { name: "dev", region: "us-east-1" },
    { name: "prod", region: "ap-northeast-2" },
  ]);
  m.getAccount.mockResolvedValue("123456789012");
  m.listServices.mockResolvedValue(sampleServices);
  m.getSettings.mockResolvedValue({ enabledServices: ["ec2", "iam"], favorites: [], lastProfile: "prod", lastRegion: null });
  m.saveSettings.mockResolvedValue(undefined);
  m.listResources.mockResolvedValue({ items: [makeResource("i-1", { name: "web-1", id: "i-1" })], truncated: false });
});

test("restores last profile, uses its region, shows only enabled services", async () => {
  renderWithClient(<App />);
  expect(await screen.findByRole("combobox", { name: "프로필" })).toHaveValue("prod");
  expect(screen.getByRole("combobox", { name: "리전" })).toHaveValue("ap-northeast-2");
  expect(screen.getByText("EC2")).toBeInTheDocument();
  expect(screen.getByText("IAM")).toBeInTheDocument();
  expect(screen.queryByText("S3")).not.toBeInTheDocument();
});

test("selecting a type lists resources", async () => {
  renderWithClient(<App />);
  fireEvent.click(await screen.findByText("EC2"));
  fireEvent.click(screen.getByText("Instances"));
  expect(await screen.findByText("web-1")).toBeInTheDocument();
  expect(m.listResources).toHaveBeenCalledWith("prod", "ap-northeast-2", "ec2", "instances");
});

test("changing profile switches region and saves settings", async () => {
  renderWithClient(<App />);
  const profile = await screen.findByRole("combobox", { name: "프로필" });
  fireEvent.change(profile, { target: { value: "dev" } });
  expect(screen.getByRole("combobox", { name: "리전" })).toHaveValue("us-east-1");
  await waitFor(() =>
    expect(m.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ lastProfile: "dev", lastRegion: "us-east-1" })),
  );
});

test("service settings toggles sidebar services", async () => {
  renderWithClient(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "서비스 설정" }));
  fireEvent.click(screen.getByLabelText(/S3/));
  fireEvent.click(screen.getByRole("button", { name: "완료" }));
  // 서비스 이름과 배지 약어가 모두 "S3"라 getAllByText를 쓴다
  expect(screen.getAllByText("S3").length).toBeGreaterThan(0);
  expect(m.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ enabledServices: ["ec2", "iam", "s3"] }));
});

test("cmd+F focuses the filter", async () => {
  renderWithClient(<App />);
  const filter = await screen.findByPlaceholderText(/필터/);
  fireEvent.keyDown(window, { key: "f", metaKey: true });
  expect(filter).toHaveFocus();
});

test("no profiles shows setup guide", async () => {
  m.listProfiles.mockResolvedValue([]);
  renderWithClient(<App />);
  expect(await screen.findByText(/aws configure sso/)).toBeInTheDocument();
});
```

Run: `npm test -- App`
Expected: FAIL.

- [ ] **Step 2: Toolbar, NoProfiles 구현**

`src/components/Toolbar.tsx`:
```tsx
import type { RefObject } from "react";
import type { ProfileInfo } from "../api/types";
import { REGIONS } from "../lib/regions";

interface Props {
  profiles: ProfileInfo[];
  profile: string | null;
  onProfile: (p: string) => void;
  region: string;
  onRegion: (r: string) => void;
  filter: string;
  onFilter: (f: string) => void;
  filterRef: RefObject<HTMLInputElement>;
  onRefresh: () => void;
  onOpenSettings: () => void;
}

export function Toolbar({ profiles, profile, onProfile, region, onRegion, filter, onFilter, filterRef, onRefresh, onOpenSettings }: Props) {
  const regions = REGIONS.includes(region) ? REGIONS : [region, ...REGIONS];
  return (
    <header className="titlebar">
      <label className="sel">
        <small>프로필</small>
        <select aria-label="프로필" value={profile ?? ""} onChange={(e) => onProfile(e.target.value)}>
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="sel">
        <small>리전</small>
        <select aria-label="리전" value={region} onChange={(e) => onRegion(e.target.value)}>
          {regions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <input
        ref={filterRef}
        className="search"
        placeholder="이름, ID로 필터  ⌘F"
        value={filter}
        onChange={(e) => onFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onFilter("");
            e.currentTarget.blur();
          }
        }}
      />
      <button className="icon" title="새로고침 (⌘R)" aria-label="새로고침" onClick={onRefresh}>
        ⟳
      </button>
      <button className="icon" title="서비스 설정" aria-label="서비스 설정" onClick={onOpenSettings}>
        ⚙
      </button>
    </header>
  );
}
```

`src/components/NoProfiles.tsx`:
```tsx
export function NoProfiles() {
  return (
    <div className="empty full">
      <div>
        <h3>AWS 프로필이 없어요</h3>
        <p>터미널에서 아래 명령으로 프로필을 만든 뒤 앱을 다시 실행하세요.</p>
        <pre className="raw">aws configure sso</pre>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: App.tsx 구현**

`src/App.tsx`:
```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useProfiles, useServices, useSettings } from "./api/queries";
import type { Favorite } from "./api/types";
import { MainArea } from "./components/MainArea";
import { NoProfiles } from "./components/NoProfiles";
import { ServiceSettings } from "./components/ServiceSettings";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import type { S3Location } from "./lib/s3";

const sameFav = (a: Favorite, b: Favorite) => a.service === b.service && a.type === b.type;

export default function App() {
  const qc = useQueryClient();
  const services = useServices();
  const profiles = useProfiles();
  const { settings, update } = useSettings();
  const [profile, setProfile] = useState<string | null>(null);
  const [region, setRegion] = useState("us-east-1");
  const [selection, setSelection] = useState<Favorite | null>(null);
  const [s3, setS3] = useState<S3Location | null>(null);
  const [filter, setFilter] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const account = useAccount(profile);

  // 첫 로드: 마지막 프로필/리전 복원
  useEffect(() => {
    if (profile || !settings || !profiles.data?.length) return;
    const p = profiles.data.find((x) => x.name === settings.lastProfile) ?? profiles.data[0];
    setProfile(p.name);
    setRegion(settings.lastRegion ?? p.region ?? "us-east-1");
  }, [profile, settings, profiles.data]);

  const refresh = useCallback(() => {
    if (!profile) return;
    void qc.invalidateQueries({ queryKey: ["resources", profile] });
    void qc.invalidateQueries({ queryKey: ["s3", profile] });
    void qc.invalidateQueries({ queryKey: ["account", profile] });
  }, [qc, profile]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === "f") {
        e.preventDefault();
        filterRef.current?.focus();
      } else if (e.key === "r") {
        e.preventDefault();
        refresh();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [refresh]);

  if (profiles.data && profiles.data.length === 0) return <NoProfiles />;
  if (!services.data || !settings || !profiles.data) return <div className="empty full">불러오는 중…</div>;

  const enabled = services.data.filter((s) => settings.enabledServices.includes(s.id));

  const changeProfile = (name: string) => {
    const info = profiles.data?.find((p) => p.name === name);
    const nextRegion = info?.region ?? region;
    setProfile(name);
    setRegion(nextRegion);
    setS3(null);
    update({ lastProfile: name, lastRegion: nextRegion });
  };

  const changeRegion = (r: string) => {
    setRegion(r);
    setS3(null);
    update({ lastRegion: r });
  };

  const select = (sel: Favorite) => {
    setSelection(sel);
    setS3(null);
    setFilter("");
  };

  const toggleFavorite = (sel: Favorite) => {
    const exists = settings.favorites.some((f) => sameFav(f, sel));
    update({ favorites: exists ? settings.favorites.filter((f) => !sameFav(f, sel)) : [...settings.favorites, sel] });
  };

  const mainKey = [profile, region, selection?.service, selection?.type, s3?.bucket, s3?.prefix].join("|");

  return (
    <div className="app">
      <Toolbar
        profiles={profiles.data}
        profile={profile}
        onProfile={changeProfile}
        region={region}
        onRegion={changeRegion}
        filter={filter}
        onFilter={setFilter}
        filterRef={filterRef}
        onRefresh={refresh}
        onOpenSettings={() => setShowSettings(true)}
      />
      <div className="main">
        <Sidebar
          services={enabled}
          profile={profile}
          region={region}
          selection={selection}
          favorites={settings.favorites}
          onSelect={select}
          onToggleFavorite={toggleFavorite}
        />
        <MainArea
          key={mainKey}
          services={enabled}
          selection={selection}
          profile={profile}
          region={region}
          account={account.data}
          filter={filter}
          s3={s3}
          onS3Change={setS3}
          onRefresh={refresh}
        />
      </div>
      {showSettings && (
        <ServiceSettings
          services={services.data}
          enabled={settings.enabledServices}
          onChange={(ids) => update({ enabledServices: ids })}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: main.tsx에 QueryClientProvider 추가**

`src/main.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 5: styles.css 작성 (목업 기반)**

`src/styles.css`:
```css
:root {
  --bg: #1e1e20; --side: #262628; --panel: #2b2b2e; --line: #3a3a3d; --text: #e6e6e8;
  --dim: #9a9aa0; --accent: #0a84ff; --green: #30d158; --red: #ff453a; --yellow: #ffd60a;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 13px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif; user-select: none; }
button { font: inherit; color: inherit; }
.app { height: 100%; display: flex; flex-direction: column; }
.titlebar { height: 46px; display: flex; align-items: center; gap: 10px; padding: 0 14px; background: #2a2a2c; border-bottom: 1px solid var(--line); }
.sel { display: flex; align-items: center; gap: 4px; background: #3a3a3d; border: 1px solid #4a4a4e; border-radius: 6px; padding: 2px 6px; }
.sel small { color: var(--dim); }
.sel select { background: transparent; color: var(--text); border: 0; font: inherit; outline: none; }
.search { flex: 1; max-width: 300px; margin-left: auto; background: #1c1c1e; border: 1px solid #444; border-radius: 6px; padding: 5px 10px; color: var(--text); font: inherit; outline: none; }
.search:focus { border-color: var(--accent); }
.icon { width: 28px; height: 26px; display: grid; place-items: center; border-radius: 6px; color: var(--dim); background: none; border: 0; cursor: pointer; }
.icon:hover { background: #3a3a3d; color: #fff; }
.main { flex: 1; display: flex; min-height: 0; }
.side { width: 220px; background: var(--side); border-right: 1px solid var(--line); overflow: auto; padding: 8px 0; }
.grp { color: var(--dim); font-size: 11px; font-weight: 600; padding: 10px 14px 4px; }
.svc { padding: 4px 14px; display: flex; align-items: center; gap: 7px; cursor: pointer; }
.svc .tw { width: 10px; color: var(--dim); font-size: 9px; }
.badge { width: 18px; height: 18px; border-radius: 4px; display: inline-grid; place-items: center; font-size: 9px; font-weight: 700; color: #fff; flex: none; }
.typ { padding: 4px 14px 4px 46px; cursor: pointer; color: #cfcfd2; display: flex; justify-content: space-between; }
.typ.fav { padding-left: 14px; }
.typ .count { color: var(--dim); font-size: 11px; }
.typ:hover, .svc:hover { background: #ffffff0d; }
.typ.on { background: var(--accent); color: #fff; border-radius: 5px; margin: 0 6px; padding-left: 40px; }
.typ.on .count { color: #ffffffcc; }
.center { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.crumb { padding: 9px 14px; border-bottom: 1px solid var(--line); color: var(--dim); display: flex; gap: 6px; align-items: center; white-space: nowrap; overflow: hidden; }
.crumb b { color: var(--text); font-weight: 600; }
.crumb-link { color: var(--dim); }
.crumb-link:hover { color: #fff; }
.crumb-count { margin-left: auto; }
.notice { padding: 6px 14px; background: #ffd60a22; color: var(--yellow); font-size: 12px; }
.tbl { flex: 1; overflow: auto; outline: none; }
table { width: 100%; border-collapse: collapse; }
th { position: sticky; top: 0; background: var(--bg); text-align: left; font-weight: 500; color: var(--dim); font-size: 11px; padding: 6px 14px; border-bottom: 1px solid var(--line); cursor: pointer; white-space: nowrap; }
td { padding: 6px 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
tbody tr:nth-child(even) td { background: #ffffff05; }
tbody tr.on td { background: var(--accent) !important; color: #fff; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; background: var(--dim); }
.dot.green { background: var(--green); } .dot.red { background: var(--red); } .dot.yellow { background: var(--yellow); }
.mono { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.status { padding: 5px 14px; border-top: 1px solid var(--line); color: var(--dim); font-size: 11px; display: flex; justify-content: space-between; }
.detail { width: 320px; background: var(--panel); border-left: 1px solid var(--line); overflow: auto; padding: 14px; user-select: text; }
.detail h3 { margin: 0 0 2px; font-size: 15px; word-break: break-all; }
.detail .sub { color: var(--dim); font-size: 11px; margin-bottom: 12px; }
.kv { display: grid; grid-template-columns: 110px 1fr; gap: 5px 8px; font-size: 12px; margin: 0 0 14px; }
.kv dt { color: var(--dim); }
.kv dd { margin: 0; word-break: break-all; }
.sect { font-size: 11px; color: var(--dim); font-weight: 600; margin: 12px 0 6px; text-transform: uppercase; letter-spacing: .04em; }
.tag { display: inline-block; background: #3a3a3d; border-radius: 4px; padding: 2px 7px; margin: 0 4px 4px 0; font-size: 11px; }
.copyable { font-size: 11px; word-break: break-all; }
.link { background: none; border: 0; color: var(--accent); cursor: pointer; padding: 0; }
.btn { display: block; width: 100%; background: #3a3a3d; border: 1px solid #4a4a4e; color: #fff; border-radius: 6px; padding: 6px; margin-top: 8px; cursor: pointer; font-size: 12px; }
.btn:hover { background: #45454a; }
.btn.primary { background: var(--accent); border-color: var(--accent); width: auto; padding: 6px 16px; display: inline-block; }
.btn.more { width: auto; margin: 8px auto; padding: 6px 20px; }
.btn:disabled { opacity: .6; cursor: default; }
.empty { color: var(--dim); display: grid; place-items: center; flex: 1; text-align: center; padding: 20px; }
.empty.small { flex: none; padding: 24px; }
.empty.full { height: 100%; }
.err { color: var(--red); }
.modal { position: fixed; inset: 0; background: #0008; display: grid; place-items: center; z-index: 10; }
.sheet { width: 460px; max-height: 80vh; overflow: auto; background: var(--panel); border: 1px solid #444; border-radius: 12px; padding: 18px; }
.sheet.wide { width: 720px; }
.sheet h3 { margin: 0 0 4px; }
.sheet p { color: var(--dim); margin: 0 0 14px; font-size: 12px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; }
.grid label { display: flex; gap: 8px; align-items: center; cursor: pointer; }
.foot { display: flex; justify-content: flex-end; margin-top: 16px; }
.raw { background: #1c1c1e; border: 1px solid var(--line); border-radius: 6px; padding: 10px; font: 11px ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-all; user-select: text; text-align: left; max-height: 60vh; overflow: auto; }
```

- [ ] **Step 6: 전체 테스트와 빌드**

Run: `npm test && npm run build`
Expected: 모든 프론트엔드 테스트 PASS(App 6개 포함), 타입 체크와 Vite 빌드 성공.

- [ ] **Step 7: 실제 앱 실행 확인**

Run: `npm run tauri dev`
확인: 창이 뜨고 프로필/리전 드롭다운에 실제 프로필이 보임. EC2 › Instances를 누르면 목록이 뜨거나(권한/SSO에 따라) 해당 오류 화면이 표시됨. 종료(Ctrl+C).

- [ ] **Step 8: Commit**

```bash
git add src
git commit -m "feat(frontend): assemble app with toolbar, shortcuts, and styles"
```

---

### Task 21: 수동 테스트 체크리스트와 최종 검증

**Files:**
- Create: `docs/manual-test-checklist.md`

**Interfaces:**
- Consumes: 완성된 앱

- [ ] **Step 1: 체크리스트 작성**

`docs/manual-test-checklist.md`:
```markdown
# 수동 테스트 체크리스트

실제 SSO 프로필로 `npm run tauri dev` 실행 후 확인한다.

## 기본
- [ ] 첫 실행 시 16개 서비스가 모두 사이드바에 보인다
- [ ] 프로필 드롭다운에 `~/.aws/config`의 프로필이 모두 보이고, 바꾸면 그 프로필의 기본 리전으로 바뀐다
- [ ] 앱을 재시작하면 마지막 프로필/리전/활성 서비스/즐겨찾기가 복원된다
- [ ] 상태바에 프로필 · 계정 ID · 리전(전역 서비스는 global)이 보인다

## 서비스별 목록과 상세 (각 타입: 목록 표시, 행 선택 시 상세, 콘솔 열기 동작)
- [ ] EC2: Instances / Security Groups / Volumes
- [ ] S3: Buckets → 더블클릭으로 폴더 진입, 경로 클릭으로 상위 이동, "더 보기"
- [ ] Lambda: Functions
- [ ] RDS: DB Instances / DB Clusters
- [ ] ECS: Clusters / Services / Tasks
- [ ] EKS: Clusters / Node Groups
- [ ] VPC: VPCs / Subnets
- [ ] IAM: Users / Roles / Policies
- [ ] DynamoDB: Tables
- [ ] CloudWatch Logs: Log Groups
- [ ] CloudFront: Distributions
- [ ] SQS: Queues
- [ ] SNS: Topics
- [ ] ECR: Repositories
- [ ] Route53: Hosted Zones
- [ ] Secrets Manager: Secrets (시크릿 값은 어디에도 표시되지 않는다)

## 조작
- [ ] ⌘F 필터 포커스, Esc로 필터 지우기
- [ ] ⌘R 새로고침 후 상태바 시간이 갱신된다
- [ ] 행 선택 후 ⌘C로 ID(S3는 s3:// URI) 복사
- [ ] ↑↓로 행 이동, Enter로 S3 버킷/폴더 열기
- [ ] 리소스 타입 우클릭으로 즐겨찾기 추가/제거
- [ ] ⚙에서 서비스를 끄면 사이드바에서 즉시 사라진다
- [ ] 원본 데이터 보기 모달이 열리고 닫힌다

## 오류
- [ ] `aws sso logout --profile <p>` 후 조회 → "SSO 세션이 만료됐어요" + 로그인 버튼 → 로그인 후 자동 재조회
- [ ] 권한 없는 타입은 "권한 없음 (액션)"만 표시하고 다른 타입은 정상 동작
- [ ] 네트워크 끊고 조회 → 네트워크 오류 + 다시 시도
```

- [ ] **Step 2: 전체 자동 검증**

Run: `npm test && npm run build && (cd src-tauri && cargo test && cargo clippy -- -D warnings)`
Expected: 모두 성공. clippy 경고가 있으면 고친 뒤 다시 실행.

- [ ] **Step 3: 체크리스트 수행**

`npm run tauri dev`로 체크리스트를 실제 계정에서 수행하고, 실패 항목은 수정 후 다시 확인한다. 확인한 항목은 체크한다.

- [ ] **Step 4: 앱 번들 빌드**

Run: `npm run tauri build`
Expected: `src-tauri/target/release/bundle/macos/Magic Mirror.app` 생성.

- [ ] **Step 5: Commit**

```bash
git add docs/manual-test-checklist.md src src-tauri
git commit -m "docs: add manual test checklist"
```

