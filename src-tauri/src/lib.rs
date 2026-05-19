// Ergora HUD — Tauri shell
//
// Responsibilities:
//   • Own the borderless / transparent / always-on-top top-bar window.
//   • Register the global hotkey (Cmd/Ctrl+Shift+Space) and toggle the HUD.
//   • Position the HUD on the monitor where the cursor currently is, snapped
//     to the top edge.
//   • Expose a small command surface (toggle, hide, position) to the JS side.
//   • On macOS, raise the window's level so it floats over fullscreen apps.
//
// The window is created hidden in tauri.conf.json. We only show it when the
// user actually triggers the HUD (hotkey, tray, JS command). This keeps it
// out of the user's face on launch and avoids a flash on startup.

use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewWindow,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

mod transcription;
use transcription::{
    new_state as new_transcription_state, push_audio_chunk, start_transcription_stream,
    stop_transcription_stream, transcription_capabilities,
};

const HUD_LABEL: &str = "hud";
// Three window states. The HUD is a small pill at idle and only grows when
// recording (to show the live transcript) or when the scratch pad is open.
const PILL_HEIGHT: f64 = 56.0;
const PANEL_HEIGHT: f64 = 360.0;
const HUD_WIDTH_PILL: f64 = 220.0;
const HUD_WIDTH_RECORDING: f64 = 420.0;
const HUD_WIDTH_PANEL: f64 = 340.0;
const TOP_OFFSET: f64 = 12.0;

/// The three HUD window sizes, keyed by the string the JS side passes.
fn hud_dimensions(state: &str) -> (f64, f64) {
    match state {
        "recording" => (HUD_WIDTH_RECORDING, PILL_HEIGHT),
        "panel" => (HUD_WIDTH_PANEL, PANEL_HEIGHT),
        // "pill" and any unknown value fall back to the compact idle pill.
        _ => (HUD_WIDTH_PILL, PILL_HEIGHT),
    }
}

fn get_hud_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(HUD_LABEL)
}

/// Position the HUD window centered on the top edge of whichever monitor
/// the cursor is currently on. Falls back to the primary monitor.
///
/// Centring uses the window's *current* outer width rather than a fixed
/// const, so it stays centred across pill/recording/panel resizes.
fn position_on_active_monitor<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    let cursor_pos = window.cursor_position().ok();
    let monitors = window.available_monitors()?;
    let monitor = if let Some(pos) = cursor_pos {
        monitors
            .iter()
            .find(|m| {
                let mp = m.position();
                let ms = m.size();
                let x = pos.x as i32;
                let y = pos.y as i32;
                x >= mp.x
                    && x <= mp.x + ms.width as i32
                    && y >= mp.y
                    && y <= mp.y + ms.height as i32
            })
            .cloned()
            .or_else(|| monitors.first().cloned())
    } else {
        monitors.first().cloned()
    };

    let Some(monitor) = monitor else { return Ok(()) };
    let scale = monitor.scale_factor();
    let mp = monitor.position();
    let ms = monitor.size();

    // Compute logical layout — Tauri's set_position takes physical coords.
    // Use the window's actual current width so centring tracks resizes.
    let hud_width = window
        .outer_size()
        .map(|s| s.width as f64 / scale)
        .unwrap_or(HUD_WIDTH_PILL);
    let logical_width = ms.width as f64 / scale;
    let x_logical = (logical_width - hud_width) / 2.0;
    let x_physical = mp.x + (x_logical * scale).round() as i32;
    let y_physical = mp.y + (TOP_OFFSET * scale).round() as i32;

    window.set_position(PhysicalPosition::new(x_physical, y_physical))?;
    Ok(())
}

#[tauri::command]
async fn toggle_hud<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    let Some(window) = get_hud_window(&app) else {
        return Err("HUD window not found".into());
    };
    let visible = window.is_visible().unwrap_or(false);
    if visible {
        window.hide().map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        position_on_active_monitor(&window).map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
async fn show_hud<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let Some(window) = get_hud_window(&app) else {
        return Err("HUD window not found".into());
    };
    position_on_active_monitor(&window).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn hide_hud<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = get_hud_window(&app) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Resize the HUD between its three states: "pill" (idle), "recording"
/// (live transcript + cancel/finish) and "panel" (scratch pad / results).
/// Sets both width and height, then re-centres on the active monitor.
#[tauri::command]
async fn set_hud_size<R: Runtime>(app: AppHandle<R>, state: String) -> Result<(), String> {
    let Some(window) = get_hud_window(&app) else {
        return Err("HUD window not found".into());
    };
    let (width, height) = hud_dimensions(&state);
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    // After a resize the window may shift; re-center on the active monitor.
    position_on_active_monitor(&window).map_err(|e| e.to_string())?;
    Ok(())
}

/// Backwards-compatible shim — older JS may still call `set_hud_expanded`.
/// Maps the boolean onto the new three-state command.
#[tauri::command]
async fn set_hud_expanded<R: Runtime>(app: AppHandle<R>, expanded: bool) -> Result<(), String> {
    let state = if expanded { "panel" } else { "pill" };
    set_hud_size(app, state.to_string()).await
}

/// Re-center the HUD without changing visibility — used when the user moves
/// between displays before the next show.
#[tauri::command]
async fn recenter_hud<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = get_hud_window(&app) {
        position_on_active_monitor(&window).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Update the global hotkey at runtime. Called from the settings panel.
/// Re-parses the accelerator string into a `Shortcut` and re-registers it.
#[tauri::command]
async fn set_global_hotkey<R: Runtime>(
    app: AppHandle<R>,
    accelerator: String,
) -> Result<(), String> {
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|e| format!("invalid accelerator '{}': {}", accelerator, e))?;
    gs.register(shortcut).map_err(|e| e.to_string())?;
    Ok(())
}

/// macOS only — promote the HUD to the floating panel level so it sits above
/// fullscreen / Mission Control. Tauri 2.x doesn't expose this directly.
///
/// We use the legacy `cocoa` crate rather than `objc2-app-kit` because it
/// matches what Tauri itself depends on transitively. TODO: migrate to
/// `objc2-app-kit` when Tauri does.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn raise_to_floating_level<R: Runtime>(window: &WebviewWindow<R>) {
    use cocoa::appkit::{NSMainMenuWindowLevel, NSWindow, NSWindowCollectionBehavior};
    use cocoa::base::id;

    let Ok(ns_window_ptr) = window.ns_window() else { return };
    let ns_window: id = ns_window_ptr as id;
    unsafe {
        // Above-status-bar tier — high enough to clear fullscreen spaces.
        ns_window.setLevel_((NSMainMenuWindowLevel + 2) as i64);
        // Show on every space, including fullscreen apps.
        let behavior = NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary;
        ns_window.setCollectionBehavior_(behavior);
    }
}

/// Windows — keep the overlay topmost, hide it from Alt+Tab, and avoid the
/// taskbar. `WS_EX_TOOLWINDOW` strips the window from the taskbar / Alt+Tab
/// chain, `WS_EX_TOPMOST` raises it above ordinary windows, and a
/// `HWND_TOPMOST` SetWindowPos call enforces the z-order.
#[cfg(target_os = "windows")]
fn raise_to_floating_level<R: Runtime>(window: &WebviewWindow<R>) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    };

    let Ok(hwnd_raw) = window.hwnd() else {
        log::warn!("raise_to_floating_level: hwnd() unavailable on Windows");
        return;
    };
    let hwnd = HWND(hwnd_raw.0 as *mut _);
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let new_style =
            current | (WS_EX_TOOLWINDOW.0 as isize) | (WS_EX_TOPMOST.0 as isize);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// Linux — request that the WM treat the window as a `_NET_WM_WINDOW_TYPE_DOCK`
/// surface. On X11 (Mutter/KWin/i3/...) this typically keeps the overlay above
/// fullscreen apps; on Wayland behaviour is compositor-dependent and a
/// proper layer-shell integration would be the next step. We also pin
/// `set_keep_above` and `stick` so the overlay is visible on every workspace.
#[cfg(target_os = "linux")]
fn raise_to_floating_level<R: Runtime>(window: &WebviewWindow<R>) {
    use gdk::WindowTypeHint;
    use gtk::prelude::*;

    let Ok(gtk_window) = window.gtk_window() else {
        log::warn!("raise_to_floating_level: gtk_window() unavailable on Linux");
        return;
    };
    gtk_window.set_type_hint(WindowTypeHint::Dock);
    gtk_window.set_keep_above(true);
    gtk_window.set_skip_taskbar_hint(true);
    gtk_window.set_skip_pager_hint(true);
    gtk_window.stick();
}

fn default_accelerator() -> &'static str {
    if cfg!(target_os = "macos") {
        "CmdOrCtrl+Shift+Space"
    } else {
        "Ctrl+Shift+Space"
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // tauri-plugin-global-shortcut 2.x exposes `state` as a
                    // field on `ShortcutEvent`. Pressed-only — release fires
                    // once on key-up which we ignore.
                    if event.state == ShortcutState::Pressed {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = toggle_hud(app).await;
                        });
                    }
                })
                .build(),
        )
        .manage(new_transcription_state())
        .invoke_handler(tauri::generate_handler![
            toggle_hud,
            show_hud,
            hide_hud,
            set_hud_size,
            set_hud_expanded,
            recenter_hud,
            set_global_hotkey,
            start_transcription_stream,
            push_audio_chunk,
            stop_transcription_stream,
            transcription_capabilities,
        ])
        .setup(|app| {
            // Register the default global hotkey once the app is ready.
            // The user can override it from the settings panel via
            // `set_global_hotkey`.
            let accel = Shortcut::new(
                Some(if cfg!(target_os = "macos") {
                    Modifiers::SUPER | Modifiers::SHIFT
                } else {
                    Modifiers::CONTROL | Modifiers::SHIFT
                }),
                Code::Space,
            );
            if let Err(err) = app.global_shortcut().register(accel) {
                log::error!(
                    "failed to register global hotkey {}: {}",
                    default_accelerator(),
                    err
                );
            }

            if let Some(window) = app.get_webview_window(HUD_LABEL) {
                raise_to_floating_level(&window);
                // Pre-position so the first show lands cleanly.
                let _ = position_on_active_monitor(&window);

                // Auto-hide when focus is lost — implements click-outside-dismiss.
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        if let Some(w) = app_handle.get_webview_window(HUD_LABEL) {
                            // Only hide when actually visible — avoids the
                            // initial-load focus dance hiding us.
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != HUD_LABEL {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Esc / red-button close just hides — quitting goes through the tray.
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running ergora hud");
}
