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
                Some("tool_use") => Some(tool_kind(b["name"].as_str().unwrap_or(""))),
                Some("text") => Some("writing_reply"),
                _ => None,
            };
        }
        if v["type"] == "assistant" {
            for b in v["message"]["content"].as_array().into_iter().flatten() {
                if b["type"] == "tool_use" {
                    return Some(tool_kind(b["name"].as_str().unwrap_or("")));
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
                Some("command_execution") => Some("running_command"),
                Some("file_change") => Some("editing_files"),
                Some("web_search") => Some("searching_web"),
                Some("mcp_tool_call") => {
                    Some(tool_kind(v["item"]["server"].as_str().unwrap_or("")))
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
