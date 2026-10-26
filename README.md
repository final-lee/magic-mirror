# 🪞 Magic Mirror

> Mirror, mirror on the wall — who shows my AWS resources fastest of all?

A macOS desktop app for browsing AWS resources by service, without clicking through the console or typing long CLI commands. It also has a Forklift-style two-pane S3 explorer and a side-by-side file diff.

![Resource browser](docs/screenshots/resources.png)

## Features

### Resource browser (read-only)
- **16 services**: EC2, S3, Lambda, RDS, ECS, EKS, VPC, IAM, DynamoDB, CloudWatch Logs, CloudFront, SQS, SNS, ECR, Route 53, Secrets Manager
- Uses the profiles in `~/.aws/config`, including SSO. Pick a profile and region and the list loads. When an SSO session expires, you can sign in again from the app.
- Turn on only the services you use, and pin resource types as favorites.
- Detail panel with key fields, tags, raw JSON, a link to the AWS console, and ID copy (⌘C)
- Filter by name or ID (⌘F), refresh (⌘R)
- Read-only: it never calls APIs that change resources, and it never reads Secrets Manager secret values.

### VPC network diagram
![VPC network diagram](docs/screenshots/vpc-map.png)

- Double-click a VPC in **VPC → VPCs** to draw its network in a new tab, laid out like an AWS architecture diagram: Availability Zones as columns, public / private / isolated subnets as rows.
- Subnet tiers come from the route tables: a default route to an internet gateway means public, any other default route means private, and no default route means isolated.
- Shows EC2 instances, NAT gateways, load balancers, RDS, Lambda functions, and interface endpoints inside their subnets. Internet, egress-only, and VPN gateways sit on the VPC border. Gateway endpoints, Transit Gateway attachments, and peering connections sit in the bottom band.
- Click a subnet to see its route table and highlight where its default route goes. Click any resource for details and a console link.
- Zoom and pan, and save the diagram as a PNG.

### S3 explorer
![S3 explorer](docs/screenshots/explorer.png)

- Double-click a bucket to open it in its own tab. Several buckets can be open side by side.
- Your Mac on the left, S3 on the right. Drag and drop between panes, or drop files from Finder onto the S3 pane.
- Upload and download with progress (3 at a time), new folder, rename, delete
- Asks before overwriting existing files and before deleting (with an object count)
- Mouse back/forward buttons (e.g. MX Master thumb buttons) and ⌘[ / ⌘] move through folder history.

### File diff
![File diff](docs/screenshots/diff.png)

- Compare local↔S3, S3↔S3, or local↔local files with **Compare ⌘D**. The diff opens in its own tab.
- Side-by-side view, inline change highlighting, collapsed unchanged lines, jump between changes (F7 / ⇧F7)
- Reports line-ending-only (CRLF/LF) differences. Binary files and files over 2 MB are compared by size, modified time, and MD5.
- Upload or download straight from the diff, or open it in FileMerge, VS Code, or a custom tool.

### Auto-update
The app checks for a new version at launch and every 6 hours, and shows an **Update now / Later** banner. Only updates with a valid signature are installed.

## Install

1. Download `Magic-Mirror-<version>-macos-universal.dmg` from [Releases](https://github.com/final-lee/magic-mirror/releases/latest). It runs on Intel and Apple Silicon, macOS 11 or later.
2. Open the dmg and drag **Magic Mirror** into **Applications**.
3. The app is not notarized by Apple, so you have to allow it once:
   - **System Settings → Privacy & Security → Open Anyway**, or
   - run this in Terminal:
     ```bash
     xattr -dr com.apple.quarantine "/Applications/Magic Mirror.app"
     ```

### Requirements
- A profile in `~/.aws/config`. For SSO profiles, sign in with `aws sso login --profile <name>` or with the app's sign-in button.
- Read permissions for the services you want to browse. The VPC diagram uses EC2 `Describe*` calls plus `rds:DescribeDBInstances`, `elasticloadbalancing:DescribeLoadBalancers`, and `lambda:ListFunctions`; anything it can't read is skipped with a warning. Writing from the S3 explorer needs `s3:PutObject` and `s3:DeleteObject`.

## Development

| Part | Stack |
| --- | --- |
| App | [Tauri 2](https://tauri.app) |
| Backend | Rust, AWS SDK for Rust, [`similar`](https://crates.io/crates/similar) for diffs |
| Frontend | React 18, TypeScript, Vite, TanStack Query |
| Tests | Vitest, Testing Library, `cargo test` |

```bash
npm install
npm run tauri dev      # run in development mode
npm test               # frontend tests
(cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings)
```

The Rust toolchain is pinned in `rust-toolchain.toml` because of the AWS SDK's minimum supported Rust version.

### Project layout
```
src/                     React frontend
  components/            resource browser, tab bar, settings, update banner
  explorer/              S3 explorer, transfer queue, diff tab
  vpcmap/                VPC network diagram
src-tauri/src/
  adapters/              per-service read-only adapters
  explorer/              local files, S3 writes and transfers, diff engine
  topology/              VPC topology queries (read-only)
  mouse_nav.rs           macOS mouse back/forward buttons
scripts/release.sh       universal build and GitHub release
```

### Releasing
1. Bump `version` in `src-tauri/tauri.conf.json` and push to `main`.
2. Run `npm run release -- --publish`. It builds a universal binary, ad-hoc signs it, signs the update bundle, and creates the GitHub release with `latest.json`.

The update signing key must be at `~/.tauri/magic-mirror.key`. Only the public key is in the repository.
