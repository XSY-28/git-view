//! Private, bounded OS bridge. No web command exposes this entry point.
use serde_json::{json, Value};
use std::os::windows::{fs::MetadataExt, process::CommandExt};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    ptr, thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{Diagnostics::ToolHelp::*, Threading::*},
};

struct Local(*mut core::ffi::c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn error() -> String {
    std::io::Error::last_os_error().to_string()
}
unsafe fn sid_string(sid: PSID) -> Result<String, String> {
    let mut p = ptr::null_mut();
    if ConvertSidToStringSidW(sid, &mut p) == 0 {
        return Err(error());
    }
    let _memory = Local(p as _);
    let mut n = 0;
    while *p.add(n) != 0 {
        n += 1;
    }
    Ok(String::from_utf16_lossy(std::slice::from_raw_parts(p, n)))
}
fn user_sid() -> Result<String, String> {
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(error());
        }
        let result = (|| {
            let mut len = 0;
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut len);
            let mut data = vec![0u64; (len as usize + 7) / 8];
            if GetTokenInformation(token, TokenUser, data.as_mut_ptr() as _, len, &mut len) == 0 {
                return Err(error());
            }
            sid_string((*(data.as_ptr() as *const TOKEN_USER)).User.Sid)
        })();
        CloseHandle(token);
        result
    }
}
fn no_reparse(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Absolute paths required".into());
    }
    for ancestor in path.ancestors() {
        if fs::symlink_metadata(ancestor)
            .map_err(|e| e.to_string())?
            .file_attributes()
            & FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err(
                "Reparse points are not allowed in private state or replacement paths".into(),
            );
        }
    }
    Ok(())
}
fn private(path: &Path, sid: &str, tighten: bool) -> Result<(), String> {
    no_reparse(path)?;
    let text = path.to_str().ok_or("Non-Unicode path")?;
    let name = wide(text);
    unsafe {
        let mut owner = ptr::null_mut();
        let mut acl = ptr::null_mut();
        let mut sd = ptr::null_mut();
        let code = GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut acl,
            ptr::null_mut(),
            &mut sd,
        );
        if code != 0 {
            return Err(format!("Security descriptor error {code}"));
        }
        let _original = Local(sd);
        let owner = sid_string(owner)?;
        if owner != sid && owner != "S-1-5-32-544" {
            return Err("Private state belongs to a different account".into());
        }
        if tighten {
            let sddl = wide(&format!(
                "D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
            ));
            let mut secure = ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut secure,
                ptr::null_mut(),
            ) == 0
            {
                return Err(error());
            }
            let _secure = Local(secure);
            let mut present = 0;
            let mut defaulted = 0;
            let mut dacl = ptr::null_mut();
            if GetSecurityDescriptorDacl(secure, &mut present, &mut dacl, &mut defaulted) == 0
                || present == 0
                || dacl.is_null()
            {
                return Err("Missing protected DACL".into());
            }
            let code = SetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                dacl,
                ptr::null_mut(),
            );
            if code != 0 {
                return Err(format!("Cannot protect private state: {code}"));
            }
            return Ok(());
        }
        if acl.is_null() {
            return Err("Unrestricted private state DACL".into());
        }
        for i in 0..(*acl).AceCount as u32 {
            let mut ace = ptr::null_mut();
            if GetAce(acl, i, &mut ace) == 0 {
                return Err(error());
            }
            let header = &*(ace as *const ACE_HEADER);
            if header.AceType == 1 {
                continue;
            } // DENY never grants access.
            if header.AceType != 0 {
                return Err("Unsupported private state access rule".into());
            }
            let allowed = &*(ace as *const ACCESS_ALLOWED_ACE);
            let principal = sid_string(&allowed.SidStart as *const u32 as PSID)?;
            if principal != sid && principal != "S-1-5-18" && principal != "S-1-5-32-544" {
                return Err("Private state grants access to another principal".into());
            }
        }
    }
    Ok(())
}
fn replace(source: &Path, target: &Path) -> Result<(), String> {
    if source.parent() != target.parent() {
        return Err("Replacement must stay in one directory".into());
    }
    no_reparse(source)?;
    no_reparse(target.parent().ok_or("Missing parent")?)?;
    if target.exists() {
        no_reparse(target)?;
    }
    let source = wide(source.to_str().ok_or("Non-Unicode path")?);
    let target = wide(target.to_str().ok_or("Non-Unicode path")?);
    for attempt in 0..8 {
        unsafe {
            if MoveFileExW(
                source.as_ptr(),
                target.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            ) != 0
            {
                return Ok(());
            }
            let code = GetLastError();
            if ![ERROR_SHARING_VIOLATION, ERROR_ACCESS_DENIED].contains(&code) || attempt == 7 {
                return Err(format!("File replacement failed: {code}"));
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    unreachable!()
}
fn resume(pid: u32) -> Result<(), String> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(error());
        }
        let result = (|| {
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of_val(&entry) as u32;
            let mut next = Thread32First(snapshot, &mut entry);
            while next != 0 {
                if entry.th32OwnerProcessID == pid {
                    let handle = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if handle.is_null() {
                        return Err(error());
                    }
                    let count = ResumeThread(handle);
                    CloseHandle(handle);
                    return if count == u32::MAX {
                        Err(error())
                    } else {
                        Ok(())
                    };
                }
                next = Thread32Next(snapshot, &mut entry);
            }
            Err("Suspended Git thread not found".into())
        })();
        CloseHandle(snapshot);
        result
    }
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    let s = v[key].as_str().ok_or_else(|| format!("Missing {key}"))?;
    if s.contains('\0') {
        return Err("NUL is not allowed".into());
    }
    Ok(s)
}
fn run_git(v: &Value) -> Result<Value, String> {
    use std::process::{Command, Stdio};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let cwd = PathBuf::from(string(v, "cwd")?);
    if !cwd.is_absolute() {
        return Err("Absolute cwd required".into());
    }
    let marker = string(v, "marker")?;
    if !marker.starts_with("git-view:") || marker.len() != 45 {
        return Err("Invalid operation marker".into());
    }
    let kind = string(v, "kind")?;
    let (args, input): (Vec<String>, Option<String>) = match kind {
        "commit" => (
            vec![
                "commit".into(),
                "--file=-".into(),
                "--cleanup=verbatim".into(),
                "--no-status".into(),
            ],
            Some(string(v, "message")?.into()),
        ),
        "create-branch" => {
            let b = string(v, "branch")?;
            let oid = string(v, "oid")?;
            if ![40, 64].contains(&oid.len()) || !oid.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err("Invalid OID".into());
            }
            (
                vec![
                    "update-ref".into(),
                    "--no-deref".into(),
                    "--create-reflog".into(),
                    "-m".into(),
                    marker.into(),
                    "--stdin".into(),
                ],
                Some(format!("create refs/heads/{b} {oid}\n")),
            )
        }
        "switch-branch" => (
            vec![
                "switch".into(),
                "--no-guess".into(),
                "--no-recurse-submodules".into(),
                "--no-overwrite-ignore".into(),
                "--".into(),
                string(v, "branch")?.into(),
            ],
            None,
        ),
        _ => return Err("Unsupported Git write command".into()),
    };
    let mut child = Command::new("git")
        .args([
            "--no-pager",
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "submodule.recurse=false",
            "-c",
            "protocol.allow=never",
            "-c",
            "core.logAllRefUpdates=true",
            "-c",
            "gc.auto=0",
            "-c",
            "maintenance.auto=false",
        ])
        .args(args)
        .current_dir(cwd)
        .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let job = match crate::sidecar::WindowsJob::assign(&child) {
        Ok(job) => job,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    if let Err(e) = resume(child.id()) {
        drop(job);
        let _ = child.wait();
        return Err(e);
    }
    let mut job = Some(job);
    let overflow = Arc::new(AtomicUsize::new(0));
    fn reader(
        mut stream: impl Read + Send + 'static,
        overflow: Arc<AtomicUsize>,
    ) -> thread::JoinHandle<String> {
        thread::spawn(move || {
            let mut tail = Vec::new();
            let mut chunk = [0u8; 4096];
            while let Ok(n) = stream.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                overflow.fetch_add(n, Ordering::SeqCst);
                tail.extend_from_slice(&chunk[..n]);
                if tail.len() > 8000 {
                    tail.drain(..tail.len() - 8000);
                }
            }
            String::from_utf8_lossy(&tail).into_owned()
        })
    }
    let out = reader(child.stdout.take().unwrap(), overflow.clone());
    let err = reader(child.stderr.take().unwrap(), overflow.clone());
    let stdin = child.stdin.take().unwrap();
    let input_writer = thread::spawn(move || {
        let mut stdin = stdin;
        if let Some(input) = input {
            let _ = stdin.write_all(input.as_bytes());
        }
    });
    let deadline = Instant::now()
        + Duration::from_millis(v["timeoutMs"].as_u64().unwrap_or(60000).clamp(1, 120000));
    let mut interrupted = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if Instant::now() >= deadline || overflow.load(Ordering::SeqCst) > 1024 * 1024 {
            interrupted = true;
            drop(job.take());
            break child.wait().map_err(|e| e.to_string())?;
        }
        thread::sleep(Duration::from_millis(10));
    };
    // Dropping a normal-result job also ends any detached descendants holding pipes.
    // The job was moved only on the interrupted path.
    drop(job.take());
    let _ = input_writer.join();
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    interrupted |= overflow.load(Ordering::SeqCst) > 1024 * 1024;
    let diagnostic = format!(
        "{}{}{}",
        if interrupted {
            "Git 或其 hooks/签名程序超时或输出超限，已终止 Windows 进程树。\n"
        } else {
            ""
        },
        stdout,
        stderr
    );
    Ok(json!({"code":status.code(),"diagnostic":diagnostic,"interrupted":interrupted}))
}
fn dispatch(v: &Value) -> Result<Value, String> {
    let operation = string(v, "operation")?;
    if operation == "run-git" {
        return run_git(v);
    }
    let path = PathBuf::from(string(v, "path")?);
    match operation {
        "private-directory" => {
            if !path.is_dir() {
                return Err("Private directory missing".into());
            }
            private(&path, &user_sid()?, true)?;
            private(&path, &user_sid()?, false)?;
        }
        "check-private" => private(&path, &user_sid()?, false)?,
        "replace" => replace(&path, &PathBuf::from(string(v, "target")?))?,
        _ => return Err("Unsupported filesystem operation".into()),
    }
    Ok(json!(true))
}
pub fn main() {
    let mut input = String::new();
    let result = std::io::stdin()
        .take(512 * 1024)
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())
        .and_then(|_| serde_json::from_str::<Value>(&input).map_err(|e| e.to_string()))
        .and_then(|v| dispatch(&v));
    let response = match result {
        Ok(data) => json!({"ok":true,"data":data}),
        Err(message) => json!({"ok":false,"error":message}),
    };
    println!("{response}");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_acl_and_write_through_replacement_work_on_unicode_paths() {
        let root =
            std::env::temp_dir().join(format!("git-view-native-中文-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let result = (|| -> Result<(), String> {
            let sid = user_sid()?;
            private(&root, &sid, true)?;
            private(&root, &sid, false)?;
            let old = root.join("回执.json");
            let new = root.join("回执.tmp");
            fs::write(&old, b"old").map_err(|e| e.to_string())?;
            fs::write(&new, b"new").map_err(|e| e.to_string())?;
            private(&old, &sid, false)?;
            replace(&new, &old)?;
            assert_eq!(fs::read(&old).unwrap(), b"new");
            assert!(!new.exists());
            private(&old, &sid, false)?;
            Ok(())
        })();
        let _ = fs::remove_dir_all(&root);
        result.unwrap();
    }
    #[test]
    fn refuses_replacement_and_private_reads_through_a_directory_junction() {
        let root = std::env::temp_dir().join(format!("git-view-junction-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let target = root.join("target");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("source"), b"original").unwrap();
        let link = root.join("link");
        let result = (|| -> Result<(), String> {
            let output = std::process::Command::new("cmd.exe")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(&link)
                .arg(&target)
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).into_owned());
            }
            assert!(private(&link.join("source"), &user_sid()?, false).is_err());
            assert!(replace(&link.join("source"), &link.join("destination")).is_err());
            assert_eq!(fs::read(target.join("source")).unwrap(), b"original");
            Ok(())
        })();
        let _ = fs::remove_dir_all(&root);
        result.unwrap();
    }
    #[test]
    fn rejects_a_private_receipt_with_an_everyone_allow_rule() {
        let root = std::env::temp_dir().join(format!("git-view-acl-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let sid = user_sid().unwrap();
        private(&root, &sid, true).unwrap();
        let file = root.join("receipt.json");
        fs::write(&file, b"{}").unwrap();
        let output = std::process::Command::new("icacls")
            .arg(&file)
            .args(["/grant", "*S-1-1-0:(R)"])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(private(&file, &sid, false).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
