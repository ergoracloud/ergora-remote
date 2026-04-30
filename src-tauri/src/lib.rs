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

const HUD_LABEL: &str = "hud";
const COLLAPSED_HEIGHT: f64 = 56.0;
const EXPANDED_HEIGHT: f64 = 360.0;
const HUD_WIDTH: f64 = 640.0;
const TOP_OFFSET: f64 = 12.0;

fn get_hud_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(HUD_LABEL)
}

/// Position the HUD window centered on the top edge of whichever monitor
/// the cursor is currently on. Falls back to the primary monitor.
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
    let logical_width = ms.width as f64 / scale;
    let x_logical = (logical_width - HUD_WIDTH) / 2.0;
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

/// Resize the HUD between collapsed (mic only) and expanded (results visible).
/// Called from JS when the result panel mounts/unmounts.
#[tauri::command]
async fn set_hud_expanded<R: Runtime>(app: AppHandle<R>, expanded: bool) -> Result<(), String> {
    let Some(window) = get_hud_window(&app) else {
        return Err("HUD window not found".into());
    };
    let height = if expanded { EXPANDED_HEIGHT } else { COLLAPSED_HEIGHT };
    window
        .set_size(LogicalSize::new(HUD_WIDTH, height))
        .map_err(|e| e.to_string())?;
    // After a resize the window may shift; re-center on the active monitor.
    position_on_active_monitor(&window).map_err(|e| e.to_string())?;
    Ok(())
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

#[cfg(not(target_os = "macos"))]
fn raise_to_floating_level<R: Runtime>(_window: &WebviewWindow<R>) {
    // TODO(windows): Use SetWindowPos with HWND_TOPMOST + WS_EX_TOOLWINDOW
    // to keep the overlay out of Alt+Tab and above other windows.
    // TODO(linux): Use Wayland layer-shell (Sway/Hyprland) or set
    // _NET_WM_WINDOW_TYPE_DOCK on X11 for above-fullscreen behaviour.
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
        .invoke_handler(tauri::generate_handler![
            toggle_hud,
            show_hud,
            hide_hud,
            set_hud_expanded,
            recenter_hud,
            set_global_hotkey,
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
