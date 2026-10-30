//! rustls 0.23은 `ring`(업데이터)과 `aws-lc-rs`(kube)가 함께 컴파일돼 있어서, 기본 provider를 정해 두지 않으면 kube가 클라이언트를 만들 때 패닉한다.
//! 앱 시작 때 한 번 호출한다. 이미 설치돼 있으면 조용히 넘어간다.

pub fn install_crypto_provider() {
    // 이미 설치돼 있으면 Err가 돌아온다. 그대로 두면 되니 버린다.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

#[cfg(test)]
mod tests;
