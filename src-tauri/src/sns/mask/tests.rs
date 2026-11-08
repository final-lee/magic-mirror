use super::{endpoint, looks_like_email, looks_like_phone};
#[test]
fn masks_private_endpoints() {
    assert_eq!(endpoint("email", "alice@example.com"), "a***@example.com");
    assert_eq!(endpoint("email-json", "broken"), "***");
    assert_eq!(endpoint("sms", "+821012341234"), "+82******1234");
    assert_eq!(endpoint("sms", "123"), "******");
    assert_eq!(endpoint("sqs", "arn:queue"), "arn:queue");
}
#[test]
fn detects_email_and_phone_like_values() {
    assert!(looks_like_email("alice@example.com") && looks_like_phone("+821012341234"));
    assert!(
        !looks_like_email("arn:aws:sns:r:1:a@b")
            && !looks_like_email("a b@c")
            && !looks_like_email("plain")
    );
    assert!(
        !looks_like_phone("+") && !looks_like_phone("821012341234") && !looks_like_phone("+82-10")
    );
}
