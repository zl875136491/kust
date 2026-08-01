use aes_gcm::{
    aead::{rand_core::RngCore, Aead, OsRng},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};

use crate::error::AppError;

#[derive(Clone)]
pub struct SecretBox {
    cipher: Aes256Gcm,
}

impl SecretBox {
    pub fn new(secret: &str) -> Self {
        let key: [u8; 32] = Sha256::digest(secret.as_bytes()).into();
        Self {
            cipher: Aes256Gcm::new(&key.into()),
        }
    }

    pub fn encrypt(&self, plaintext: &str) -> Result<String, AppError> {
        let mut nonce_bytes = [0_u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
            .map_err(|_| AppError::internal("unable to encrypt kubeconfig"))?;
        let mut payload = nonce_bytes.to_vec();
        payload.extend(ciphertext);
        Ok(STANDARD.encode(payload))
    }

    pub fn decrypt(&self, encoded: &str) -> Result<String, AppError> {
        let payload = STANDARD
            .decode(encoded)
            .map_err(|_| AppError::internal("stored kubeconfig is invalid"))?;
        if payload.len() <= 12 {
            return Err(AppError::internal("stored kubeconfig is invalid"));
        }
        let plaintext = self
            .cipher
            .decrypt(Nonce::from_slice(&payload[..12]), &payload[12..])
            .map_err(|_| AppError::internal("unable to decrypt kubeconfig"))?;
        String::from_utf8(plaintext)
            .map_err(|_| AppError::internal("stored kubeconfig is not UTF-8"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypts_with_a_random_nonce_and_round_trips() {
        let secrets = SecretBox::new("a-development-secret-that-is-long-enough");
        let first = secrets.encrypt("apiVersion: v1").unwrap();
        let second = secrets.encrypt("apiVersion: v1").unwrap();

        assert_ne!(first, second);
        assert_eq!(secrets.decrypt(&first).unwrap(), "apiVersion: v1");
    }
}
