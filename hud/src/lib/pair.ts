// OAuth-style pairing for the Ergora HUD.
//
// End users never see a token. They click "Sign in to Ergora" in the HUD,
// the browser opens to ergora.cloud/remote/pair, they log in normally (if
// they aren't already), and the portal hands them back to the HUD via the
// ergora-remote:// custom URL scheme. The HUD extracts the token, writes
// it to ~/.ergora-remote/.env, and reloads its config — no copy-paste,
// no terminology, no .env files surfaced.
//
// Two pieces:
//   • setupPairListener(handler) — registers a global onOpenUrl listener
//     that runs for the lifetime of the app. Fires whenever ergora-remote://
//     callbacks arrive (including the launch-by-URL case).
//   • openSignIn(apiUrl) — opens the user's default browser to the portal
//     pair endpoint with a random state nonce.

import { onOpenUrl, getCurrent } from '@tauri-apps/plugin-deep-link';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { saveAgentToken } from './config';

export interface PairResult {
  token: string;
  state: string | null;
}

// Parse a single deep-link URL into a token + state pair. Returns null if
// the URL isn't a recognised pair callback so the listener can skip it.
export function parsePairUrl(url: string): PairResult | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'ergora-remote:') return null;
  // host *or* pathname depending on how the OS canonicalises the URL —
  // e.g. macOS gives `ergora-remote://pair?...`, some Linux WMs give
  // `ergora-remote:/pair?...` (no host). Accept both.
  const route = u.host || u.pathname.replace(/^\/+/, '');
  if (route !== 'pair') return null;
  const token = u.searchParams.get('token');
  if (!token || !token.startsWith('eal_')) return null;
  return { token, state: u.searchParams.get('state') };
}

/**
 * Register a long-lived listener for ergora-remote:// callbacks. The handler
 * is called whenever a pair URL arrives — also fires synchronously if the
 * app was *launched* by a deep link (the URL is buffered before mount).
 *
 * Writes the token to ~/.ergora-remote/.env via saveAgentToken, then invokes
 * `onPaired(token)` so the caller can refresh config / re-render. Errors
 * during persistence are passed to `onError` rather than thrown — a deep
 * link can arrive at any time and crashing the listener is worse than
 * surfacing a banner.
 */
export async function setupPairListener(opts: {
  onPaired: (token: string) => void;
  onError?: (err: Error) => void;
}): Promise<() => void> {
  const handle = async (url: string) => {
    const parsed = parsePairUrl(url);
    if (!parsed) return;
    try {
      await saveAgentToken(parsed.token);
      opts.onPaired(parsed.token);
    } catch (err) {
      opts.onError?.(err as Error);
    }
  };

  // 1) Cold-start case: the app was launched by clicking a deep link. The
  //    plugin buffers the URL on launch — `getCurrent()` returns it once.
  try {
    const initial = await getCurrent();
    if (initial && initial.length) {
      for (const u of initial) {
        await handle(u);
      }
    }
  } catch {
    // getCurrent() throws if the platform doesn't support cold-start URLs.
    // Non-fatal — the listener below still catches warm callbacks.
  }

  // 2) Steady-state case: app already running, OS routes the URL to it.
  const unlisten = await onOpenUrl((urls) => {
    for (const u of urls) {
      void handle(u);
    }
  });

  return unlisten;
}

/**
 * Open the user's default browser to ergora.cloud/remote/pair. The state
 * nonce is currently passive (the portal echoes it back) — included for
 * future CSRF tightening but not enforced on the receiving side, since
 * the token endpoint already requires an authenticated portal session.
 *
 * @returns the state nonce sent with the request (for the caller to
 *          stash and verify against the callback if they want to).
 */
export async function openSignIn(apiUrl: string): Promise<string> {
  // crypto.randomUUID is available in modern browser webviews (WKWebView,
  // WebView2, WebKitGTK) — Tauri 2 targets all three.
  const state = crypto.randomUUID();
  const url = new URL('/remote/pair', apiUrl);
  url.searchParams.set('state', state);
  await openExternal(url.toString());
  return state;
}
