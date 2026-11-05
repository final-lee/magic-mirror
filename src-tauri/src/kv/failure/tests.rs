use super::*;

fn ctx(mode: KvAuthMode) -> Ctx {
    Ctx { host: "cache.example".into(), port: 6379, mode, user: "app".into(), serverless: false }
}

fn server_error(text: &str) -> FredError {
    // fred가 서버 오류 글에서 종류를 고르는 것과 같은 길
    FredError::new(
        if text.starts_with("WRONGPASS") || text.starts_with("NOAUTH") { ErrorKind::Auth } else { ErrorKind::Unknown },
        text.to_string(),
    )
}

#[test]
fn a_wrong_password_asks_for_the_login_again_in_the_words_of_the_mode() {
    let wrong = server_error("WRONGPASS invalid username-password pair or user is disabled.");
    for mode in [KvAuthMode::Password, KvAuthMode::User] {
        assert_eq!(map_fred(&wrong, &ctx(mode), "AUTH"), AppError::LoginRequired { message: "비밀번호가 맞지 않아요".into() });
    }
    assert_eq!(
        map_fred(&wrong, &ctx(KvAuthMode::Iam), "AUTH"),
        AppError::LoginRequired { message: "IAM 인증에 실패했어요. elasticache:Connect 권한과 사용자 app를 확인하세요".into() }
    );
}

#[test]
fn a_cache_that_wants_a_login_but_got_none_says_so() {
    let noauth = server_error("NOAUTH Authentication required.");
    assert_eq!(map_fred(&noauth, &ctx(KvAuthMode::None), "PING"), AppError::LoginRequired { message: "이 캐시는 로그인이 필요해요".into() });
}

#[test]
fn sending_auth_to_a_cache_without_a_password_is_a_mode_mismatch() {
    let error = server_error("ERR AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?");
    match map_fred(&error, &ctx(KvAuthMode::Password), "AUTH") {
        AppError::LoginRequired { message } => assert!(message.contains("필요 없어요"), "{message}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_missing_permission_names_the_user_and_the_command() {
    let error = server_error("NOPERM User app has no permissions to run the 'slowlog|get' command");
    assert_eq!(map_fred(&error, &ctx(KvAuthMode::User), "SLOWLOG GET"), AppError::other("사용자 app에게 SLOWLOG|GET 권한이 없어요"));
    let key = server_error("NOPERM No permissions to access a key");
    assert_eq!(map_fred(&key, &ctx(KvAuthMode::User), "TYPE"), AppError::other("사용자 app에게 이 키를 읽을 권한이 없어요"));
    let plain = server_error("NOPERM something else");
    assert_eq!(map_fred(&plain, &ctx(KvAuthMode::User), "SCAN"), AppError::other("사용자 app에게 SCAN 권한이 없어요"));
    // 사용자 이름이 없는 방식은 기본 사용자다
    let default = Ctx { user: String::new(), ..ctx(KvAuthMode::Password) };
    assert_eq!(map_fred(&error, &default, "X"), AppError::other("사용자 default에게 SLOWLOG|GET 권한이 없어요"));
}

#[test]
fn connection_failures_point_to_the_vpn() {
    let expected = AppError::Network { message: "엔드포인트에 연결하지 못했어요(cache.example:6379). VPN이 켜져 있는지 확인하세요".into() };
    for kind in [ErrorKind::IO, ErrorKind::Timeout, ErrorKind::Canceled] {
        assert_eq!(map_fred(&FredError::new(kind, "Os { code: 61, kind: ConnectionRefused }"), &ctx(KvAuthMode::None), "PING"), expected);
    }
}

#[test]
fn certificate_problems_are_reported_as_unverified_certificates() {
    let unknown = FredError::new(ErrorKind::IO, "Custom { kind: InvalidData, error: InvalidCertificate(UnknownIssuer) }");
    let expected = AppError::Network { message: "서버 인증서를 확인하지 못했어요".into() };
    assert_eq!(map_fred(&unknown, &ctx(KvAuthMode::None), "PING"), expected);
    let name = FredError::new(ErrorKind::IO, "Custom { kind: InvalidData, error: InvalidCertificate(NotValidForName) }");
    assert_eq!(map_fred(&name, &ctx(KvAuthMode::None), "PING"), expected);
    assert_eq!(map_fred(&FredError::new(ErrorKind::Tls, "x"), &ctx(KvAuthMode::None), "PING"), expected);
}

#[test]
fn commands_a_serverless_cache_blocks_say_so() {
    let serverless = Ctx { serverless: true, ..ctx(KvAuthMode::None) };
    let error = server_error("ERR unknown command 'SLOWLOG', with args beginning with: 'GET'");
    assert_eq!(map_fred(&error, &serverless, "SLOWLOG GET"), AppError::other("서버리스 캐시는 SLOWLOG GET 명령을 쓸 수 없어요"));
    // 노드형에서는 서버 문구를 그대로 보인다
    match map_fred(&error, &ctx(KvAuthMode::None), "SLOWLOG GET") {
        AppError::Other { message } => assert!(message.contains("unknown command"), "{message}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn only_connection_losses_make_a_connection_unusable() {
    assert!(is_connection_loss(&KvCallError::Server(FredError::new(ErrorKind::IO, "x"))));
    assert!(is_connection_loss(&KvCallError::Server(FredError::new(ErrorKind::Timeout, "x"))));
    assert!(!is_connection_loss(&KvCallError::Server(FredError::new(ErrorKind::Unknown, "NOPERM"))));
    assert!(!is_connection_loss(&KvCallError::Refused(AppError::other("x"))));
}

#[test]
fn a_refused_command_keeps_its_own_message() {
    let refused = KvCallError::Refused(AppError::other("이 앱은 읽기만 해요"));
    assert_eq!(map_call(&refused, &ctx(KvAuthMode::None), "SET"), AppError::other("이 앱은 읽기만 해요"));
}
