/**
 * dsh-douyin-webview — host half.
 *
 * Deliberately empty of behaviour. Everything this plugin does happens in the
 * renderer, because the machinery it needs is already in the Desktop main
 * process and is reached through the preload bridge, not through a Cordis
 * service:
 *
 *   - the guest lease API is `dshDesktop.browser.{acquire,release,onOpenRequested}`
 *     (`D:\Deepseek harness\resources\app.asar` → `lib/preload-app.cjs`,
 *     `createDesktopBrowserBridge()`), backed by
 *     `ipcMain.handle("dsh-desktop:browser-acquire", …)` in `lib/main.js`;
 *   - the webview attachment checks live in `DesktopBrowserGuests.bind()`.
 *
 * There is no host route to add and no host service to register, so this file
 * exists only because a bundle row needs a mountable module: `package.json`
 * points `main` at it and `cordis.patch.yml` inserts the row.
 */
export const name = 'dsh-douyin-webview';
export const inject = [];

/** Mount nothing on the host; the client half owns the whole feature. */
export function apply() {
  // Intentionally empty. See the file header for why there is no host work.
}