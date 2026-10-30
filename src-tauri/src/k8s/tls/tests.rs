use super::*;

#[test]
fn installing_twice_is_fine() {
    install_crypto_provider();
    install_crypto_provider();
    assert!(rustls::crypto::CryptoProvider::get_default().is_some());
}
