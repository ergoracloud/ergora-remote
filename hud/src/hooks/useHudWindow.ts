// Bridge between the React app and the Rust window-management commands.
// We listen for the global hotkey via Tauri events and expose helpers to
// resize the window between its three states (pill / recording / panel).

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useState } from 'react';

// The HUD window sizes. Four user-facing views form a small→large ladder:
//   • pill          — compact idle state, the 4-icon row.
//   • pill-wide     — pill bar + a response strip underneath.
//   • notepad       — the ~340x360 history / long-response panel.
//   • notepad-wide  — the notepad at ~2x, usable as a proper chat window.
// `bar` is a transient: the wide single-row bar shown while recording or
// typing, before any response exists.
export type HudSize =
  | 'pill'
  | 'bar'
  | 'pill-wide'
  | 'notepad'
  | 'notepad-wide'
  | 'drag';

export function useHudWindow() {
  const [visible, setVisible] = useState<boolean>(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unFocus: (() => void) | undefined;
    let unShow: (() => void) | undefined;
    let unHide: (() => void) | undefined;

    win.isVisible().then(setVisible).catch(() => {});

    win.onFocusChanged(({ payload }) => {
      // The Rust side hides on blur, but we keep React in sync for animations.
      if (!payload) setVisible(false);
    }).then((un) => { unFocus = un; });

    // Tauri emits these when the window's visibility actually changes.
    // We listen so the React tree can run enter/exit animations cleanly.
    win.listen('tauri://window-shown', () => setVisible(true)).then((un) => { unShow = un; }).catch(() => {});
    win.listen('tauri://window-hidden', () => setVisible(false)).then((un) => { unHide = un; }).catch(() => {});

    return () => {
      unFocus?.();
      unShow?.();
      unHide?.();
    };
  }, []);

  const hide = useCallback(async () => {
    await invoke('hide_hud').catch(() => {});
    setVisible(false);
  }, []);

  const setSize = useCallback(async (state: HudSize) => {
    await invoke('set_hud_size', { state }).catch(() => {});
  }, []);

  // Free-form resize, used while the user drags the corner grip. Rust clamps
  // the values to the allowed min/max envelope.
  const setCustomSize = useCallback(async (width: number, height: number) => {
    await invoke('set_hud_custom_size', { width, height }).catch(() => {});
  }, []);

  return { visible, hide, setSize, setCustomSize };
}
