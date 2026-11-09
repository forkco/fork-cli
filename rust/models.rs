use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Model {
    pub id: String,
    pub label: String,
    pub description: String,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-:/@[]".contains(&b))
}

fn parse(agent: &str, value: &Value) -> Vec<Model> {
    let rows = if agent == "claude" {
        value["response"]["response"]["models"].as_array()
    } else {
        value["result"]["data"].as_array()
    };
    let mut models = Vec::new();
    for row in rows.into_iter().flatten() {
        let id = row[if agent == "claude" { "value" } else { "model" }]
            .as_str()
            .unwrap_or("");
        if id == "default"
            || !valid_id(id)
            || row["hidden"].as_bool() == Some(true)
            || models.iter().any(|m: &Model| m.id == id)
        {
            continue;
        }
        let label = row["displayName"].as_str().unwrap_or(id);
        let description = row["description"].as_str().unwrap_or("");
        models.push(Model {
            id: id.into(),
            label: label.chars().take(80).collect(),
            description: description.chars().take(500).collect(),
        });
        if models.len() == 32 {
            break;
        }
    }
    models
}

// Read model metadata through the native CLI protocol. No prompt or inference
// request is sent, and account/auth fields in initialization are never exported.
pub fn discover(agent: &str) -> Result<Vec<Model>> {
    let root = env::temp_dir().join(format!("fork-models-{}", std::process::id()));
    fs::create_dir_all(&root)?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    let mut cmd = Command::new(agent);
    if agent == "claude" {
        cmd.args([
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            "{\"mcpServers\":{}}",
            "--no-session-persistence",
        ]);
    } else {
        cmd.args(["app-server", "--stdio"]);
    }
    cmd.current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    unsafe {
        cmd.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }
    let mut child = cmd.spawn()?;
    let result = (|| -> Result<Vec<Model>> {
        let mut stdin = child.stdin.take().ok_or("Missing model discovery input")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Missing model discovery output")?;
        let (tx, rx) = mpsc::sync_channel(8);
        std::thread::spawn(move || {
            for line in io::BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.len() > 256 * 1024 {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if (v["type"] == "control_response" || v.get("id").is_some()) && tx.send(v).is_err()
                {
                    break;
                }
            }
        });
        let init = if agent == "claude" {
            json!({"type":"control_request","request_id":"fork-models","request":{"subtype":"initialize"}})
        } else {
            json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"fork_models","version":env!("CARGO_PKG_VERSION")},"capabilities":{}}})
        };
        writeln!(stdin, "{init}")?;
        stdin.flush()?;
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while let Some(timeout) = deadline.checked_duration_since(std::time::Instant::now()) {
            let value = rx.recv_timeout(timeout)?;
            if agent == "claude" && value["response"]["request_id"] == "fork-models" {
                return Ok(parse(agent, &value));
            }
            if agent == "codex" && value["id"] == 1 {
                writeln!(stdin, "{}", json!({"method":"initialized"}))?;
                writeln!(
                    stdin,
                    "{}",
                    json!({"id":2,"method":"model/list","params":{"limit":100}})
                )?;
                stdin.flush()?;
            }
            if agent == "codex" && value["id"] == 2 {
                return Ok(parse(agent, &value));
            }
        }
        Err("Model discovery timed out".into())
    })();
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.wait();
    let _ = fs::remove_dir_all(&root);
    result
}

pub fn selected(task: &Value) -> Result<Option<&str>> {
    let id = task["payload"]["host_model"].as_str().unwrap_or("");
    if id.is_empty() {
        return Ok(None);
    }
    if !valid_id(id) {
        return Err("Invalid Host model".into());
    }
    Ok(Some(id))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_models_are_filtered_without_account_metadata() {
        let rows = parse(
            "claude",
            &json!({"response":{"response":{"account":{"token":"secret"},"models":[{"value":"default"},{"value":"opus","displayName":"Opus","description":"Powerful"},{"value":"opus"},{"value":"--settings"}]}}}),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "opus");
        assert!(!serde_json::to_string(&rows).unwrap().contains("secret"));
        let rows = parse(
            "codex",
            &json!({"result":{"data":[{"model":"native-id","displayName":"Native"},{"model":"hidden","hidden":true}]}}),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "Native");
    }
    #[test]
    fn explicit_selection_is_an_argument_and_default_is_omitted() {
        assert_eq!(selected(&json!({})).unwrap(), None);
        assert_eq!(
            selected(&json!({"payload":{"host_model":"opus[1m]"}})).unwrap(),
            Some("opus[1m]")
        );
        assert!(
            selected(&json!({"payload":{"host_model":"--dangerously-skip-permissions"}})).is_err()
        );
    }
}
