# Magic Mirror 설치 방법 (macOS)

Magic Mirror는 Apple 공증을 받지 않은 앱이라, **처음 한 번만** 직접 실행을 허용해야 해요.
Intel Mac과 Apple Silicon Mac 모두 지원하고, macOS 11 이상에서 동작해요.

## 1. 설치
1. `Magic-Mirror-<버전>-macos-universal.dmg`를 더블클릭해요.
2. 열린 창에서 **Magic Mirror**를 **Applications** 폴더로 끌어다 놓아요.

## 2. 처음 실행 허용 (둘 중 하나)

### 방법 A — 시스템 설정에서 허용
1. Applications에서 Magic Mirror를 열어요. "확인할 수 없음" 경고가 뜨면 **완료**를 눌러요.
2. **시스템 설정 → 개인정보 보호 및 보안**으로 가서 아래쪽의
   "Magic Mirror이(가) 차단되었습니다" 옆 **그래도 열기**를 눌러요.
3. 다시 앱을 열고 **열기**를 누르면 끝이에요. 이후로는 그냥 열려요.

### 방법 B — 터미널 한 줄 ("손상되었기 때문에 열 수 없습니다"가 뜰 때도 이 방법)
```bash
xattr -dr com.apple.quarantine "/Applications/Magic Mirror.app"
```
실행한 뒤 앱을 열면 돼요.

## 3. 사용 전 준비
- AWS 자격 증명은 이 Mac의 `~/.aws/config`(SSO 프로필 포함)를 그대로 써요.
- SSO 프로필은 터미널에서 `aws sso login --profile <이름>`으로 로그인하거나, 앱에서 안내하는 로그인 버튼을 눌러요.

## 업데이트
새 버전 dmg로 같은 방법으로 덮어쓰면 돼요. 덮어쓴 뒤 처음 열 때 위의 허용 과정이 다시 필요할 수 있어요.

## 무결성 확인 (선택)
함께 받은 `.sha256` 파일과 비교해요.
```bash
shasum -a 256 -c Magic-Mirror-<버전>-macos-universal.dmg.sha256
```
