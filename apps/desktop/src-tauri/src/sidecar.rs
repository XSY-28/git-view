use crate::config;
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;
struct Running {
    child: Child,
    stdin: ChildStdin,
    generation: u64,
    #[cfg(windows)]
    job: WindowsJob,
}
struct Inner {
    running: Option<Running>,
    generation: u64,
    pending: HashMap<String, (u64, oneshot::Sender<Reply>)>,
}
#[derive(Clone)]
pub struct Sidecar {
    resources: PathBuf,
    inner: Arc<Mutex<Inner>>,
}

impl Sidecar {
    pub fn new(resources: PathBuf) -> Self {
        Self {
            resources,
            inner: Arc::new(Mutex::new(Inner {
                running: None,
                generation: 0,
                pending: HashMap::new(),
            })),
        }
    }
    fn start_locked(&self, inner: &mut Inner) -> Result<(), String> {
        if let Some(running) = &mut inner.running {
            if running
                .child
                .try_wait()
                .map_err(|_| "Cannot inspect query process")?
                .is_none()
            {
                return Ok(());
            }
        }
        if let Some(prior) = inner.running.take() {
            reap(prior);
        }
        let (node, entry) = config::runtime_files(&self.resources, "stdio.mjs");
        let mut command = Command::new(node);
        command
            .arg(entry)
            .env("GIT_VIEW_DESKTOP_WRITES", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            command.env(
                "GIT_VIEW_NATIVE_HELPER",
                std::env::current_exe().map_err(|_| "Cannot locate native helper")?,
            );
            use std::os::windows::process::CommandExt;
            // The GUI host has no console; keep its piped background runtime quiet.
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "Bundled query process could not start")?;
        #[cfg(windows)]
        let job = WindowsJob::assign(&child).map_err(|message| {
            let _ = child.kill();
            let _ = child.wait();
            message
        })?;
        let stdin = child.stdin.take().ok_or("Missing query input")?;
        let stdout = child.stdout.take().ok_or("Missing query output")?;
        inner.generation += 1;
        let generation = inner.generation;
        inner.running = Some(Running {
            child,
            stdin,
            generation,
            #[cfg(windows)]
            job,
        });
        let state = self.inner.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                match reader
                    .by_ref()
                    .take(config::MAX_RESPONSE_BYTES + 1)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) | Err(_) => break,
                    Ok(_) if line.len() as u64 > config::MAX_RESPONSE_BYTES => break,
                    Ok(_) => {}
                }
                let envelope: Value = match serde_json::from_slice(&line) {
                    Ok(value) => value,
                    Err(_) => break,
                };
                let Some(id) = envelope.get("id").and_then(Value::as_str) else {
                    break;
                };
                let Some(response) = envelope.get("response") else {
                    break;
                };
                if response.get("schemaVersion").and_then(Value::as_u64)
                    != Some(config::PROTOCOL_VERSION)
                {
                    break;
                }
                let mut inner = state.lock().unwrap();
                if inner.pending.get(id).map(|pending| pending.0) == Some(generation) {
                    if let Some((_, sender)) = inner.pending.remove(id) {
                        let _ = sender.send(Ok(response.clone()));
                    }
                }
            }
            {
                let mut inner = state.lock().unwrap();
                let running = if inner.running.as_ref().map(|running| running.generation)
                    == Some(generation)
                {
                    inner.running.take()
                } else {
                    None
                };
                let ids: Vec<_> = inner
                    .pending
                    .iter()
                    .filter(|(_, pending)| pending.0 == generation)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in ids {
                    if let Some((_, sender)) = inner.pending.remove(&id) {
                        let _ = sender.send(Err(
                            "Query process exited or protocol changed; retry to restart".into(),
                        ));
                    }
                }
                // Keep the lifecycle mutex until cleanup completes. A retry must
                // not start a second Node against state still owned by the first.
                if let Some(running) = running {
                    reap(running);
                }
            }
        });
        Ok(())
    }
    pub async fn query(&self, message: Value) -> Reply {
        let id = message
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.chars().count() <= config::MAX_ENVELOPE_ID_CHARS)
            .ok_or("Invalid request identity")?
            .to_string();
        let operation = message
            .get("operation")
            .and_then(Value::as_str)
            .ok_or("Missing operation")?;
        if !["request", "session", "cancel", "watch", "write"].contains(&operation) {
            return Err("Unknown operation".into());
        }
        let mut bytes = serde_json::to_vec(&message).map_err(|_| "Invalid JSON request")?;
        if bytes.len() > config::MAX_MESSAGE_BYTES {
            return Err("Request exceeds size limit".into());
        }
        bytes.push(b'\n');
        let (sender, receiver) = oneshot::channel();
        {
            let mut inner = self.inner.lock().unwrap();
            self.start_locked(&mut inner)?;
            if inner.pending.contains_key(&id) {
                return Err("Duplicate pending request identity".into());
            }
            let generation = inner.generation;
            inner.pending.insert(id.clone(), (generation, sender));
            if inner
                .running
                .as_mut()
                .unwrap()
                .stdin
                .write_all(&bytes)
                .is_err()
            {
                inner.pending.remove(&id);
                return Err("Query process input closed".into());
            }
        }
        match tokio::time::timeout(
            std::time::Duration::from_secs(config::QUERY_TIMEOUT_SECS),
            receiver,
        )
        .await
        {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => Err("Query process unavailable".into()),
            Err(_) => {
                let mut inner = self.inner.lock().unwrap();
                inner.pending.remove(&id);
                let cancel = serde_json::json!({"id": uuid::Uuid::new_v4().to_string(), "operation": "cancel", "targetId": id});
                if let Some(running) = &mut inner.running {
                    let _ = writeln!(running.stdin, "{}", cancel);
                }
                Err("Query timed out; retry after checking repository".into())
            }
        }
    }
    pub fn stop(&self) {
        {
            let mut inner = self.inner.lock().unwrap();
            let running = inner.running.take();
            for (_, (_, sender)) in inner.pending.drain() {
                let _ = sender.send(Err("Desktop host closed".into()));
            }
            if let Some(running) = running {
                reap(running);
            }
        }
    }
}

fn reap(running: Running) {
    let Running {
        mut child,
        stdin,
        #[cfg(windows)]
        job,
        ..
    } = running;
    let pid = child.id();
    // EOF first: Node aborts every query and kills active Git children itself.
    drop(stdin);
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(config::SHUTDOWN_GRACE_MILLIS);
    while std::time::Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(
            config::SHUTDOWN_POLL_MILLIS,
        ));
    }
    // A crashed/unresponsive Node cannot run its EOF handler. Its independent
    // Unix process group also contains the Git descendants, so reap the group.
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    drop(job); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE includes all descendants.
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
pub(crate) struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
impl WindowsJob {
    pub(crate) fn assign(child: &Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err("Cannot create query process job".into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0
            {
                CloseHandle(job);
                return Err("Cannot isolate query process job".into());
            }
            Ok(Self(job))
        }
    }
}
#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    struct Fixture {
        sidecar: Sidecar,
        directory: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("git-view-host-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(directory.join("runtime")).unwrap();
            std::fs::create_dir_all(directory.join("app")).unwrap();
            let prepared = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
            let (node, _) = config::runtime_files(&prepared, "stdio.mjs");
            let (target, entry) = config::runtime_files(&directory, "stdio.mjs");
            std::fs::copy(node, target).expect("Prepare desktop resources before cargo test");
            std::fs::write(entry, r#"
                import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
                const children=[]; let stubborn=false;
                process.stdin.setEncoding('utf8'); let buffer='';
                process.stdin.on('data',chunk=>{buffer+=chunk;let index;
                  while((index=buffer.indexOf('\n'))>=0){const m=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);
                    if(m.mode==='exit'){process.exit(9)}
                    if(m.mode==='bad'){process.stdout.write('invalid json\n');continue}
                    if(m.mode==='old'){process.stdout.write(JSON.stringify({id:m.id,response:{schemaVersion:0,ok:true}})+'\n');continue}
                    if(m.mode==='hold')continue;
                    if(m.mode==='git' || m.mode==='git-stubborn'){
                      stubborn=m.mode==='git-stubborn';
                      const child=spawn('git',['hash-object','--stdin'],{cwd:process.cwd(),stdio:['pipe','ignore','ignore']});
                      children.push(child);writeFileSync(m.pidFile,String(child.pid));continue;
                    }
                    setTimeout(()=>process.stdout.write(JSON.stringify({id:m.id,response:{schemaVersion:1,ok:true,data:{alive:true},identity:m.id}})+'\n'),m.delay||0);
                  }});
                process.stdin.on('end',()=>{if(stubborn)return;for(const child of children)child.kill('SIGKILL');process.exit(0)});
            "#).unwrap();
            Self {
                sidecar: Sidecar::new(directory.clone()),
                directory,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.sidecar.stop();
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn concurrent_out_of_order_responses_keep_their_identity() {
        let fixture = Fixture::new();
        tauri::async_runtime::block_on(async {
            let first_sidecar = fixture.sidecar.clone();
            let first = tauri::async_runtime::spawn(async move {
                first_sidecar
                    .query(json!({"id":"first","operation":"request","delay":70}))
                    .await
            });
            let second = fixture
                .sidecar
                .query(json!({"id":"second","operation":"request"}))
                .await
                .unwrap();
            assert_eq!(second["identity"], "second");
            assert_eq!(first.await.unwrap().unwrap()["identity"], "first");
        });
    }

    #[test]
    fn crash_rejects_pending_and_next_query_restarts() {
        let fixture = Fixture::new();
        tauri::async_runtime::block_on(async {
            let waiting_sidecar = fixture.sidecar.clone();
            let waiting = tauri::async_runtime::spawn(async move {
                waiting_sidecar
                    .query(json!({"id":"waiting","operation":"request","mode":"hold"}))
                    .await
            });
            for _ in 0..100 {
                if fixture
                    .sidecar
                    .inner
                    .lock()
                    .unwrap()
                    .pending
                    .contains_key("waiting")
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            assert!(fixture
                .sidecar
                .query(json!({"id":"crash","operation":"request","mode":"exit"}))
                .await
                .is_err());
            assert!(waiting.await.unwrap().is_err());
            assert!(fixture
                .sidecar
                .query(json!({"id":"restarted","operation":"request"}))
                .await
                .unwrap()["ok"]
                .as_bool()
                .unwrap());
        });
    }

    #[test]
    fn malformed_or_old_protocol_does_not_become_success_and_stop_reaps_child() {
        let fixture = Fixture::new();
        tauri::async_runtime::block_on(async {
            for mode in ["bad", "old"] {
                assert!(fixture
                    .sidecar
                    .query(json!({"id":mode,"operation":"request","mode":mode}))
                    .await
                    .is_err());
                assert!(fixture
                    .sidecar
                    .query(json!({"id":"recovered","operation":"request"}))
                    .await
                    .is_ok());
            }
            fixture.sidecar.stop();
            let state = fixture.sidecar.inner.lock().unwrap();
            assert!(state.running.is_none());
            assert!(state.pending.is_empty());
        });
    }

    #[cfg(unix)]
    #[test]
    fn closing_host_reaps_real_running_git_even_when_node_ignores_eof() {
        for mode in ["git", "git-stubborn"] {
            let fixture = Fixture::new();
            let pid_file = fixture.directory.join("git.pid");
            tauri::async_runtime::block_on(async {
                let waiting_sidecar = fixture.sidecar.clone();
                let marker = pid_file.clone();
                let waiting = tauri::async_runtime::spawn(async move {
                    waiting_sidecar.query(json!({"id":"running-git","operation":"request","mode":mode,"pidFile":marker})).await
                });
                for _ in 0..200 {
                    if pid_file.exists() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                let pid: i32 = std::fs::read_to_string(&pid_file).unwrap().parse().unwrap();
                assert_eq!(
                    unsafe { libc::kill(pid, 0) },
                    0,
                    "Git must be running before shutdown"
                );
                fixture.sidecar.stop();
                assert!(waiting.await.unwrap().is_err());
                for _ in 0..200 {
                    if unsafe { libc::kill(pid, 0) } != 0 {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                assert_ne!(
                    unsafe { libc::kill(pid, 0) },
                    0,
                    "Git descendant remained after shutdown"
                );
            });
        }
    }
}
