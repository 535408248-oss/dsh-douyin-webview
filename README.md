# dsh-douyin-webview

An embedded Douyin window docked in the DSH sidebar footer — watch Douyin in the
bottom-left corner while you keep working.

> **Desktop only.** The panel needs DSH's Desktop renderer: it mounts a real
> Electron `<webview>` through the preload bridge (`dshDesktop.browser.acquire`),
> which does not exist in a browser tab. In the Web UI the sidebar button still
> appears, and the panel explains why it cannot work.

## Why a webview and not an iframe

`douyin.com` answers with `X-Frame-Options: DENY` and a CSP `frame-ancestors`
list that does not include `127.0.0.1`, so an iframe is rejected outright. A
`<webview>` is a separate renderer guest, which `frame-ancestors` cannot reach —
that is the whole reason this plugin exists.

## What it does

- A 抖音 button in the sidebar footer toggles the panel.
- The panel opens at the bottom-left, **above that button**, at 480×300
  (480×270 of 16:9 content under a 30px title bar).
- The title bar carries the size badge on the left and, on the right, a status
  dot (grey while the page loads, green once it is ready) and the close button.
  Click the badge to switch between 小窗口 and 大窗口; the large step fills the
  height available between the title bar and the footer.
- Drag anywhere on the title bar to move it; it snaps to the viewport edges.
- **Double-click inside the page** (or use Douyin's own fullscreen control) to
  take the video full-frame *inside the panel*.

## Notes

- The `partition` comes from the Desktop guest lease, so the Douyin login
  survives panel close/reopen. Keep the partition persistent (see
  `dsh-侧栏浏览器分区持久化`) if you want it to survive a restart too.
- Douyin's own `⛶` control is intercepted and re-implemented in-page: Electron's
  `WEB_VIEW_ATTRIBUTES` has no `allowfullscreen`, so the native request would be
  silently denied. The shim rewrites the Fullscreen API inside the guest and
  scales the video to the panel's own viewport.
- The panel colours follow the host theme tokens (`--dsw-alias-bg-base`,
  `--dsw-alias-bg-layer-1`), so it matches whichever skin you run.

## Install

```sh
dsh plugin --profile desktop add dsh-douyin-webview
```

or list the package in your profile's `dsh.profile.bundles`.

## Licence

MIT
