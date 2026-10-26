#!/usr/bin/env bash
# Intel + Apple Silicon 유니버설 앱을 ad-hoc 서명으로 빌드하고 release/에 배포 파일을 모은다.
# (Apple Developer 계정 없이 배포. 받는 사람은 docs/INSTALL.md의 안내대로 처음 한 번 허용해야 한다.)
#
#   npm run release              # 빌드만 (release/에 파일 생성)
#   npm run release -- --publish # 빌드 후 GitHub Release v<버전> 생성 → 설치된 앱이 자동 업데이트로 받는다
#
# 자동 업데이트 서명 키: ~/.tauri/magic-mirror.key (없으면 업데이트 파일을 서명할 수 없다. 꼭 백업!)
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLISH=false
[[ "${1:-}" == "--publish" ]] && PUBLISH=true

REPO=final-lee/magic-mirror
KEY_FILE="${TAURI_SIGNING_KEY_FILE:-$HOME/.tauri/magic-mirror.key}"
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
TAG="v${VERSION}"
NAME="Magic-Mirror-${VERSION}-macos-universal"
UPDATE_NAME="Magic-Mirror-macos-universal.app.tar.gz"
BUNDLE=src-tauri/target/universal-apple-darwin/release/bundle

[[ -f "$KEY_FILE" ]] || { echo "업데이트 서명 키가 없어요: $KEY_FILE" >&2; exit 1; }
if $PUBLISH; then
  [[ -z "$(git status --porcelain)" ]] || { echo "커밋하지 않은 변경이 있어요." >&2; exit 1; }
  git fetch -q origin main
  [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || { echo "HEAD가 origin/main과 달라요. main을 push한 뒤 실행하세요." >&2; exit 1; }
  if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    echo "$TAG 릴리즈가 이미 있어요. src-tauri/tauri.conf.json의 version을 올려 주세요." >&2; exit 1
  fi
fi

export TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

npm test
npm run tauri build -- --target universal-apple-darwin

APP="$BUNDLE/macos/Magic Mirror.app"
codesign --verify --deep --strict "$APP"
lipo -archs "$APP/Contents/MacOS/magic-mirror"

rm -rf release && mkdir -p release
cp "$BUNDLE"/dmg/*.dmg "release/${NAME}.dmg"
cp "$BUNDLE/macos/Magic Mirror.app.tar.gz" "release/${UPDATE_NAME}"
cp docs/INSTALL.md release/INSTALL.md  # GitHub 첨부 파일 이름은 ASCII만 유지된다
(cd release && shasum -a 256 "${NAME}.dmg" > "${NAME}.dmg.sha256")

SIG=$(cat "$BUNDLE/macos/Magic Mirror.app.tar.gz.sig")
URL="https://github.com/${REPO}/releases/download/${TAG}/${UPDATE_NAME}"
SIG="$SIG" URL="$URL" VERSION="$VERSION" node -e '
const { SIG, URL, VERSION } = process.env;
const entry = { signature: SIG, url: URL };
const manifest = {
  version: VERSION,
  notes: `Magic Mirror ${VERSION}`,
  pub_date: new Date().toISOString(),
  platforms: { "darwin-aarch64": entry, "darwin-x86_64": entry },
};
require("fs").writeFileSync("release/latest.json", JSON.stringify(manifest, null, 2) + "\n");
'
echo "→ release/${NAME}.dmg, release/${UPDATE_NAME}, release/latest.json"

if $PUBLISH; then
  gh release create "$TAG" --repo "$REPO" --target main --title "Magic Mirror ${VERSION}" \
    --notes "macOS 유니버설(Intel·Apple Silicon). 처음 설치할 때는 INSTALL.md를 참고하세요. 이미 설치했다면 앱이 자동으로 업데이트를 알려줘요." \
    "release/${NAME}.dmg" "release/${NAME}.dmg.sha256" "release/${UPDATE_NAME}" "release/latest.json" release/INSTALL.md
  echo "→ https://github.com/${REPO}/releases/tag/${TAG}"
fi
