// The official CLI owns PKCE, the token exchange, and local credential storage.
// The service carries the official URL and an opaque, one-use encrypted reply.
use super::{request_timeout, Busy, Config, Result, RUN};
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::{aead, agreement, digest, rand::SystemRandom};
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};

pub(super) fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

pub(super) fn serve(config: &Config, session: &str, id: &str, connected: Arc<AtomicBool>) {
    if !valid_id(session) || !valid_id(id) {
        return;
    }
    let endpoint = format!("/api/cli/sessions/{session}/logins/{id}");
    let result = Busy::acquire()
        .ok_or("Updating")
        .and_then(|_busy| login(config, &endpoint, id, connected).map_err(|_| "Sign-in failed"));
    let state = if result.is_ok() { "done" } else { "failed" };
    let _ = request_timeout(config, "POST", &endpoint, Some(json!({"state":state})), "8");
}

struct LoginChild(Child);
impl Drop for LoginChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn forward_url(output: impl Read, sender: mpsc::Sender<String>) {
    let mut reader = BufReader::new(output);
    let mut line = String::new();
    // Drain both pipes until exit. Closing either after the URL can give the
    // official CLI a broken pipe when it prints its next prompt or success.
    loop {
        line.clear();
        match reader.by_ref().take(8192).read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        for word in line.split_whitespace() {
            if [
                "https://claude.com/cai/oauth/authorize?",
                "https://claude.ai/oauth/authorize?",
            ]
            .iter()
            .any(|prefix| word.starts_with(prefix))
                && word.len() <= 4096
            {
                let _ = sender.send(word.to_owned());
                let _ = std::io::copy(&mut reader, &mut std::io::sink());
                return;
            }
        }
    }
}

fn login(config: &Config, path: &str, id: &str, connected: Arc<AtomicBool>) -> Result<()> {
    let key = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &SystemRandom::new())
        .map_err(|_| "No session key")?;
    let public = key.compute_public_key().map_err(|_| "No public key")?;
    let mut child = LoginChild(
        Command::new("claude")
            .args(["auth", "login"])
            .env("BROWSER", "/usr/bin/false")
            .env("CI", "1")
            .env("SSH_CONNECTION", "127.0.0.1 1 127.0.0.1 22")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?,
    );
    let (tx, rx) = mpsc::channel();
    let output = child.0.stdout.take().ok_or("Missing stdout")?;
    let stderr = child.0.stderr.take().ok_or("Missing stderr")?;
    let tx2 = tx.clone();
    std::thread::spawn(move || forward_url(output, tx));
    std::thread::spawn(move || forward_url(stderr, tx2));
    let url = rx.recv_timeout(Duration::from_secs(20))?;
    request_timeout(
        config,
        "POST",
        path,
        Some(json!({"state":"ready","url":url,"key":STANDARD.encode(public.as_ref())})),
        "8",
    )?;
    let end = Instant::now() + Duration::from_secs(285);
    let mut private = Some(key);
    while connected.load(Ordering::SeqCst) && RUN.load(Ordering::SeqCst) && Instant::now() < end {
        if let Some(status) = child.0.try_wait()? {
            return if status.success() {
                Ok(())
            } else {
                Err("Provider login failed".into())
            };
        }
        if private.is_some() {
            let state = request_timeout(config, "GET", path, None, "8")?;
            if state["state"] == "submitted" {
                let code = open_code(
                    private.take().unwrap(),
                    id,
                    state["sealed"].as_str().ok_or("Missing reply")?,
                )?;
                let mut input = child.0.stdin.take().ok_or("Input closed")?;
                input.write_all(&code)?;
                input.write_all(b"\n")?;
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    Err("Login expired".into())
}

fn open_code(key: agreement::EphemeralPrivateKey, id: &str, encoded: &str) -> Result<Vec<u8>> {
    let mut bytes = STANDARD.decode(encoded)?;
    if !(94..=1536).contains(&bytes.len()) {
        return Err("Invalid reply".into());
    }
    let (peer, rest) = bytes.split_at_mut(65);
    let (iv, data) = rest.split_at_mut(12);
    let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, peer);
    let hash =
        agreement::agree_ephemeral(key, &peer, |secret| digest::digest(&digest::SHA256, secret))
            .map_err(|_| "Invalid key")?;
    let aes = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, hash.as_ref()).map_err(|_| "Invalid key")?,
    );
    let nonce = aead::Nonce::try_assume_unique_for_key(iv).map_err(|_| "Invalid nonce")?;
    let code = aes
        .open_in_place(nonce, aead::Aad::from(id.as_bytes()), data)
        .map_err(|_| "Invalid ciphertext")?;
    if code.is_empty() || code.len() > 1024 || !code.iter().all(|b| b.is_ascii_graphic()) {
        return Err("Invalid login code".into());
    }
    Ok(code.to_vec())
}
