# Ergora Remote HUD — Minimal Pill Redesign

Branch: `feat/hud-minimal-pill`. Worktree: `ergora-remote-hud-minimal`.

Redesigns the HUD's idle/collapsed state from a fixed 640px slab into a compact
~220px pill (Wispr Flow style), adds a recording state with cancel/finish
affordances, and adds a scratch-pad panel that surfaces local interaction
history and long agent responses.

## Files changed

| File | Change |
|---|---|
| `src-tauri/src/lib.rs` | Three named widths; new `set_hud_size` command; `set_hud_expanded` shim; centring now uses live window width |
| `src-tauri/tauri.conf.json` | Initial window 640→220 wide; `minWidth` 480→200 |
| `src-tauri/capabilities/default.json` | Added `core:window:allow-outer-size` (needed by the new centring math) |
| `hud/src/hooks/useHudWindow.ts` | `setExpanded(bool)` replaced with `setSize(HudSize)`; exports `HudSize` type |
| `hud/src/App.tsx` | Rewritten render: pill / recording / panel states; ✕ / ✓ recording controls; chevron opens scratch pad; window-sizing effect derives one state |
| `hud/src/components/ScratchPad.tsx` | **New** — ~340×360 panel: history list + fresh-response view, settings moved into its header |

Not touched (per scope): `useRecorder.ts`, `useStreamingTranscription.ts`,
`lib/api.ts`, `lib/history.ts`, headless agent `src/*.ts`, `MicButton.tsx`,
`KeyboardInput.tsx`, `ResultPanel.tsx` (reused as-is by ScratchPad).

## New Rust command

```rust
#[tauri::command]
async fn set_hud_size<R: Runtime>(app: AppHandle<R>, state: String) -> Result<(), String>
```

`state` is `"pill" | "recording" | "panel"`. Sizes:

| State | Width × Height | When |
|---|---|---|
| `pill` | 220 × 56 | idle (mic hint or keyboard field) |
| `recording` | 420 × 56 | recording — live transcript + ✕/✓ |
| `panel` | 340 × 360 | scratch pad / long response / error |

`set_hud_expanded(bool)` is kept as a thin shim (`true`→panel, `false`→pill) so
nothing breaks if older JS calls it; the JS side now calls `set_hud_size`
directly. After every resize the window re-centres on the active monitor using
`window.outer_size()` (the *current* width), so it stays centred across all
three states. Multi-monitor cursor-follow positioning is unchanged.

## How the three states behave (JS side)

`App.tsx` has one effect that derives the size:
- `recording` or `phase === 'transcribing'` → `recording`
- `showPanel` (user opened the pad via chevron, OR an error, OR a non-short
  response) → `panel`
- otherwise → `pill`

`isShortResponse()` classifies responses: capture/open-tool/run-task and brief
chat replies (≤140 chars) stay inline in the pill; long chats, file-match
lists, disambiguation, and errors expand into the scratch pad.

Recording shows ✕ (cancel — discards, returns to idle pill, no dispatch) and
✓ (finish — stops + dispatches). Tapping the mic again still works as an
equivalent stop. Idle pill keeps the 8px drag handle, mode toggle, keyboard
send arrow, chevron (open pad), and dismiss — all icon-only. Settings moved
into the scratch-pad header to keep the pill uncluttered.

## Verified

- `cd hud && npx tsc --noEmit` → clean (exit 0).
- `cd hud && npm run build` (`tsc -b && vite build`) → clean.
- `cd src-tauri && cargo check` → clean (exit 0) after the frontend `dist/`
  was built (Tauri's `generate_context!` requires `frontendDist` to exist).

## Not verified / stubbed

- No `tauri dev` / runtime smoke test was run — the visual layout, live
  resizing, and re-centring need a human pass via `npm run hud:dev`.
- Privacy posture unchanged: history stays local-only (`lib/history.ts`
  JSON ring buffer), no new network calls or telemetry.

## How to run

From the worktree: `npm run hud:dev` (needs the Rust toolchain + Tauri
prerequisites). This runs the Vite dev server and `tauri dev`.

## Open questions

- Pill width 220px is generous for "Tap to speak" — could trim to ~200, left
  at 220 so the keyboard-mode input + send arrow are comfortable.
- Recording-state width is fixed at 420px; it does not grow with very long
  interim transcripts (they truncate). Acceptable per the "modest widen" spec.
- `set_hud_expanded` shim is retained for safety; can be deleted once we're
  sure no other caller exists.
