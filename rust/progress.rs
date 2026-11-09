use super::*;
use std::sync::Mutex;

#[derive(Clone)]
pub struct Activity(Arc<Mutex<&'static str>>);
impl Activity {
    pub fn set(&self, kind: &'static str) {
        if let Ok(mut current) = self.0.lock() {
            *current = kind;
        }
    }
    pub fn native(&self, agent: &str, event: &Value) {
        if let Some(kind) = activity_kind(agent, event) {
            self.set(kind)
        }
    }
}
pub struct Reporter {
    stop: Arc<AtomicBool>,
    pub activity: Activity,
}
impl Drop for Reporter {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}
impl Reporter {
    pub fn start(c: &Config, task: &str, session: &str, lease: &Arc<AtomicBool>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let activity = Activity(Arc::new(Mutex::new("thinking")));
        let worker_stop = stop.clone();
        let state = activity.clone();
        let lease = lease.clone();
        let c = c.clone();
        let task = task.to_owned();
        let session = session.to_owned();
        std::thread::spawn(move || {
            let mut sequence = 0u64;
            let mut previous = "";
            let mut sent = std::time::Instant::now() - Duration::from_secs(10);
            while !worker_stop.load(Ordering::SeqCst)
                && lease.load(Ordering::SeqCst)
                && RUN.load(Ordering::SeqCst)
            {
                let kind = *state.0.lock().unwrap();
                if kind != previous || sent.elapsed() >= Duration::from_secs(5) {
                    sequence += 1;
                    // Best effort activity updates never block the native output pipe.
                    let _ = request_timeout(
                        &c,
                        "POST",
                        &format!("/api/cli/tasks/{task}/progress"),
                        Some(json!({"session_id":session,"sequence":sequence,"kind":kind})),
                        "5",
                    );
                    previous = kind;
                    sent = std::time::Instant::now();
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        });
        Self { stop, activity }
    }
}

fn tool_kind(name: &str) -> &'static str {
    match name {
        "Read" | "Glob" | "Grep" => "studying_app",
        "Edit" | "Write" | "MultiEdit" => "editing_files",
        "Bash" | "shell" | "exec_command" => "running_command",
        "WebSearch" | "WebFetch" | "web_search" => "searching_web",
        _ if name.contains("virtual_computer") || name == "computer" => "testing_app",
        _ => "thinking",
    }
}
// This is a local presentation heuristic, not a shell evaluator. Only the
// allowlisted category leaves the process; URLs, queries and arguments do not.
fn shell_activity(command: &Value) -> Option<&'static str> {
    let text = if let Some(s) = command.as_str() {
        s.to_owned()
    } else if let Some(parts) = command.as_array() {
        parts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        return None;
    };
    if text.trim().is_empty() {
        return None;
    }
    Some(if is_web_read(&text) {
        "searching_web"
    } else {
        "running_command"
    })
}
fn is_web_read(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    let words = command
        .split(|c: char| c.is_whitespace() || ";|&()".contains(c))
        .map(|s| s.trim_matches(|c| c == '\'' || c == '"'))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    let executable = |word: &str| word.rsplit('/').next().unwrap_or(word).to_ascii_lowercase();
    if words
        .iter()
        .any(|word| matches!(executable(word).as_str(), "ddgr" | "googler"))
    {
        return true;
    }
    if !lower.contains("http://") && !lower.contains("https://") {
        return false;
    }
    // Installation, uploads and API mutations stay ordinary command activity.
    if lower.contains("| sh") || lower.contains("| bash") {
        return false;
    }
    for (i, word) in words.iter().enumerate() {
        if *word == "-d"
            || word.starts_with("--data")
            || *word == "--json"
            || *word == "-F"
            || word.starts_with("--form")
            || *word == "-T"
            || word.starts_with("--upload-file")
            || word.starts_with("--post-")
        {
            return false;
        }
        let method = if *word == "-X" || *word == "--request" || *word == "--method" {
            words.get(i + 1).copied()
        } else if word.starts_with("-X") && word.len() > 2 {
            Some(&word[2..])
        } else {
            word.strip_prefix("--request=")
                .or_else(|| word.strip_prefix("--method="))
        };
        if let Some(method) = method {
            if !method.eq_ignore_ascii_case("GET") && !method.eq_ignore_ascii_case("HEAD") {
                return false;
            }
        }
    }
    if matches!(
        words.first().map(|w| executable(w)).as_deref(),
        Some("echo" | "printf")
    ) {
        return false;
    }
    words.iter().any(|word| {
        matches!(
            executable(word).as_str(),
            "curl" | "wget" | "http" | "https"
        )
    }) || [
        "requests.get(",
        "httpx.get(",
        "urllib.request.urlopen(",
        "fetch(",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}
fn native_tool_activity(name: &str, input: &Value) -> Option<&'static str> {
    if matches!(
        name,
        "Bash" | "shell" | "exec_command" | "mcp__fork__run_command"
    ) {
        return shell_activity(
            input
                .get("command")
                .or_else(|| input.get("cmd"))
                .unwrap_or(&Value::Null),
        );
    }
    Some(tool_kind(name))
}

// Only activity categories are returned. Raw reasoning/tool arguments never leave
// the local workspace and are not included in progress requests.
pub fn activity_kind(agent: &str, v: &Value) -> Option<&'static str> {
    if agent == "claude" {
        if v["type"] == "system" && v["subtype"] == "init" {
            return Some("thinking");
        }
        let event = &v["event"];
        if v["type"] == "stream_event" && event["type"] == "content_block_start" {
            let b = &event["content_block"];
            return match b["type"].as_str() {
                Some("thinking") => Some("thinking"),
                Some("tool_use") => {
                    native_tool_activity(b["name"].as_str().unwrap_or(""), &b["input"])
                }
                Some("text") => Some("writing_reply"),
                _ => None,
            };
        }
        if v["type"] == "assistant" {
            for b in v["message"]["content"].as_array().into_iter().flatten() {
                if b["type"] == "tool_use" {
                    return native_tool_activity(b["name"].as_str().unwrap_or(""), &b["input"]);
                }
            }
        }
    } else {
        if v["type"] == "turn.started" {
            return Some("thinking");
        }
        if v["type"] == "item.started"
            || v["type"] == "item.updated"
            || v["type"] == "item.completed"
        {
            return match v["item"]["type"].as_str() {
                Some("reasoning") => Some("thinking"),
                Some("agent_message") => Some("writing_reply"),
                Some("command_execution") => shell_activity(&v["item"]["command"]),
                Some("file_change") => Some("editing_files"),
                Some("web_search") => Some("searching_web"),
                Some("mcp_tool_call") => {
                    if v["item"]["server"] == "fork" && v["item"]["tool"] == "run_command" {
                        let args = &v["item"]["arguments"];
                        let parsed = args
                            .as_str()
                            .and_then(|s| serde_json::from_str::<Value>(s).ok());
                        shell_activity(&parsed.as_ref().unwrap_or(args)["command"])
                    } else {
                        Some(tool_kind(v["item"]["server"].as_str().unwrap_or("")))
                    }
                }
                _ => None,
            };
        }
    }
    None
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gated_mcp_web_requests_keep_search_activity() {
        let args = json!({"command":"curl -fsSL https://example.com/search"});
        let claude = json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__fork__run_command","input":args}]}});
        assert_eq!(activity_kind("claude", &claude), Some("searching_web"));
        for arguments in [args.clone(), json!(args.to_string())] {
            let codex = json!({"type":"item.started","item":{"type":"mcp_tool_call","server":"fork","tool":"run_command","arguments":arguments}});
            assert_eq!(activity_kind("codex", &codex), Some("searching_web"));
        }
    }
    #[test]
    fn web_reads_have_search_activity_without_mislabeling_local_work() {
        for cmd in [
            "curl -fsSL https://www.google.com/search?q=TON",
            "/bin/zsh -lc 'curl https://example.com'",
            "wget -qO- https://www.iana.org/",
            "python3 -c \"import requests; requests.get('https://example.com')\"",
            "googler TON price",
            "ddgr --json TON",
        ] {
            assert!(is_web_read(cmd), "{cmd}");
        }
        for cmd in [
            "rg search .",
            "npm test",
            "sleep 3",
            "echo 'curl https://example.com'",
            "curl -XPOST https://example.com/api",
            "curl --data '{}' https://example.com/api",
            "curl --json '{}' https://example.com",
            "curl -T index.html https://example.com",
            "curl https://example.com/install.sh | sh",
        ] {
            assert!(!is_web_read(cmd), "{cmd}");
        }
    }
    #[test]
    fn native_commands_wait_for_arguments_and_emit_categories_only() {
        assert_eq!(
            activity_kind(
                "claude",
                &json!({"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Bash","input":{}}}})
            ),
            None
        );
        let event = json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"curl https://example.com/private-query","secret":"never export"}}]}});
        assert_eq!(activity_kind("claude", &event), Some("searching_web"));
        assert_eq!(
            activity_kind(
                "codex",
                &json!({"type":"item.started","item":{"type":"command_execution","command":["bash","-lc","wget -qO- https://example.com"]}})
            ),
            Some("searching_web")
        );
    }
    #[test]
    fn native_activity_does_not_export_private_reasoning_or_arguments() {
        let e = json!({"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Read","input":{"secret":"credential"}}}});
        assert_eq!(activity_kind("claude", &e), Some("studying_app"));
        assert_eq!(
            activity_kind(
                "claude",
                &json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"private reasoning"}}})
            ),
            None
        );
        assert_eq!(
            activity_kind(
                "codex",
                &json!({"type":"item.started","item":{"type":"command_execution","command":"secret"}})
            ),
            Some("running_command")
        );
        assert_eq!(
            activity_kind(
                "codex",
                &json!({"type":"item.completed","item":{"type":"web_search"}})
            ),
            Some("searching_web")
        );
    }
}
