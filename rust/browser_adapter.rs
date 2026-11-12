// The self-updater replaces the CLI binary. Keep the small SDK adapter with
// that binary and reuse Chromium and dependencies from the optional package.
use super::*;
pub fn entry(installed: &Path) -> Result<PathBuf> {
    let src = installed
        .parent()
        .ok_or("Invalid Virtual computer installation")?
        .canonicalize()?;
    let parent = dir().join("virtual-computer");
    let target = parent.join(concat!("adapter-", env!("CARGO_PKG_VERSION")));
    if !target.is_dir() {
        let tmp = parent.join(format!("adapter-tmp-{}", std::process::id()));
        fs::create_dir(&tmp)?;
        let result = (|| -> Result<()> {
            fs::write(tmp.join("package.json"), r#"{"type":"module"}"#)?;
            for (name, data) in [
                (
                    "owner-browser.js",
                    include_str!("../virtual-computer/src/owner-browser.js"),
                ),
                ("stdio.js", include_str!("../virtual-computer/src/stdio.js")),
                (
                    "browser-check.js",
                    include_str!("../virtual-computer/src/browser-check.js"),
                ),
                (
                    "virtual-computer.js",
                    include_str!("../virtual-computer/src/virtual-computer.js"),
                ),
            ] {
                fs::write(tmp.join(name), data)?;
            }
            for name in ["sessions.js", "network.js", "config.js"] {
                std::os::unix::fs::symlink(src.join(name), tmp.join(name))?;
            }
            if let Err(e) = fs::rename(&tmp, &target) {
                if !target.is_dir() {
                    return Err(e.into());
                }
            }
            Ok(())
        })();
        let _ = fs::remove_dir_all(tmp);
        result?;
    }
    Ok(target.join(installed.file_name().ok_or("Missing browser entry")?))
}
