use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{error::AppError, models::Role};

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Claims {
    pub sub: Uuid,
    pub role: Role,
    pub exp: i64,
    pub iat: i64,
}

pub fn encode_access(
    secret: &str,
    sub: Uuid,
    role: Role,
    ttl_secs: i64,
) -> Result<String, AppError> {
    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        sub,
        role,
        iat: now,
        exp: now + ttl_secs,
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("jwt encode: {e}")))
}

pub fn decode_access(secret: &str, token: &str) -> Result<Claims, AppError> {
    let mut v = Validation::new(Algorithm::HS256);
    v.leeway = 0;
    v.set_required_spec_claims(&["exp", "sub"]);
    decode::<Claims>(token, &DecodingKey::from_secret(secret.as_bytes()), &v)
        .map(|d| d.claims)
        .map_err(|_| AppError::Unauthorized("invalid or expired token".into()))
}

/// New opaque refresh token (256 random bits, hex).
pub fn new_refresh_token() -> String {
    let mut b = [0u8; 32];
    rand::fill(&mut b);
    hex(&b)
}

/// sha256 hex digest, the only form persisted.
pub fn hash_refresh_token(token: &str) -> String {
    hex(Sha256::digest(token.as_bytes()).as_slice())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jwt_roundtrip() {
        let id = Uuid::new_v4();
        let t = encode_access("s3cret", id, Role::Operator, 60).unwrap();
        let c = decode_access("s3cret", &t).unwrap();
        assert_eq!(c.sub, id);
        assert_eq!(c.role, Role::Operator);
        assert_eq!(c.exp - c.iat, 60);
    }

    #[test]
    fn jwt_expired_rejected() {
        let t = encode_access("s3cret", Uuid::new_v4(), Role::Viewer, -5).unwrap();
        assert!(decode_access("s3cret", &t).is_err());
    }

    #[test]
    fn jwt_wrong_secret_rejected() {
        let t = encode_access("a", Uuid::new_v4(), Role::Viewer, 60).unwrap();
        assert!(decode_access("b", &t).is_err());
    }

    #[test]
    fn refresh_hash_deterministic_and_hex() {
        let t = new_refresh_token();
        assert_eq!(t.len(), 64);
        assert_ne!(t, new_refresh_token());
        let h = hash_refresh_token(&t);
        assert_eq!(h, hash_refresh_token(&t));
        assert_eq!(h.len(), 64);
        assert_ne!(h, t);
        assert_eq!(
            hash_refresh_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
