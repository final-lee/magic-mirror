use super::*;
use std::collections::HashMap;

#[test]
fn app_arn_splits_into_platform_and_name() {
    assert_eq!(split_app_arn("arn:aws:sns:ap-northeast-2:431847470565:app/GCM/my-app"), ("GCM".into(), "my-app".into()));
    assert_eq!(split_app_arn("arn:aws:sns:ap-northeast-2:431847470565:app/APNS_SANDBOX/a/b"), ("APNS_SANDBOX".into(), "a/b".into()));
    assert_eq!(split_app_arn("weird"), (String::new(), "weird".into()));
}

#[test]
fn app_view_keeps_only_safe_attributes_and_reads_the_certificate_expiry() {
    let attrs: HashMap<String, String> = [
        ("Enabled", "false"), ("AppleCertificateExpirationDate", "2027-01-02T03:04:05Z"),
        ("PlatformCredential", "secret"), ("PlatformPrincipal", "cert"), ("EventDeliveryFailure", "arn:aws:sns:ap-northeast-2:431847470565:t"),
    ].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    let app = app_view("arn:aws:sns:ap-northeast-2:431847470565:app/APNS/ios", &attrs);
    assert_eq!((app.platform.as_str(), app.name.as_str(), app.enabled), ("APNS", "ios", Some(false)));
    assert_eq!(app.cert_expiry.as_deref(), Some("2027-01-02T03:04:05Z"));
    assert_eq!(app.attributes.keys().map(String::as_str).collect::<Vec<_>>(), ["AppleCertificateExpirationDate", "Enabled", "EventDeliveryFailure"]);
    let none = app_view("arn:aws:sns:ap-northeast-2:431847470565:app/GCM/android", &HashMap::new());
    assert_eq!((none.enabled, none.cert_expiry), (None, None));
}

#[test]
fn latest_value_and_mean_for_sms_metrics() {
    assert_eq!(latest(&[30, 10, 20], &[3.0, 1.0, 2.0]), Some(3.0));
    assert_eq!(latest(&[], &[]), None);
    assert_eq!(mean(&[100.0, 50.0]), Some(75.0));
    assert_eq!(mean(&[]), None);
}

#[test]
fn sandbox_numbers_are_masked_with_the_shared_mask() {
    assert_eq!(mask::endpoint("sms", "+821012341234"), "+82******1234");
}

#[test]
fn errors_are_kept_per_item_and_login_problems_bubble_up() {
    let mut errors = Vec::new();
    assert_eq!(keep::<u8>(Err(AppError::AccessDenied { action: "sns:ListOriginationNumbers".into() }), &mut errors).unwrap(), None);
    assert_eq!(errors.len(), 1);
    // 같은 오류는 한 번만 남는다
    keep::<u8>(Err(AppError::AccessDenied { action: "sns:ListOriginationNumbers".into() }), &mut errors).unwrap();
    assert_eq!(errors.len(), 1);
    // 로그인 만료·요청 제한은 화면 전체의 오류로 올린다
    assert_eq!(keep::<u8>(Err(AppError::SsoExpired), &mut errors), Err(AppError::SsoExpired));
    assert_eq!(keep(Ok(3u8), &mut errors), Ok(Some(3)));
}
