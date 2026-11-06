use super::endpoint;
#[test]
fn masks_private_endpoints() {
    assert_eq!(endpoint("email", "alice@example.com"), "a***@example.com");
    assert_eq!(endpoint("email-json", "broken"), "***");
    assert_eq!(endpoint("sms", "+821012341234"), "+82******1234");
    assert_eq!(endpoint("sms", "123"), "******");
    assert_eq!(endpoint("sqs", "arn:queue"), "arn:queue");
}
