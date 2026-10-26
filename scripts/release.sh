#!/usr/bin/env bash
# Intel + Apple Silicon 유니버설 앱을 ad-hoc 서명으로 빌드하고 release/에 배포 파일을 모은다.
# (Apple Developer 계정 없이 배포. 받는 사람은 docs/INSTALL.md의 안내대로 처음 한 번 허용해야 한다.)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
NAME="Magic-Mirror-${VERSION}-macos-universal"
BUNDLE=src-tauri/target/universal-apple-darwin/release/bundle

npm test
npm run tauri build -- --target universal-apple-darwin

APP="$BUNDLE/macos/Magic Mirror.app"
codesign --verify --deep --strict "$APP"
lipo -archs "$APP/Contents/MacOS/magic-mirror"

rm -rf release && mkdir -p release
cp "$BUNDLE"/dmg/*.dmg "release/${NAME}.dmg"
cp docs/INSTALL.md "release/설치 방법.md"
(cd release && shasum -a 256 "${NAME}.dmg" > "${NAME}.dmg.sha256")
echo "→ release/${NAME}.dmg"
