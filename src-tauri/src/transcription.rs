// Streaming transcription bridge.
//
// The HUD captures audio in the WebView via `MediaRecorder` (webm/opus), which
// yields chunks every ~250ms. Those chunks are pushed across the JS↔Rust
// boundary into a streaming session owned by this module. Each session opens
// a single multipart POST to `${ERGORA_API_URL}/api/transcribe/stream` with a
// streaming request body, and concurrently parses the server-sent-events
// response. Interim and final hypotheses are emitted to the front-end as
// `transcribe-partial` and `transcribe-final` events on the HUD window —
// the React layer overlays interim text greyed-out and resolves it to confirmed
// text on `final`.
//
// This is the cross-platform path. macOS could in principle drive
// `SFSpeechRecognizer` directly for a zero-network alternative; we ship the
// cloud path here because (a) the server endpoint is already deployed and (b)
// Whisper-on-cloud beats on-device tiny models for accuracy. The same
// front-end events drive the UI either way, so a future native-STT module can
// slot in behind the same `start_transcription_stream` command without any
// React changes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{mpsc, oneshot};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

const HUD_LABEL: &str = "hud";
const STREAM_ENDPOINT: &str = "/api/transcribe/stream";
/// Channel buffer for pushed audio chunks. 64 frames @ 250ms ≈ 16s of slack
/// — more than enough headroom for slow network spikes.
const CHUNK_CHANNEL_CAPACITY: usize = 64;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TranscribeEvent<'a> {
    session_id: &'a str,
    text: &'a str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TranscribeErrorEvent<'a> {
    session_id: &'a str,
    error: &'a str,
}

struct Session {
    chunk_tx: mpsc::Sender<bytes::Bytes>,
    /// Sent when the front-end calls `stop_transcription_stream` so the
    /// background task knows to flush and close the upload.
    stop_tx: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct StreamingState {
    sessions: Mutex<HashMap<String, Session>>,
}

pub type StreamingStateRef = Arc<StreamingState>;

pub fn new_state() -> StreamingStateRef {
    Arc::new(StreamingState::default())
}

/// Open a streaming transcription session. Returns the session id; subsequent
/// `push_audio_chunk` and `stop_transcription_stream` calls reference it.
#[tauri::command]
pub async fn start_transcription_stream<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, StreamingStateRef>,
    api_url: String,
    auth_token: String,
    mime_type: String,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    let (chunk_tx, chunk_rx) = mpsc::channel::<bytes::Bytes>(CHUNK_CHANNEL_CAPACITY);
    let (stop_tx, stop_rx) = oneshot::channel::<()>();

    {
        let mut map = state.sessions.lock().map_err(poisoned)?;
        map.insert(
            session_id.clone(),
            Session {
                chunk_tx,
                stop_tx: Some(stop_tx),
            },
        );
    }

    // Background task — owns the duplex HTTP connection.
    let app_handle = app.clone();
    let state_inner: StreamingStateRef = Arc::clone(&*state);
    let session_for_task = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_stream(
            &app_handle,
            &session_for_task,
            api_url,
            auth_token,
            mime_type,
            chunk_rx,
            stop_rx,
        )
        .await;

        if let Err(err) = result {
            log::warn!("transcription stream {} failed: {}", session_for_task, err);
            let _ = app_handle.emit_to(
                HUD_LABEL,
                "transcribe-error",
                TranscribeErrorEvent {
                    session_id: &session_for_task,
                    error: &err,
                },
            );
        }

        // Always tear the session down on exit so a client that forgets to
        // call `stop_transcription_stream` doesn't leak entries.
        if let Ok(mut map) = state_inner.sessions.lock() {
            map.remove(&session_for_task);
        }
    });

    Ok(session_id)
}

/// Push a single audio chunk into the active streaming session. The bytes
/// must be a slice of the same container/codec the session was opened with
/// (e.g. webm/opus produced by MediaRecorder).
#[tauri::command]
pub async fn push_audio_chunk(
    state: tauri::State<'_, StreamingStateRef>,
    session_id: String,
    chunk: Vec<u8>,
) -> Result<(), String> {
    let tx = {
        let map = state.sessions.lock().map_err(poisoned)?;
        let Some(session) = map.get(&session_id) else {
            return Err(format!("unknown session {}", session_id));
        };
        session.chunk_tx.clone()
    };
    tx.send(bytes::Bytes::from(chunk))
        .await
        .map_err(|e| format!("audio channel closed: {}", e))?;
    Ok(())
}

/// Mark the session as complete. The background task flushes the upload, the
/// server emits the final result, and the session is dropped.
#[tauri::command]
pub async fn stop_transcription_stream(
    state: tauri::State<'_, StreamingStateRef>,
    session_id: String,
) -> Result<(), String> {
    let stop_tx = {
        let mut map = state.sessions.lock().map_err(poisoned)?;
        let Some(session) = map.get_mut(&session_id) else {
            // Already torn down — treat as success (idempotent stop).
            return Ok(());
        };
        session.stop_tx.take()
    };
    if let Some(tx) = stop_tx {
        let _ = tx.send(());
    }
    Ok(())
}

// ── Internals ──────────────────────────────────────────────────────────────

fn poisoned<E: std::fmt::Display>(e: E) -> String {
    format!("session map poisoned: {}", e)
}

async fn run_stream<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    api_url: String,
    auth_token: String,
    mime_type: String,
    mut chunk_rx: mpsc::Receiver<bytes::Bytes>,
    mut stop_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("http client init failed: {}", e))?;

    // Build a chunked-body stream. The body keeps yielding until either the
    // chunk channel closes (stop_transcription_stream → drop sender) or the
    // explicit stop signal arrives. We bridge a tokio mpsc into reqwest's
    // expected `impl Stream<Item = Result<Bytes, _>>` shape via a small
    // adapter task feeding a duplex pipe — simpler than wrapping the receiver
    // in a custom `Stream` impl.
    let (mut writer, reader) = tokio::io::duplex(64 * 1024);
    let body_stream = ReaderStream::new(reader);

    let pump = tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncWriteExt;
        loop {
            tokio::select! {
                biased;
                _ = &mut stop_rx => {
                    break;
                }
                maybe = chunk_rx.recv() => {
                    match maybe {
                        Some(chunk) => {
                            if writer.write_all(&chunk).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
        }
        // Drain anything queued behind the stop signal so the final partial
        // chunk reaches the server.
        while let Ok(chunk) = chunk_rx.try_recv() {
            let _ = writer.write_all(&chunk).await;
        }
        let _ = writer.shutdown().await;
    });

    let url = format!("{}{}", api_url.trim_end_matches('/'), STREAM_ENDPOINT);
    let response = client
        .post(&url)
        .bearer_auth(&auth_token)
        .header("Content-Type", &mime_type)
        .header("Accept", "text/event-stream")
        .header("X-Session-Id", session_id)
        .body(reqwest::Body::wrap_stream(body_stream))
        .send()
        .await
        .map_err(|e| format!("transcribe stream request failed: {}", e))?;

    if !response.status().is_success() {
        let code = response.status();
        let body = response.text().await.unwrap_or_default();
        let _ = pump.await;
        return Err(format!("server rejected stream ({}): {}", code, body));
    }

    let mut byte_stream = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();

    while let Some(item) = byte_stream.next().await {
        let bytes = item.map_err(|e| format!("stream chunk error: {}", e))?;
        buf.extend_from_slice(&bytes);

        // SSE frames are terminated by a blank line.
        while let Some(idx) = find_double_newline(&buf) {
            let raw = buf.drain(..idx + 2).collect::<Vec<u8>>();
            // Trim the trailing CRLFCRLF from the frame slice we keep.
            let frame_end = raw.len().saturating_sub(2);
            let frame = std::str::from_utf8(&raw[..frame_end]).unwrap_or("");
            handle_sse_frame(app, session_id, frame);
        }
    }

    // Drain any remaining buffered frame without trailing blank line.
    if !buf.is_empty() {
        if let Ok(frame) = std::str::from_utf8(&buf) {
            handle_sse_frame(app, session_id, frame);
        }
    }

    let _ = pump.await;
    Ok(())
}

/// Locates the first `\n\n` or `\r\n\r\n` separator (SSE frame end).
fn find_double_newline(buf: &[u8]) -> Option<usize> {
    // Returns the index of the first byte of the separator.
    // We support both LF-only and CRLF SSE servers.
    for i in 0..buf.len().saturating_sub(1) {
        if buf[i] == b'\n' && buf[i + 1] == b'\n' {
            return Some(i);
        }
        if i + 3 < buf.len()
            && buf[i] == b'\r'
            && buf[i + 1] == b'\n'
            && buf[i + 2] == b'\r'
            && buf[i + 3] == b'\n'
        {
            return Some(i + 2);
        }
    }
    None
}

/// Parse a single SSE frame and forward to the front-end. We expect frames of
/// the form:
///
/// ```
/// event: interim
/// data: {"text":"hello wor"}
/// ```
fn handle_sse_frame<R: Runtime>(app: &AppHandle<R>, session_id: &str, frame: &str) {
    let mut event_type = "message";
    let mut data_lines: Vec<&str> = Vec::new();
    for line in frame.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("event:") {
            event_type = rest.trim();
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim_start());
        }
    }
    let data_joined = data_lines.join("\n");
    let text = extract_text(&data_joined).unwrap_or_default();

    let event_name = match event_type {
        "interim" | "partial" => "transcribe-partial",
        "final" => "transcribe-final",
        "error" => "transcribe-error",
        _ => "transcribe-partial",
    };

    let payload = TranscribeEvent {
        session_id,
        text: &text,
    };
    if let Err(err) = app.emit_to(HUD_LABEL, event_name, payload) {
        log::warn!("failed to emit {}: {}", event_name, err);
    }
}

/// Pull a `text` field out of either `{"text":"..."}` or a plain-string body.
fn extract_text(data: &str) -> Option<String> {
    let trimmed = data.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(s) = json.get("text").and_then(|v| v.as_str()) {
            return Some(s.to_string());
        }
        if let Some(s) = json.as_str() {
            return Some(s.to_string());
        }
    }
    Some(trimmed.to_string())
}

/// Helper used by the frontend to know which platform we're on without going
/// through the OS plugin. Lets the React layer pick the right MIME type for
/// MediaRecorder when needed.
#[tauri::command]
pub fn transcription_capabilities() -> serde_json::Value {
    serde_json::json!({
        "streamingSupported": true,
        "preferredMimeType": "audio/webm;codecs=opus",
        "platform": std::env::consts::OS,
    })
}

/// Force-cancel and drop a session. Used on window-hide and unmount paths so
/// network sockets don't outlive the UI. Currently called only via the
/// `stop_transcription_stream` command but kept on the public surface so
/// shell-side cleanup hooks (e.g. window close) can wire in directly.
#[allow(dead_code)]
pub fn drop_session(state: &StreamingStateRef, session_id: &str) {
    if let Ok(mut map) = state.sessions.lock() {
        if let Some(mut session) = map.remove(session_id) {
            if let Some(tx) = session.stop_tx.take() {
                let _ = tx.send(());
            }
        }
    }
}
