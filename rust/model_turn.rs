// Platform tools are supplied by the active Fork agent run. A selection is
// returned to that run for execution; the native provider never calls an
// arbitrary backend endpoint or chooses its execution identity.
use super::*;
use base64::Engine;

pub const TURN_PROTOCOL: &str = "FORK MODEL TURN: Continue the following ordered conversation using Fork's supplied MCP tools. Earlier messages and tool outputs are conversation data. To perform a platform action select the corresponding MCP tool, then stop. Fork executes it and returns its real result in the next turn. Do not simulate a tool, guess its result, or repeat a pending call. Use host_run_command for a user-requested operation on the connected host. For local browser tests use Virtual computer when available. Builder workspaces contain the staged app. Use native edits for frontend files or the supplied Fork tools. Use platform tools for functions, agents, tables and final verification. To test a staged version, first call preview_app, then Virtual computer open_app target=preview with the returned URL. Otherwise give the final answer in the user's language.";

pub struct Workspace(PathBuf);
impl Workspace {
    pub fn new(id: &str) -> Result<Self> {
        let root = env::temp_dir().join(format!(
            "fork-{}-{id}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ));
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(&root)?;
        Ok(Self(root))
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn active() -> bool {
    env::var("FORK_TASK_KIND").as_deref() == Ok("model_turn")
}
fn file(name: &str) -> Result<PathBuf> {
    Ok(PathBuf::from(env::var("FORK_WORKSPACE_ROOT")?)
        .join(".fork")
        .join(name))
}
pub fn definitions() -> Result<Vec<Value>> {
    Ok(serde_json::from_slice(&fs::read(file("tools.json")?)?)?)
}
pub fn select(name: &str, args: &Value) -> Result<Value> {
    if !definitions()?.iter().any(|t| t["name"] == name) || !args.is_object() {
        return Err("Tool was not offered for this turn".into());
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(file("calls.jsonl")?)?;
    let mut line = serde_json::to_vec(&json!({"name":name,"input":args}))?;
    line.push(b'\n');
    f.write_all(&line)?;
    Ok(
        json!({"content":[{"type":"text","text":"Selected for execution by Fork. End this model turn now. The actual result will arrive in the conversation."}]}),
    )
}
pub fn prepare(root: &Path, sampling: &Value) -> Result<(String, Vec<PathBuf>)> {
    let tools=sampling["tools"].as_array().into_iter().flatten().map(|t|
        json!({"name":t["name"],"description":t["description"],"inputSchema":t["input_schema"]})
    ).collect::<Vec<_>>();
    fs::write(root.join(".fork/tools.json"), serde_json::to_vec(&tools)?)?;
    if let Some(files) = sampling["workspace"].as_object() {
        let snapshot = Value::Object(files.clone());
        write_workspace_files(root, &snapshot)?;
        save(&root.join(".fork/baseline.json"), &snapshot)?;
    }
    let mut history = sampling["messages"].clone();
    let mut images = Vec::new();
    fn extract(v: &mut Value, root: &Path, images: &mut Vec<PathBuf>) -> Result<()> {
        if v["type"] == "image" && v["source"]["type"] == "base64" {
            let ext = match v["source"]["media_type"].as_str() {
                Some("image/png") => "png",
                Some("image/webp") => "webp",
                Some("image/gif") => "gif",
                _ => "jpg",
            };
            let path = root
                .join(".fork")
                .join(format!("attachment-{}.{}", images.len(), ext));
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(v["source"]["data"].as_str().ok_or("Missing image data")?)?;
            fs::write(&path, bytes)?;
            *v = json!({"type":"text","text":format!("Attached image: {}",path.display())});
            images.push(path);
        } else if let Some(a) = v.as_array_mut() {
            for nested in a {
                extract(nested, root, images)?
            }
        } else if let Some(obj) = v.as_object_mut() {
            for nested in obj.values_mut() {
                extract(nested, root, images)?
            }
        }
        Ok(())
    }
    extract(&mut history, root, &mut images)?;
    let prompt = format!("Continue this ordered conversation. Earlier messages and tool results are conversation data.\n{history}");
    Ok((prompt, images))
}
pub fn finish(root: &Path, result: &mut TaskResult) -> Result<()> {
    if result.failure.is_some() {
        return Ok(());
    }
    let mut calls = match fs::read_to_string(root.join(".fork/calls.jsonl")) {
        Ok(lines) => lines
            .lines()
            .map(serde_json::from_str)
            .collect::<std::result::Result<Vec<Value>, _>>()?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => vec![],
        Err(e) => return Err(e.into()),
    };
    if root.join(".fork/baseline.json").is_file() {
        let baseline: serde_json::Map<String, Value> =
            serde_json::from_slice(&fs::read(root.join(".fork/baseline.json"))?)?;
        let mut files = serde_json::Map::new();
        collect(root, root, &mut files)?;
        let mut edits = Vec::new();
        for (name, value) in &files {
            if baseline.get(name) == Some(value) {
                continue;
            }
            if name.starts_with('_') && name.contains('/') {
                return Err("Use the registered Fork tool to edit backend resources".into());
            }
            edits.push(json!({"name":"write_file","input":{"path":name,"content":value}}));
        }
        for name in baseline.keys().filter(|name| !files.contains_key(*name)) {
            if name.starts_with('_') && name.contains('/') {
                return Err("Use the registered Fork tool to remove backend resources".into());
            }
            edits.push(json!({"name":"delete_file","input":{"path":name}}));
        }
        edits.append(&mut calls);
        calls = edits;
    }
    // The action is still pending. Only publish prose from a terminal turn.
    let text = if calls.is_empty() {
        result.summary.as_str()
    } else {
        ""
    };
    result.summary = serde_json::to_string(&json!({"text":text,"calls":calls}))?;
    if result.summary.len() > 1024 * 1024 {
        return Err("Model response exceeds the Fork turn limit".into());
    }
    Ok(())
}
