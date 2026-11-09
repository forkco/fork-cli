//! Task-scoped MCP tools. Native shell tools are disabled; every server command
//! passes through the web approval endpoint before a process is spawned.
use super::*;

fn tool_text(text: String, error: bool) -> Value {
    json!({"content":[{"type":"text","text":text}],"isError":error})
}
fn context() -> Result<(String, String, PathBuf)> {
    let task = env::var("FORK_TASK_ID")?;
    let session = env::var("FORK_SESSION_ID")?;
    for id in [&task, &session] {
        if id.len() != 36 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            return Err("Invalid task context".into());
        }
    }
    Ok((
        task,
        session,
        PathBuf::from(env::var("FORK_WORKSPACE_ROOT")?).canonicalize()?,
    ))
}
fn schemas() -> Value {
    json!([{"name":"run_command","description":"Run a shell command on the user's connected server. The web UI must approve it before execution. A denial must be respected; never work around it with another tool.","inputSchema":{"type":"object","properties":{"command":{"type":"string"},"cwd":{"type":"string","description":"Absolute working directory; defaults to the task workspace"},"timeout_seconds":{"type":"integer","minimum":1,"maximum":300}},"required":["command"],"additionalProperties":false}},
    {"name":"propose_app","description":"Send Fork's standard app proposal card. Creating a new Fork app MUST use this tool, then wait until the user clicks Create app in the web UI. Never generate app files in a chat before that confirmation.","inputSchema":{"type":"object","properties":{"app_name":{"type":"string","description":"Short lowercase URL slug"},"title":{"type":"string"},"description":{"type":"string"},"features":{"type":"array","items":{"type":"string"}},"name_options":{"type":"array","items":{"type":"string"}},"bg_color":{"type":"string"},"bg_color_light":{"type":"string"},"app_type":{"type":"string","enum":["web","website","document","agent"]},"website_name":{"type":"string"},"no_auth":{"type":"boolean"}},"required":["app_name","title","description","features"],"additionalProperties":false}}])
}
fn read_output(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let mut block = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut block) {
            if n == 0 {
                break;
            }
            let keep = n.min(100_000usize.saturating_sub(out.len()));
            out.extend_from_slice(&block[..keep]);
        }
        out
    })
}
fn execute(command: &str, cwd: &Path, timeout: u64) -> Result<Value> {
    let mut cmd = Command::new("sh");
    cmd.args(["-lc", command])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        cmd.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }
    let mut child = cmd.spawn()?;
    let stdout = read_output(child.stdout.take().unwrap());
    let stderr = read_output(child.stderr.take().unwrap());
    let started = std::time::Instant::now();
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait()? {
            break (status, false);
        }
        if !RUN.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs(timeout) {
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            break (child.wait()?, true);
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    Ok(tool_text(
        format!(
            "exit_code: {}{}\nstdout:\n{}\nstderr:\n{}",
            status.code().unwrap_or(-1),
            if timed_out {
                " (cancelled or timed out)"
            } else {
                ""
            },
            String::from_utf8_lossy(&out),
            String::from_utf8_lossy(&err)
        ),
        !status.success(),
    ))
}
fn call(name: &str, args: &Value) -> Result<Value> {
    let (task, session, root) = context()?;
    let c = cfg()?;
    match name {
        "run_command" => {
            let command = args["command"]
                .as_str()
                .filter(|s| !s.trim().is_empty() && s.len() <= 12000 && !s.contains('\0'))
                .ok_or("Invalid command")?;
            let cwd = args["cwd"]
                .as_str()
                .map(PathBuf::from)
                .unwrap_or(root)
                .canonicalize()?;
            if !cwd.is_dir() {
                return Err("Working directory is not a directory".into());
            }
            let answer = request_timeout(
                &c,
                "POST",
                &format!("/api/cli/tasks/{task}/command-approval"),
                Some(json!({"session_id":session,"command":command,"cwd":cwd})),
                "660",
            )?;
            if answer["approved"] != true {
                return Ok(tool_text("The user denied or cancelled this command. Do not execute it or try another tool to bypass this decision.".into(),true));
            }
            execute(
                command,
                &cwd,
                args["timeout_seconds"]
                    .as_u64()
                    .unwrap_or(120)
                    .clamp(1, 300),
            )
        }
        "propose_app" => {
            let answer = request(
                &c,
                "POST",
                &format!("/api/cli/tasks/{task}/proposal"),
                Some(json!({"session_id":session,"proposal":args})),
            )?;
            Ok(tool_text(format!("App proposal sent: {answer}. Stop here and wait for the user to click Create app in Fork. Do not build it in this chat."),false))
        }
        _ => Err("Unknown tool".into()),
    }
}
pub fn serve() -> Result<()> {
    context()?;
    unsafe {
        libc::signal(libc::SIGTERM, stop_signal as *const () as usize);
    }
    for line in io::stdin().lock().lines() {
        let line = line?;
        if line.len() > 100_000 {
            return Err("MCP message too large".into());
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(id) = request.get("id") else {
            continue;
        };
        let result = match request["method"].as_str().unwrap_or("") {
            "initialize" => {
                json!({"protocolVersion":request["params"]["protocolVersion"].as_str().unwrap_or("2024-11-05"),"capabilities":{"tools":{}},"serverInfo":{"name":"fork","version":env!("CARGO_PKG_VERSION")}})
            }
            "ping" => json!({}),
            "tools/list" => json!({"tools":schemas()}),
            "tools/call" => call(
                request["params"]["name"].as_str().unwrap_or(""),
                &request["params"]["arguments"],
            )
            .unwrap_or_else(|e| tool_text(e.to_string(), true)),
            _ => {
                println!(
                    "{}",
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}})
                );
                continue;
            }
        };
        println!("{}", json!({"jsonrpc":"2.0","id":id,"result":result}));
        io::stdout().flush()?;
    }
    Ok(())
}

pub fn claude_config(c: &Config) -> Result<String> {
    let mut config: Value = serde_json::from_str(&virtual_mcp()?)?;
    if !c.virtual_computer {
        config["mcpServers"].as_object_mut().unwrap().clear();
    }
    config["mcpServers"]["fork"] =
        json!({"command":env::current_exe()?,"args":["agent-tools"],"env":tool_environment()?});
    Ok(config.to_string())
}
fn tool_environment() -> Result<Value> {
    let mut envs = json!({"FORK_CONFIG_DIR":dir()});
    for key in ["FORK_TASK_ID", "FORK_SESSION_ID", "FORK_WORKSPACE_ROOT"] {
        envs[key] = json!(env::var(key)?);
    }
    Ok(envs)
}
pub fn codex_config(c: &Config) -> Result<String> {
    let exe = serde_json::to_string(&env::current_exe()?.to_string_lossy())?;
    let envs = tool_environment()?
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(",");
    let virtual_pc = if c.virtual_computer {
        format!(",virtual_computer={{command={exe},args=[\"virtual-computer\"],env={},required=true,enabled_tools=[\"computer\"],tools={{computer={{approval_mode=\"approve\"}}}}}}",codex_environment()?)
    } else {
        String::new()
    };
    Ok(format!("mcp_servers={{fork={{command={exe},args=[\"agent-tools\"],env={{{envs}}},required=true,tool_timeout_sec=660,tools={{run_command={{approval_mode=\"approve\"}},propose_app={{approval_mode=\"approve\"}}}}}}{virtual_pc}}}"))
}
