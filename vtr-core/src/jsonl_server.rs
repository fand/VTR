//! Unix-socket JSON Lines control server, shared by vtr-tap and vtr-player.
//!
//! One line in, one line out. Requests are `{"id"?:N,"cmd":"…",…}`; the
//! server echoes `id` so a client can match replies to requests, which is
//! what lets a slow handler answer out of order. Responses are
//! `{"ok":true,…}` or `{"ok":false,"error":"…"}`. Unparseable lines get an
//! error reply (no id to echo); blank lines are skipped.
//!
//! Each connection gets its own thread and its own state `C` (`()` when the
//! server is stateless). The command set and the state live in the caller;
//! this module owns only the framing.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{Context, Result};
use serde_json::{Value, json};

/// How a handler answers one request.
pub enum Reply {
    /// Answer inline, in request order.
    Now(Value),
    /// Answer from its own thread, with the request handed back to it.
    /// Long polls must use this: a handler that blocks inline
    /// head-of-line-delays every later request on the same connection.
    Defer(Box<dyn FnOnce(&Value) -> Value + Send + 'static>),
}

impl Reply {
    pub fn defer(f: impl FnOnce(&Value) -> Value + Send + 'static) -> Self {
        Reply::Defer(Box::new(f))
    }
}

/// Serve the control API on a unix domain socket. Blocks forever.
///
/// `name` prefixes connection-error logs, e.g. `"vtr-tap"`. A stale socket
/// from a previous run is removed first.
pub fn serve<C, N, H>(path: &Path, name: &'static str, new_conn: N, handle: H) -> Result<()>
where
    C: Send + 'static,
    N: Fn() -> C + Send + Sync + 'static,
    H: Fn(&Value, &mut C) -> Reply + Send + Sync + 'static,
{
    if path.exists() {
        std::fs::remove_file(path).with_context(|| format!("remove stale socket {path:?}"))?;
    }
    let listener = UnixListener::bind(path).with_context(|| format!("bind {path:?}"))?;
    let new_conn = Arc::new(new_conn);
    let handle = Arc::new(handle);
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let new_conn = new_conn.clone();
        let handle = handle.clone();
        thread::spawn(move || {
            let result = (|| -> std::io::Result<()> {
                let writer = stream.try_clone()?;
                let reader = BufReader::new(stream);
                serve_conn(reader, writer, &mut new_conn(), &*handle)
            })();
            if let Err(e) = result {
                eprintln!("{name}: control conn error: {e}");
            }
        });
    }
    Ok(())
}

/// Run one connection's request loop until the reader hits EOF.
///
/// Generic over the stream halves so a future Windows transport (TCP or
/// named pipe) only swaps the listener loop in `serve`, and so tests can
/// drive it without a socket.
pub fn serve_conn<R, W, C, H>(reader: R, writer: W, conn: &mut C, handle: &H) -> std::io::Result<()>
where
    R: BufRead,
    W: Write + Send + 'static,
    H: Fn(&Value, &mut C) -> Reply,
{
    // Shared writer: deferred replies land from other threads, and must not
    // interleave with each other or with the inline ones.
    let writer = Arc::new(Mutex::new(writer));
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let resp = json!({"ok": false, "error": format!("bad json: {e}")});
                write_response(&writer, &resp)?;
                continue;
            }
        };
        match handle(&request, conn) {
            Reply::Now(resp) => write_response(&writer, &with_id(&request, resp))?,
            Reply::Defer(f) => {
                let writer = writer.clone();
                thread::spawn(move || {
                    let resp = with_id(&request, f(&request));
                    // Connection may be gone by the time the reply is ready.
                    let _ = write_response(&writer, &resp);
                });
            }
        }
    }
    Ok(())
}

fn write_response<W: Write>(writer: &Arc<Mutex<W>>, resp: &Value) -> std::io::Result<()> {
    let mut w = writer.lock().unwrap();
    w.write_all(resp.to_string().as_bytes())?;
    w.write_all(b"\n")
}

/// Echo the request id so the client can match replies to requests.
pub fn with_id(request: &Value, mut response: Value) -> Value {
    if let Some(id) = request.get("id") {
        response["id"] = id.clone();
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[derive(Clone)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Sink {
        fn new() -> Self {
            Sink(Arc::new(Mutex::new(Vec::new())))
        }

        fn lines(&self) -> Vec<Value> {
            let buf = self.0.lock().unwrap();
            String::from_utf8_lossy(&buf)
                .lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect()
        }

        /// Deferred replies arrive on another thread; wait for them.
        fn wait_lines(&self, n: usize) -> Vec<Value> {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let lines = self.lines();
                if lines.len() >= n || Instant::now() > deadline {
                    return lines;
                }
                thread::sleep(Duration::from_millis(5));
            }
        }
    }

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn run(input: &str, handle: impl Fn(&Value, &mut ()) -> Reply) -> Sink {
        let sink = Sink::new();
        serve_conn(input.as_bytes(), sink.clone(), &mut (), &handle).unwrap();
        sink
    }

    #[test]
    fn echoes_id_and_skips_blank_lines() {
        let sink = run(
            "{\"id\":7,\"cmd\":\"ping\"}\n\n   \n{\"cmd\":\"ping\"}\n",
            |_, _| Reply::Now(json!({"ok": true})),
        );
        assert_eq!(
            sink.lines(),
            vec![json!({"ok": true, "id": 7}), json!({"ok": true})]
        );
    }

    #[test]
    fn answers_bad_json_without_dropping_the_connection() {
        let sink = run("not json\n{\"id\":2,\"cmd\":\"ping\"}\n", |_, _| {
            Reply::Now(json!({"ok": true}))
        });
        let lines = sink.lines();
        assert_eq!(lines[0]["ok"], json!(false));
        assert!(
            lines[0]["error"]
                .as_str()
                .unwrap()
                .starts_with("bad json: "),
            "{lines:?}"
        );
        assert_eq!(lines[1], json!({"ok": true, "id": 2}));
    }

    #[test]
    fn deferred_reply_does_not_block_later_requests() {
        let (tx, rx) = mpsc::channel::<()>();
        let rx = Arc::new(Mutex::new(rx));
        let sink = run(
            "{\"id\":1,\"cmd\":\"slow\"}\n{\"id\":2,\"cmd\":\"fast\"}\n",
            move |request, _| {
                if request["cmd"] == json!("slow") {
                    let rx = rx.clone();
                    return Reply::defer(move |req| {
                        rx.lock().unwrap().recv().unwrap();
                        json!({"ok": true, "cmd": req["cmd"].clone()})
                    });
                }
                Reply::Now(json!({"ok": true}))
            },
        );
        // The slow request is still parked, so only the later one answered.
        assert_eq!(sink.lines(), vec![json!({"ok": true, "id": 2})]);
        tx.send(()).unwrap();
        assert_eq!(
            sink.wait_lines(2),
            vec![
                json!({"ok": true, "id": 2}),
                json!({"ok": true, "cmd": "slow", "id": 1}),
            ]
        );
    }

    #[test]
    fn state_is_per_connection() {
        let handle = |_: &Value, n: &mut u32| {
            *n += 1;
            Reply::Now(json!({ "ok": true, "n": *n }))
        };
        let input = "{\"cmd\":\"bump\"}\n{\"cmd\":\"bump\"}\n";

        let first = Sink::new();
        serve_conn(input.as_bytes(), first.clone(), &mut 0, &handle).unwrap();
        let second = Sink::new();
        serve_conn(input.as_bytes(), second.clone(), &mut 0, &handle).unwrap();

        let want = vec![json!({"ok": true, "n": 1}), json!({"ok": true, "n": 2})];
        assert_eq!(first.lines(), want);
        assert_eq!(second.lines(), want);
    }
}
