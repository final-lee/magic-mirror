//! 마우스 뒤로/앞으로 버튼 (예: Logitech MX Master 엄지 버튼).
//! WKWebView는 3·4번 버튼을 DOM 이벤트로 넘겨주지 않으므로, macOS 이벤트를
//! 앱 안에서 가로채 "mouse-nav" 이벤트("back" | "forward")로 웹뷰에 보낸다.

/// 3·4번 버튼 번호를 방향으로 바꾼다.
pub fn direction(button_number: isize) -> Option<&'static str> {
    match button_number {
        3 => Some("back"),
        4 => Some("forward"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
pub fn install(app: tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask};
    use std::ptr::NonNull;
    use tauri::Emitter;

    let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit이 핸들러 호출 동안 유효한 NSEvent를 넘겨준다.
        let button = unsafe { event.as_ref() }.buttonNumber();
        match direction(button) {
            Some(dir) => {
                let _ = app.emit("mouse-nav", dir);
                std::ptr::null_mut() // 처리했으니 이벤트를 삼킨다
            }
            None => event.as_ptr(),
        }
    });
    // SAFETY: setup에서(메인 스레드) 호출되고, 모니터는 앱이 끝날 때까지 유지한다.
    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::OtherMouseDown, &handler) };
    std::mem::forget(monitor);
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_side_buttons() {
        assert_eq!(direction(3), Some("back"));
        assert_eq!(direction(4), Some("forward"));
        assert_eq!(direction(2), None);
        assert_eq!(direction(0), None);
    }
}
