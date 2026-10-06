use std::path::{Path, PathBuf};

pub const PROTOCOL_VERSION: u64 = 1;
pub const QUERY_TIMEOUT_SECS: u64 = 35;
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_ENVELOPE_ID_CHARS: usize = 200;
pub const MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;
pub const SHUTDOWN_GRACE_MILLIS: u64 = 2_000;
pub const SHUTDOWN_POLL_MILLIS: u64 = 10;

pub fn runtime_files(resources: &Path, entry: &str) -> (PathBuf, PathBuf) {
    let node = if cfg!(windows) { "node.exe" } else { "node" };
    (
        resources.join("runtime").join(node),
        resources.join("app").join(entry),
    )
}

// CLI inspect runs before Tauri creates a GUI or application handle.
pub fn cli_resources() -> std::io::Result<PathBuf> {
    let executable = std::env::current_exe()?;
    let directory = executable
        .parent()
        .ok_or_else(|| std::io::Error::other("Missing executable directory"))?;
    let resources = if cfg!(target_os = "macos") {
        directory.join("../Resources")
    } else {
        directory.to_path_buf()
    };
    if resources.join("runtime").is_dir() {
        return Ok(resources);
    }
    if cfg!(debug_assertions) {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"));
    }
    Err(std::io::Error::other(
        "Bundled runtime resources are missing",
    ))
}
