// Bridge between the React app and the Rust window-management commands.
// We listen for the global hotkey via Tauri events and expose helpers to
// resize the window when the result panel mounts/unmounts.

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useState } from 'react';

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

  const setExpanded = useCallback(async (expanded: boolean) => {
    await invoke('set_hud_expanded', { expanded }).catch(() => {});
  }, []);

  return { visible, hide, setExpanded };
}
