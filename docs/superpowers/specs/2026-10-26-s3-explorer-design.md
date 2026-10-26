# Magic Mirror — S3 탐색기 + 파일 비교 설계

- 작성일: 2026-10-26
- 상태: 사용자 검토 대기
- 선행 스펙: `docs/superpowers/specs/2026-10-26-aws-resource-browser-design.md` (리소스 브라우저, 구현 완료)
- 목업: `.superpowers/brainstorm/96031-1792994350/content/s3-explorer-layout.html`의 C안 (로컬 git 미포함)

## 1. 목적

리소스 브라우저와 별개인 **S3 탐색기 탭**을 추가한다. Forklift처럼 왼쪽에 내 Mac 폴더, 오른쪽에 S3 버킷을 두고 파일을 주고받으며(업로드·다운로드·새 폴더·이름 변경·삭제), 두 파일을 골라 **비교 탭**에서 줄 단위 diff를 본다.

## 2. 범위

### 포함

- 앱 상단 탭 바: `리소스`(고정) · `S3 탐색기`(고정) · 비교 탭(여러 개, 닫기 가능)
- S3 탐색기 2단 패널: 로컬 패널 + S3 패널, 하단 전송 대기열
- 업로드: 로컬 패널 → S3 패널 끌어다 놓기, Finder → S3 패널 끌어다 놓기, [복사 →] 버튼
- 다운로드: S3 패널 → 로컬 패널 끌어다 놓기, [← 복사] / [다운로드] 버튼 (로컬 패널의 현재 폴더로)
- 폴더 단위 업로드·다운로드 (하위 파일 재귀)
- S3 새 폴더, 이름 변경(복사 후 삭제, 폴더는 하위 객체 전체), 삭제(폴더는 하위 객체 전체)
- 덮어쓰기와 삭제는 항상 확인 창
- 비교: 로컬↔S3, S3↔S3, 로컬↔로컬. 텍스트는 Rust `similar`로 줄 단위 + 줄 안 글자 단위 강조, 좌우 나란히 표시, 다음/이전 변경 이동. 바이너리·대용량은 메타데이터 비교
- 비교 탭에서 [S3로 업로드 →] / [← 로컬로 내려받기] (확인 후 덮어쓰기)
- [외부 도구로 열기]: FileMerge(`opendiff`), VS Code(`code --diff`), 사용자 지정 명령

### 제외 (YAGNI)

- 버킷 생성/삭제, 권한·버전·수명 주기·암호화 설정
- 동기화(sync), 3-way 비교, 문법 강조
- S3 → Finder로 직접 끌어내기 (Tauri에서 네이티브 drag-out 미지원 → 로컬 패널/다운로드 버튼으로 대체)
- 5GB 초과 파일 업로드·복사(멀티파트 미구현, 명확한 오류 메시지로 거부)
- 로컬 파일 삭제·이름 변경 (로컬 패널은 탐색과 전송 출발지/도착지 역할만)
- 숨김 파일(이름이 `.`으로 시작) 표시

## 3. 전역 제약 변경

- 리소스 브라우저 어댑터(`src-tauri/src/adapters/`)는 계속 **조회 전용**이다.
- S3 쓰기 API(PutObject, CopyObject, DeleteObject(s))는 **`src-tauri/src/explorer/` 모듈에서만** 호출한다.
- 모든 쓰기 동작은 프론트엔드의 명시적 사용자 확인(덮어쓰기·삭제) 또는 명시적 사용자 동작(드롭, 버튼) 뒤에만 일어난다.

## 4. 화면

### 4.1 탭 바

툴바(프로필·리전·필터·새로고침·설정) 바로 아래에 탭 바를 둔다.

```
[리소스] [S3 탐색기] [⇄ index.html ✕] [⇄ app.js ✕]
```

- 프로필·리전은 모든 탭이 공유한다. 툴바 필터는 활성 탭(탐색기에서는 포커스된 패널)에 적용된다.
- 비교 탭 제목: `⇄ 왼쪽파일명` (양쪽 이름이 다르면 `⇄ a ↔ b`). 같은 두 파일로 다시 비교하면 기존 탭을 활성화한다.
- 탭 전환 시 각 탭의 상태(선택, 경로, 스크롤)는 유지한다(언마운트하지 않고 숨김).

### 4.2 S3 탐색기 탭

```
┌────────────────────────────┬────────────────────────────┐
│ 💻 ~/Projects/web/dist  [↑] │ 🪣 prod-assets › web  [↑]   │
│                            │ [+폴더][이름 변경][삭제]      │
│ Name      Size   Modified  │ Name      Size   Modified  │
│ 📁 assets                  │ 📁 assets                  │
│ 📄 index.html 4.2KB ...    │ 📄 index.html 4.1KB ...    │
├────────────────────────────┴────────────────────────────┤
│ [복사 →] [← 복사] [비교 ⌘D]                                │
│ 전송: ⬆ app.js 완료 · ⬇ logo.svg 64% ▓▓▓▓░░ · ✕ big.zip 실패 [재시도] │
└─────────────────────────────────────────────────────────┘
```

- **로컬 패널**: 처음엔 홈 폴더(설정 `explorerLocalPath`가 있으면 그 경로). 폴더 더블클릭/Enter로 진입, [↑]/⌫로 상위. 경로 표시줄 클릭 시 경로 직접 입력.
- **S3 패널**: 처음엔 버킷 목록. 버킷 → prefix(폴더) → 객체. [↑]로 상위, 버킷 목록에서 [↑]는 비활성.
- **선택**: 클릭 단일 선택, ⌘클릭 토글, ⇧클릭 범위. **Tab**으로 패널 포커스 전환(포커스된 패널은 상단 파란 밑줄).
- **전송 대기열**: 진행 중·대기·완료·실패 항목. 완료 항목은 [지우기]로 정리. 실패 항목은 오류 메시지와 [재시도].
- 버킷의 리전은 리소스 브라우저와 같은 방식(ListBuckets의 BucketRegion, 없으면 GetBucketLocation)으로 정한다.

### 4.3 파일 조작

| 동작 | 방법 | 동작 내용 |
|---|---|---|
| 업로드 | 로컬 → S3 드래그, Finder → S3 패널 드롭, 로컬 선택 후 [복사 →] | S3 패널의 현재 prefix 아래로. 폴더는 상대 경로 유지 |
| 다운로드 | S3 → 로컬 드래그, S3 선택 후 [← 복사] | 로컬 패널의 현재 폴더로. 폴더(prefix)는 하위 구조 유지 |
| 새 폴더 | S3 [+폴더] → 이름 입력 | 빈 객체 `prefix/이름/` 생성 |
| 이름 변경 | S3 단일 선택 [이름 변경] | CopyObject 후 DeleteObject. 폴더는 하위 객체 전부 |
| 삭제 | S3 선택 [삭제] / ⌫⌘ | 확인 창에 지워질 객체 수 표시 후 DeleteObjects(1,000개 단위) |

- **덮어쓰기 확인**: 전송 시작 전에 도착지 존재 여부를 확인하고, 충돌 파일 목록(최대 10개 표시 + "외 N개")과 함께 [모두 덮어쓰기] / [충돌 건너뛰기] / [취소]를 묻는다.
- 이름 변경 대상이 이미 존재하면 덮어쓰기 확인을 거친다.
- 로컬 패널 → 로컬 패널, S3 → 같은 S3 위치로의 드롭은 무시한다.

### 4.4 비교 탭

```
⇄ index.html (로컬 ↔ S3)                 +2 −0 ~1   [▲ 이전] [▼ 다음]  [외부 도구로 열기]
┌ 💻 ~/…/dist/index.html · 4.2KB · 10-26 14:10 ┬ 🪣 s3://prod-assets/web/index.html · 4.1KB · 10-21 ┐
│ 1  <!doctype html>                          │ 1  <!doctype html>                            │
│ 3  <title>Shop v2.[4]</title>      (노랑)    │ 3  <title>Shop v2.[3]</title>       (노랑)     │
│ 4  <link rel="preload" ...>        (초록)    │    ·                                          │
└─────────────────────────────────────────────┴───────────────────────────────────────────────┘
                          [S3로 업로드 →]   [← 로컬로 내려받기]
```

- **열기**: 탐색기에서 파일 두 개를 고른 뒤 [비교]/⌘D. 두 개 선택 규칙: 양쪽 패널에 각각 하나씩 선택돼 있으면 (로컬, S3), 아니면 포커스된 패널에서 정확히 두 개. 폴더가 섞이거나 개수가 맞지 않으면 버튼 비활성.
- **텍스트 비교**: 양쪽 모두 텍스트이고 각 2MB 이하일 때. 행 단위로 좌우 정렬하고 삽입은 초록, 삭제는 빨강, 변경은 노랑 배경에 바뀐 글자만 진하게 강조. 변경 없는 구간이 20줄을 넘으면 앞뒤 3줄만 남기고 "… N줄 같음" 행으로 접는다(클릭 시 펼침).
- **이동**: [▼ 다음]/[▲ 이전] 또는 F7 / ⇧F7로 변경 묶음(hunk) 사이를 이동하고 해당 행을 스크롤해 보여준다.
- **같은 내용**: 차이가 없으면 "두 파일이 같아요"를 표시한다.
- **메타데이터 비교**: 한쪽이라도 바이너리(앞 8KB에 NUL 바이트, 또는 UTF-8 아님)이거나 2MB를 넘으면 크기·수정일·MD5(로컬은 계산, S3는 ETag가 단일 파트 형식일 때만)를 표로 보여주고 "같음 / 다름 / 판단 불가"를 표시한다.
- **업로드/내려받기 버튼**: 로컬↔S3 비교일 때만 보인다. 덮어쓰기 확인 후 전송 대기열에 넣고, 완료되면 비교를 다시 계산한다.
- **외부 도구로 열기**: S3 쪽 파일을 임시 폴더에 받은 뒤 설정된 도구로 연다. 도구는 설정(⚙)의 "비교 도구"에서 고른다: FileMerge(`/usr/bin/opendiff {left} {right}`, 기본값), VS Code(`code --diff {left} {right}`), 직접 입력(`{left}`, `{right}` 자리표시자). 실행 파일이 없으면 오류 메시지로 안내한다.

## 5. 아키텍처

### 5.1 Rust (`src-tauri/src/explorer/`)

```
explorer/
  mod.rs        공용 타입: FileRef, LocalEntry, TransferRequest, TransferEvent
  local.rs      홈 경로, 폴더 목록(숨김 제외), 폴더 재귀 전개, 존재 확인, MD5 계산
  s3ops.rs      HeadObject 존재 확인, prefix 하위 키 전체 나열, 폴더 생성, 복사, 삭제(1,000개 단위)
  keys.rs       순수 함수: 업로드/다운로드 경로↔키 매핑, 이름 변경 키 매핑, 폴더 전개 결과 계산
  transfer.rs   전송 큐: 동시 3개, 업로드(PutObject from file), 다운로드(스트리밍 저장), 진행 이벤트
  textfile.rs   비교용 읽기: 2MB 제한, 바이너리 판별, 메타데이터
  diff.rs       similar 기반 순수 함수: 좌우 정렬 행, 줄 안 강조 구간, hunk 시작 행, 통계
  external.rs   외부 비교 도구 실행(임시 파일 준비 포함)
explorer_commands.rs   Tauri 커맨드 (기존 commands.rs와 분리)
```

**공용 타입**

```rust
#[serde(tag = "source", rename_all = "camelCase")]
pub enum FileRef {
    Local { path: String },
    S3 { bucket: String, region: String, key: String },
}

pub struct LocalEntry { name, path, is_dir: bool, size: Option<u64>, modified: Option<String> }   // camelCase

pub struct TransferRequest { id: String, direction: Direction /* "upload" | "download" */, local_path: String,
                             bucket: String, region: String, key: String }

pub struct TransferEvent { id: String, status: Status /* "queued"|"running"|"done"|"failed" */,
                           transferred: u64, total: Option<u64>, error: Option<AppError> }
```

**Tauri 커맨드**

| 커맨드 | 입력 | 출력 |
|---|---|---|
| `local_home` | — | 홈 경로 |
| `local_list` | path | `LocalEntry[]` (폴더 먼저, 이름순) |
| `plan_upload` | localPaths[], bucket, region, prefix | `TransferRequest[]` (폴더 재귀 전개) |
| `plan_download` | profile, bucket, region, keys[] (폴더는 `/`로 끝남), localDir | `TransferRequest[]` (prefix 하위 전개) |
| `find_conflicts` | profile, requests[] | 도착지에 이미 있는 요청 id 목록 |
| `start_transfers` | profile, requests[] | 즉시 반환. 진행은 이벤트 `transfer-progress`(TransferEvent)로 |
| `s3_create_folder` | profile, bucket, region, prefix, name | — |
| `s3_rename` | profile, bucket, region, fromKey, toKey | — (폴더면 하위 전체) |
| `s3_count_under` | profile, bucket, region, keys[] | 삭제될 객체 수 |
| `s3_delete` | profile, bucket, region, keys[] | 삭제된 객체 수 (폴더면 하위 전체) |
| `diff_files` | profile, left: FileRef, right: FileRef | `DiffResult` |
| `open_external_diff` | profile, left, right, tool, command? | — |

S3 객체 목록 탐색은 기존 `list_s3_objects`, 버킷 목록은 기존 `list_resources(service="s3", type="buckets")`를 재사용한다.

**DiffResult**

```rust
pub struct DiffResult {
    left: SideMeta, right: SideMeta,                 // label, size, modified, md5(Option)
    mode: DiffMode,                                  // "text" | "meta"
    rows: Vec<DiffRow>,                              // text 모드에서만
    hunks: Vec<usize>,                               // 변경 묶음이 시작되는 rows 인덱스
    stats: DiffStats { added, removed, changed },
    meta_verdict: Option<Verdict>,                   // meta 모드: "same" | "different" | "unknown"
    reason: Option<String>,                          // meta 모드인 이유: "binary" | "tooLarge"
}
pub struct DiffRow { kind: RowKind /* "equal"|"insert"|"delete"|"replace"|"collapsed" */,
                     left: Option<DiffLine>, right: Option<DiffLine>,
                     hidden_rows: Vec<DiffRow> /* collapsed 행에만: 접힌 equal 행들 */ }
pub struct DiffLine { no: usize, segments: Vec<Segment { text: String, emph: bool }> }
```

- `diff.rs`는 `similar::TextDiff::from_lines`로 연산을 얻고, 삭제/삽입이 이어지면 `replace` 행으로 짝짓고 `iter_inline_changes`로 강조 구간을 만든다. 20줄 넘는 같은 구간은 앞뒤 3줄만 남기고 가운데를 `collapsed` 행 하나로 접는다. 펼치기는 프론트에서 `collapsed` 행 자리에 `hidden_rows`를 그대로 보여주는 방식이다. `hunks`는 접힌 뒤의 `rows` 기준 인덱스다.

**전송**

- `start_transfers`는 요청들을 tokio 작업으로 띄우고 세마포어로 동시 3개를 유지한다.
- 업로드: `ByteStream::from_path`로 PutObject. 진행 이벤트는 시작(`running`, transferred 0)과 끝(`done`/`failed`)만 보낸다(SDK에 업로드 진행 콜백이 없음). 5GB 초과는 시작 전에 `failed`(메시지: "5GB가 넘는 파일은 아직 업로드할 수 없어요").
- 다운로드: GetObject 본문을 청크 단위로 임시 파일(`.part`)에 쓰며 512KB마다 `transferred` 이벤트를 보내고, 끝나면 원래 이름으로 rename. 상위 폴더는 자동 생성.
- 오류는 `from_sdk(e, "s3:PutObject")` 등으로 분류해 이벤트의 `error`에 담는다.

### 5.2 프론트엔드

```
src/
  App.tsx                       탭 상태 추가(리소스 / 탐색기 / 비교 탭 목록), 탭 바 렌더링
  components/TabBar.tsx
  explorer/
    api.ts                      explorer 커맨드 래퍼 + 타입, transfer-progress 리스너
    useTransfers.ts             전송 대기열 상태(이벤트 구독, 재시도, 지우기)
    selection.ts                순수 함수: 클릭/⌘/⇧ 선택 계산, 비교 대상 결정
    FileTable.tsx               다중 선택 파일 표 (Cell/format 재사용)
    LocalPane.tsx
    S3Pane.tsx
    ExplorerTab.tsx             두 패널 + 동작 버튼 + 드래그 앤 드롭 + Finder 드롭
    TransferQueue.tsx
    ConfirmDialog.tsx           덮어쓰기/삭제/이름 입력 공용 확인 창
    DiffTab.tsx                 diff_files 호출, 좌우 표, hunk 이동, 접힘 펼치기, 업/다운 버튼
```

- **패널 간 드래그**: Tauri의 OS 파일 드롭 처리와 충돌하지 않도록 HTML5 DnD 대신 포인터 이벤트 기반의 앱 내부 드래그를 쓴다(드래그 중 미리보기 칩 표시, 놓는 패널 하이라이트).
- **Finder 드롭**: `getCurrentWebview().onDragDropEvent`로 경로와 위치를 받고, 위치의 요소가 S3 패널 안이면 업로드한다. S3 패널이 버킷 목록 상태면 "버킷을 먼저 여세요" 안내.
- **설정 추가**: `explorerLocalPath`(마지막 로컬 경로), `diffTool`(`"filemerge" | "vscode" | "custom"`, 기본 `filemerge`), `diffToolCommand`(custom일 때). Rust `Settings`에 `#[serde(default)]` 필드로 추가해 기존 설정 파일과 호환한다. 서비스 설정 창에 "비교 도구" 섹션을 추가한다.
- 탐색기에서 쓰기 동작이 끝나면 해당 S3 prefix의 `["s3", profile, bucket, prefix]` 쿼리와 로컬 폴더 쿼리를 무효화한다.

## 6. 오류 처리

| 상황 | 표시 |
|---|---|
| 쓰기 권한 없음 (PutObject/DeleteObject 등) | 전송 항목 또는 확인 창 아래에 "권한 없음 (s3:PutObject)" |
| SSO 만료 | 기존 ErrorState와 동일한 로그인 흐름(패널 단위) |
| 로컬 폴더 읽기 실패 (권한, 없음) | 로컬 패널에 메시지 + [홈으로] |
| 5GB 초과 업로드·복사 | 해당 항목 실패 + 안내 문구 |
| 이름 변경 중 일부 실패 | 복사 성공분은 남기고 원본 삭제는 하지 않으며, "일부 객체를 옮기지 못했어요 (N개)" 표시 |
| 외부 비교 도구 없음 | "FileMerge를 찾을 수 없어요. Xcode를 설치하거나 설정에서 다른 도구를 고르세요" |

macOS에서 홈 폴더 하위의 데스크탑·문서·다운로드 폴더를 처음 열면 OS 권한 요청이 뜰 수 있으며, 거부되면 위 "로컬 폴더 읽기 실패"로 처리한다.

## 7. 테스트

- **Rust 단위 테스트 (AWS 호출 없음)**: `keys.rs`(경로↔키 매핑, 폴더 전개, 이름 변경 매핑, Windows 구분자 없음 가정), `local.rs`(tempdir로 목록·숨김 제외·정렬·재귀 전개·MD5), `textfile.rs`(바이너리 판별, 2MB 제한), `diff.rs`(같음, 삽입, 삭제, 변경 짝짓기와 강조 구간, 접힘 구간, hunk 인덱스, 통계), `external.rs`(명령 템플릿 치환).
- **프론트엔드 (Vitest, API mock)**: 탭 바(열기·닫기·중복 비교 재사용), `selection.ts`(단일/⌘/⇧, 비교 대상 결정), FileTable 다중 선택, ExplorerTab(복사 버튼 → plan/find_conflicts/확인 창/start 흐름, 삭제 확인 개수), TransferQueue(이벤트 반영·재시도), DiffTab(행 렌더링·강조·hunk 이동·접힘 펼치기·메타 모드·같음 표시).
- **수동 체크리스트**: 기존 `docs/manual-test-checklist.md`에 S3 탐색기 섹션 추가(실제 테스트 버킷에서 업로드·다운로드·폴더·이름 변경·삭제·덮어쓰기·Finder 드롭·비교·외부 도구).
