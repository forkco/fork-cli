//! Self replacement uses public, checksummed release assets. Fork credentials
//! are used only to read and acknowledge a device-bound approval on its origin.
use super::*;
use std::os::fd::AsRawFd;
fn version(v: &str) -> Option<[u32; 3]> {
    let parts: Vec<_> = v.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || p.len() > 4 || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    Some([
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ])
}
fn latest() -> Result<String> {
    let out = Command::new("curl")
        .args([
            "-q",
            "-fsSL",
            "--proto",
            "=https",
            "--max-time",
            "30",
            "--max-filesize",
            "131072",
            "-H",
            "User-Agent: Fork-CLI",
            "https://api.github.com/repos/forkco/fork-cli/releases/latest",
        ])
        .output()?;
    if !out.status.success() {
        return Err("Cannot check the latest Fork CLI release".into());
    }
    let data: Value = serde_json::from_slice(&out.stdout)?;
    let v = data["tag_name"]
        .as_str()
        .unwrap_or("")
        .strip_prefix('v')
        .unwrap_or("");
    if version(v).is_none() || data["prerelease"] != false || data["draft"] != false {
        return Err("Invalid stable release".into());
    }
    Ok(v.into())
}
fn download(url: &str, path: &Path, max: &str) -> Result<()> {
    if !Command::new("curl")
        .args([
            "-q",
            "-fsSL",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--connect-timeout",
            "15",
            "--max-time",
            "300",
            "--max-filesize",
            max,
            "-o",
        ])
        .arg(path)
        .arg(url)
        .status()?
        .success()
    {
        return Err("Release download failed".into());
    }
    Ok(())
}
fn checksum(manifest: &str, asset: &str) -> Option<String> {
    manifest.lines().find_map(|line| {
        let p: Vec<_> = line.split_whitespace().collect();
        if p.len() == 2
            && p[1].trim_start_matches('*') == asset
            && p[0].len() == 64
            && p[0].bytes().all(|b| b.is_ascii_hexdigit())
        {
            Some(p[0].to_ascii_lowercase())
        } else {
            None
        }
    })
}
fn verify(path: &Path, expected: &str) -> Result<()> {
    let result = Command::new("sha256sum").arg(path).output().or_else(|_| {
        Command::new("shasum")
            .args(["-a", "256"])
            .arg(path)
            .output()
    })?;
    let hash = String::from_utf8(result.stdout)?;
    if !result.status.success() || hash.split_whitespace().next() != Some(expected) {
        return Err("Release checksum mismatch".into());
    }
    Ok(())
}
fn prepare_update() -> Result<bool> {
    let mut socket = UnixStream::connect(dir().join("control.sock"))?;
    socket.set_read_timeout(Some(Duration::from_secs(2)))?;
    socket.write_all(b"prepare-update")?;
    let mut reply = String::new();
    socket.read_to_string(&mut reply)?;
    let value: Value = serde_json::from_str(&reply)?;
    Ok(value["ready"]
        .as_bool()
        .ok_or("Runner has no update status support")?)
}
fn approved(c: &Config, id: &str, target: &str) -> Result<()> {
    let record = request(c, "GET", &format!("/api/cli/updates/{id}"), None)?;
    if record["state"] != "updating" || record["version"] != target {
        return Err("Update approval expired or changed".into());
    }
    Ok(())
}
fn replace(target: &str, force: bool, approval: Option<(&Config, &str)>) -> Result<()> {
    let current = version(env!("CARGO_PKG_VERSION")).unwrap();
    let desired = version(target).ok_or("Invalid version")?;
    if desired < current {
        return Err("Refusing to downgrade Fork CLI".into());
    }
    if desired == current && !force {
        println!("Fork CLI {target} is up to date");
        return Ok(());
    }
    let exe = env::current_exe()?.canonicalize()?;
    let parent = exe.parent().ok_or("Missing install directory")?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .mode(0o600)
        .open(parent.join(".fork-update.lock"))?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("Another Fork CLI update is running".into());
    }
    let temp = parent.join(format!(".fork-update-{}", std::process::id()));
    fs::create_dir(&temp)?;
    fs::set_permissions(&temp, fs::Permissions::from_mode(0o700))?;
    let result = (|| -> Result<()> {
        let os = match env::consts::OS {
            "linux" => "linux",
            "macos" => "darwin",
            _ => return Err("Unsupported platform".into()),
        };
        let arch = match env::consts::ARCH {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            _ => return Err("Unsupported architecture".into()),
        };
        let asset = format!("fork-agent-{os}-{arch}");
        let base = format!("https://github.com/forkco/fork-cli/releases/download/v{target}");
        let sums = temp.join("SHA256SUMS");
        let binary = temp.join("fork");
        download(&format!("{base}/SHA256SUMS"), &sums, "65536")?;
        download(&format!("{base}/{asset}"), &binary, "16777216")?;
        verify(
            &binary,
            &checksum(&fs::read_to_string(sums)?, &asset).ok_or("Release checksum missing")?,
        )?;
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755))?;
        let probe = Command::new(&binary).arg("version").output()?;
        if !probe.status.success()
            || String::from_utf8(probe.stdout)?.trim() != format!("fork {target}")
        {
            return Err("Downloaded binary version does not match the approved release".into());
        }
        let backup = temp.join("previous");
        fs::hard_link(&exe, &backup)?;
        if let Some((c, id)) = approval {
            approved(c, id, target)?;
        }
        let running = UnixStream::connect(dir().join("control.sock")).is_ok();
        if running {
            println!("Waiting for the current task to finish…");
            for attempt in 0..600 {
                if prepare_update()? {
                    break;
                }
                if attempt == 599 {
                    return Err("Current task is still running; update later".into());
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        if let Some((c, id)) = approval {
            if let Err(e) = approved(c, id, target) {
                if running {
                    let _ = stop();
                    let _ = start();
                }
                return Err(e);
            }
        }
        if running {
            stop()?;
        }
        if let Err(e) = fs::rename(&binary, &exe) {
            if running {
                let _ = start();
            }
            return Err(e.into());
        }
        let restarted = if running {
            Command::new(&exe)
                .arg("start")
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        } else {
            true
        };
        if !restarted {
            let _ = stop();
            fs::rename(&backup, &exe)?;
            if running {
                let _ = Command::new(&exe).arg("start").status();
            }
            return Err("New runner failed to start; restored the previous version".into());
        }
        println!("Fork CLI updated to {target}");
        Ok(())
    })();
    let _ = fs::remove_dir_all(temp);
    result
}
pub(super) fn manual(force: bool) -> Result<()> {
    replace(&latest()?, force, None)
}
pub(super) fn worker(id: &str) -> Result<()> {
    if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("Invalid update request".into());
    }
    let c = cfg()?;
    let record = request(&c, "GET", &format!("/api/cli/updates/{id}"), None)?;
    let target = record["version"]
        .as_str()
        .ok_or("Missing approved version")?;
    approved(&c, id, target)?;
    let result = replace(target, true, Some((&c, id)));
    if result.is_err() {
        let _ = request(
            &c,
            "POST",
            &format!("/api/cli/updates/{id}/complete"),
            Some(json!({"state":"failed","error":"CLI update failed; check update.log and retry"})),
        );
        return result;
    }
    for _ in 0..60 {
        if request_timeout(
            &c,
            "POST",
            &format!("/api/cli/updates/{id}/complete"),
            Some(json!({"state":"completed"})),
            "5",
        )
        .is_ok()
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    Err("Updated, but confirmation is pending; check fork status".into())
}
pub(super) fn spawn(id: &str) -> Result<()> {
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(dir().join("update.log"))?;
    let mut cmd = Command::new(env::current_exe()?);
    cmd.args(["_update-worker", id])
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn()?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_values_cannot_be_urls_or_paths() {
        for value in [
            "../0.4.7",
            "v0.4.7",
            "0.4.7/x",
            "0.4",
            "0.4.7;id",
            "0.4.7-beta",
        ] {
            assert!(version(value).is_none());
        }
        assert!(version("0.10.0") > version("0.9.9"));
    }
    #[test]
    fn checksums_bind_to_exact_asset() {
        let hash = "ab".repeat(32);
        let manifest = format!("{hash}  fork-linux-amd64\n");
        assert_eq!(checksum(&manifest, "fork-linux-amd64"), Some(hash));
        assert!(checksum(&manifest, "fork-darwin-amd64").is_none());
        assert!(checksum("bad fork-linux-amd64", "fork-linux-amd64").is_none());
    }
}
