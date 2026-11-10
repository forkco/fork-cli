//! Public native actions only. Private reasoning, credentials, file contents and
//! browser screenshots never enter the remote devlog stream.
use super::*;
use std::collections::HashMap;
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};

pub struct Trace {
    sender: Option<SyncSender<Value>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Trace {
    pub fn start(c: &Config, task: &Value, session: &str) -> Self {
        if task["payload"]["build_session_id"].as_str().is_none() {
            return Self {
                sender: None,
                worker: None,
            };
        }
        let (tx, rx) = sync_channel(256);
        let c = c.clone();
        let id = task["id"].as_str().unwrap().to_owned();
        let session = session.to_owned();
        let worker = std::thread::spawn(move || send_batches(c, id, session, rx));
        Self {
            sender: Some(tx),
            worker: Some(worker),
        }
    }
    pub fn capture(&self, root: &Path) -> Capture {
        Capture {
            sender: self.sender.clone(),
            sequence: 0,
            tools: HashMap::new(),
            root: root.to_owned(),
            thinking: false,
        }
    }
    pub fn status(&self, text: &str) {
        if let Some(tx) = &self.sender {
            let _ = tx.try_send(json!({"sequence":900000,"kind":"status","text":text}));
        }
    }
}
impl Drop for Trace {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn send_batches(c: Config, task: String, session: String, rx: Receiver<Value>) {
    loop {
        let first = match rx.recv_timeout(Duration::from_millis(300)) {
            Ok(v) => v,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(_) => return,
        };
        let mut batch = vec![first];
        while batch.len() < 2 {
            match rx.try_recv() {
                Ok(v) => batch.push(v),
                Err(_) => break,
            }
        }
        for attempt in 0..3 {
            if request_timeout(
                &c,
                "POST",
                &format!("/api/cli/tasks/{task}/logs"),
                Some(json!({"session_id":session,"events":batch})),
                "5",
            )
            .is_ok()
            {
                break;
            }
            if attempt == 2 {
                return; // Logging must never hold a failed/offline build open.
            }
            if attempt < 2 {
                std::thread::sleep(Duration::from_millis(150));
            }
        }
    }
}
pub struct Capture {
    sender: Option<SyncSender<Value>>,
    sequence: u64,
    tools: HashMap<String, (String, Value)>,
    root: PathBuf,
    thinking: bool,
}
fn bounded(s: &str, n: usize) -> String {
    {
        let mut end = s.len().min(n);
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s[..end].to_owned()
    }
}
fn visible(text: &str) -> String {
    text.lines()
        .filter(|s| !s.trim().starts_with("<!-- fork-chat:"))
        .collect::<Vec<_>>()
        .join("\n")
}
fn texts(value: &Value) -> String {
    if let Some(s) = value.as_str() {
        return bounded(s, 8000);
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .map(|s| bounded(s, 4000))
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .take(8000)
        .collect()
}
impl Capture {
    fn emit(&mut self, mut event: Value) {
        if let Some(tx) = &self.sender {
            self.sequence += 1;
            event["sequence"] = json!(self.sequence);
            let _ = tx.try_send(event);
        }
    }
    fn thinking(&mut self) {
        if !self.thinking {
            self.emit(json!({"kind":"status","text":"Thinking…"}));
            self.thinking = true;
        }
    }
    fn input(&self, name: &str, args: &Value) -> Value {
        let mut input = json!({});
        let a = if name.contains("virtual_computer") {
            &args["command"]
        } else {
            args
        };
        for (out, keys) in [
            ("command", vec!["command", "cmd"]),
            ("cwd", vec!["cwd"]),
            ("path", vec!["file_path", "path"]),
            ("action", vec!["action"]),
            ("url", vec!["url"]),
            ("selector", vec!["selector"]),
        ] {
            if let Some(s) = keys.iter().find_map(|k| a[*k].as_str()) {
                let s = if out == "path" || out == "cwd" {
                    Path::new(s)
                        .strip_prefix(&self.root)
                        .ok()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| s.to_owned())
                } else {
                    s.to_owned()
                };
                input[out] = json!(bounded(&s, 1000));
            }
        }
        input
    }
    fn tool(&mut self, id: &str, name: &str, args: &Value) {
        if matches!(name, "ToolSearch" | "mcp__fork__propose_app") {
            return;
        }
        let input = self.input(name, args);
        let path = input["path"].as_str().unwrap_or("");
        if path == ".fork" || path.starts_with(".fork/") || path.contains("/.config/fork/") {
            return;
        }
        self.thinking = false;
        self.tools
            .insert(id.to_owned(), (name.to_owned(), input.clone()));
        self.emit(json!({"kind":"tool_call","tool":name,"input":input}));
    }
    fn result(&mut self, id: &str, output: &Value, error: bool) {
        if let Some((name, _)) = self.tools.remove(id) {
            let text = if name.contains("virtual_computer") {
                if error {
                    "Virtual computer action failed"
                } else {
                    "Virtual computer action completed"
                }
                .to_owned()
            } else {
                texts(output)
            };
            self.emit(json!({"kind":"tool_result","tool":name,"output":text,"is_error":error}));
        }
    }
    pub fn native(&mut self, agent: &str, v: &Value) {
        if self.sender.is_none() {
            return;
        }
        if agent == "claude" {
            if v["type"] == "stream_event"
                && v["event"]["type"] == "content_block_start"
                && v["event"]["content_block"]["type"] == "thinking"
            {
                self.thinking();
                return;
            }
            if v["type"] == "assistant" {
                for b in v["message"]["content"].as_array().into_iter().flatten() {
                    match b["type"].as_str() {
                        Some("tool_use") => self.tool(
                            b["id"].as_str().unwrap_or(""),
                            b["name"].as_str().unwrap_or(""),
                            &b["input"],
                        ),
                        Some("text") => {
                            let text = visible(b["text"].as_str().unwrap_or(""));
                            if !text.trim().is_empty() {
                                self.thinking = false;
                                self.emit(json!({"kind":"message","text":bounded(&text,4000)}));
                            }
                        }
                        _ => {}
                    }
                }
            } else if v["type"] == "user" {
                for b in v["message"]["content"].as_array().into_iter().flatten() {
                    if b["type"] == "tool_result" {
                        self.result(
                            b["tool_use_id"].as_str().unwrap_or(""),
                            &b["content"],
                            b["is_error"].as_bool().unwrap_or(false),
                        )
                    }
                }
            }
        } else {
            let item = &v["item"];
            let id = item["id"].as_str().unwrap_or("");
            let started = v["type"] == "item.started";
            let completed = v["type"] == "item.completed";
            if !(started || completed) {
                return;
            }
            match item["type"].as_str() {
                Some("reasoning") => {
                    if started {
                        self.thinking();
                    }
                }
                Some("agent_message") => {
                    if completed {
                        let text = visible(item["text"].as_str().unwrap_or(""));
                        if !text.trim().is_empty() {
                            self.thinking = false;
                            self.emit(json!({"kind":"message","text":bounded(&text,4000)}));
                        }
                    }
                }
                Some("command_execution") => {
                    if started {
                        self.tool(id, "run_command", &json!({"command":item["command"]}));
                    } else {
                        self.result(
                            id,
                            &item["aggregated_output"],
                            item["exit_code"].as_i64().unwrap_or(0) != 0,
                        );
                    }
                }
                Some("mcp_tool_call") => {
                    let name = format!(
                        "mcp__{}__{}",
                        item["server"].as_str().unwrap_or(""),
                        item["tool"].as_str().unwrap_or("")
                    );
                    if started {
                        let args = item["arguments"]
                            .as_str()
                            .and_then(|s| serde_json::from_str::<Value>(s).ok())
                            .unwrap_or_else(|| item["arguments"].clone());
                        self.tool(id, &name, &args);
                    } else {
                        let result = &item["result"];
                        let output = if item["error"].is_null() {
                            &result["content"]
                        } else {
                            &item["error"]
                        };
                        self.result(
                            id,
                            output,
                            item["status"] == "failed"
                                || result["isError"] == true
                                || !item["error"].is_null(),
                        );
                    }
                }
                Some("file_change") => {
                    if completed {
                        let paths = item["changes"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|c| c["path"].as_str())
                            .filter(|p| !p.contains("/.fork/") && !p.starts_with(".fork/"))
                            .map(|p| bounded(p, 500))
                            .take(20)
                            .collect::<Vec<_>>();
                        if !paths.is_empty() {
                            self.emit(json!({"kind":"tool_call","tool":"file_change","input":{"paths":paths}}));
                        }
                    }
                }
                Some("web_search") => {
                    if completed {
                        self.emit(json!({"kind":"status","text":"Searched the web"}));
                    }
                }
                Some("image_generation") => {
                    if started {
                        self.emit(json!({"kind":"status","text":"Generating app artwork…"}));
                    }
                }
                _ => {}
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_actions_exclude_reasoning_and_file_contents() {
        let (tx, rx) = sync_channel(20);
        let mut c = Capture {
            sender: Some(tx),
            sequence: 0,
            tools: HashMap::new(),
            root: PathBuf::from("/tmp/app"),
            thinking: false,
        };
        c.native(
            "codex",
            &json!({"type":"item.started","item":{"type":"reasoning","text":"PRIVATE_THOUGHT"}}),
        );
        c.native("claude",&json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"PRIVATE_THOUGHT"},{"type":"tool_use","id":"1","name":"Write","input":{"file_path":"/tmp/app/index.html","content":"PRIVATE_FILE_CONTENT"}}]}}));
        c.native("claude",&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"1","content":"File written"}]}}));
        let values = rx.try_iter().collect::<Vec<_>>();
        let raw = serde_json::to_string(&values).unwrap();
        assert!(!raw.contains("PRIVATE_"));
        assert!(raw.contains("index.html"));
        assert!(raw.contains("File written"));
        assert_eq!(values.len(), 3);
    }
}
