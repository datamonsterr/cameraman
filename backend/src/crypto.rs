use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, Generate, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

const NONCE_LEN: usize = 12;

/// Parse a base64 encoded 32-byte key (`CAMERA_ENC_KEY`).
pub fn parse_key(b64: &str) -> Result<[u8; 32], String> {
    let raw = STANDARD
        .decode(b64.trim())
        .map_err(|_| "CAMERA_ENC_KEY must be base64".to_string())?;
    raw.try_into()
        .map_err(|_| "CAMERA_ENC_KEY must decode to exactly 32 bytes".to_string())
}

/// Deterministic, INSECURE key for dev/tests when `CAMERA_ENC_KEY` is unset.
pub fn dev_key() -> [u8; 32] {
    Sha256::digest(b"cameraman-insecure-dev-camera-enc-key").into()
}

/// Encrypt `plaintext`; returns `nonce(12) || ciphertext+tag`.
pub fn encrypt_secret(key: &[u8; 32], plaintext: &str) -> AppResult<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(key.into());
    let nonce = Nonce::generate();
    let ct = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|_| AppError::Internal("encrypt failed".into()))?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Inverse of [`encrypt_secret`]; fails on a wrong key or any tampering.
pub fn decrypt_secret(key: &[u8; 32], blob: &[u8]) -> AppResult<String> {
    if blob.len() < NONCE_LEN + 16 {
        return Err(AppError::Internal("secret blob too short".into()));
    }
    let (n, ct) = blob.split_at(NONCE_LEN);
    let nonce = Nonce::try_from(n).map_err(|_| AppError::Internal("bad nonce".into()))?;
    let cipher = ChaCha20Poly1305::new(key.into());
    let pt = cipher
        .decrypt(&nonce, ct)
        .map_err(|_| AppError::Internal("secret decrypt failed".into()))?;
    String::from_utf8(pt).map_err(|_| AppError::Internal("secret not utf-8".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let k = dev_key();
        let blob = encrypt_secret(&k, "s3cr3t!").unwrap();
        assert!(blob.len() > NONCE_LEN + 16);
        assert!(!blob.windows(7).any(|w| w == b"s3cr3t!"));
        assert_eq!(decrypt_secret(&k, &blob).unwrap(), "s3cr3t!");
        // nonce is random: same plaintext, different blob
        assert_ne!(blob, encrypt_secret(&k, "s3cr3t!").unwrap());
    }

    #[test]
    fn tamper_and_wrong_key_fail() {
        let k = dev_key();
        let mut blob = encrypt_secret(&k, "pw").unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 1;
        assert!(decrypt_secret(&k, &blob).is_err());
        let good = encrypt_secret(&k, "pw").unwrap();
        assert!(decrypt_secret(&[7u8; 32], &good).is_err());
        assert!(decrypt_secret(&k, &good[..5]).is_err());
    }

    #[test]
    fn key_parsing() {
        let b64 = STANDARD.encode([1u8; 32]);
        assert_eq!(parse_key(&b64).unwrap(), [1u8; 32]);
        assert!(parse_key("not base64!!").is_err());
        assert!(parse_key(&STANDARD.encode([1u8; 16])).is_err());
    }
}
