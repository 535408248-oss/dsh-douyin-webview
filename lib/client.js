/**
 * dsh-douyin-webview — client half.
 *
 * One button in the already-declared `sidebar.footer.action` slot (the sidebar
 * foot, next to the settings gear). Pressing it mounts a real Electron
 * `<webview>` pointed at https://www.douyin.com/ into a fixed panel pinned to
 * the bottom-left corner of the window.
 *
 * ## Why a webview and not an iframe
 *
 * douyin.com refuses to be framed: the response carries `X-Frame-Options: DENY`
 * and a CSP whose `frame-ancestors` list is
 * `https://pc.xgo.bytedance.net … https://*.douyin.com …` — 127.0.0.1 is not in
 * it. A plain `<iframe>` is therefore rejected before a single byte of the page
 * is parsed. An Electron `<webview>` is a separate guest with its own renderer,
 * so `frame-ancestors` does not apply to it. That is the whole reason this
 * plugin exists.
 *
 * ## The lease protocol this plugin must obey
 *
 * `D:\Deepseek harness\resources\app.asar` → `lib/main.js` hosts
 * `DesktopBrowserGuests`. A webview may attach only when ALL of the following
 * hold, checked in `will-attach-webview`:
 *
 *   - `params.src` starts with `about:blank#` and the remainder is a lease id
 *     the main process issued to THIS window (`params.src.slice(12)` is the id);
 *   - `params.partition` equals the partition minted for that lease;
 *   - the lease has not already been attached.
 *
 * Anything else gets `event.preventDefault()` and no guest at all. So the
 * element is created with `src="about:blank#<lease>"` and
 * `partition="<partition>"` and is never handed a real URL through `src`; the
 * real navigation happens after `dom-ready`, through `element.loadURL(...)`.
 * On the way in, `will-attach-webview` also wipes every preference the page
 * could have set and forces `nodeIntegration:false`, `contextIsolation:true`,
 * `sandbox:true`, `webSecurity:true`, `webviewTag:false`, `devTools` off in a
 * packaged app.
 *
 * `allowedNavigation` (same file) permits only `http:`/`https:` URLs with no
 * credentials that are NOT the DSH host itself — douyin.com passes, the local
 * host does not. The lease's session is hardened before use: every permission
 * request is denied, downloads are cancelled, and `onBeforeRequest` cancels any
 * protocol outside http/https/ws/wss (plus about/data/blob).
 *
 * ## Why leases die, and why this plugin re-mounts
 *
 * `bind()` installs, on the main window's `webContents`:
 *   `owner.on("did-start-navigation", (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) releaseAll(); })`
 * plus `render-process-gone` and `destroyed` → `releaseAll()`. So a window
 * reload (F5 / Ctrl+R) silently destroys every guest on that window, and the
 * webview element's `destroyed` event is the only notice we get. The handler
 * below therefore re-`acquire`s and re-mounts — up to 3 consecutive times, so a
 * permanently broken window cannot spin forever.
 *
 * `releaseAll` drops leases but keeps `partitions`, which are keyed by the
 * workspace string. Re-acquiring with the same workspace therefore reuses the
 * same partition, and the douyin login cookie survives the reload.
 *
 * ## Why the panel is built with raw DOM
 *
 * The dock is appended to `document.body`, not rendered inside the sidebar. The
 * sidebar's collapse animation is a transform, and a `transform` on any ancestor
 * turns `position: fixed` into "fixed relative to that ancestor" — the panel
 * would then be clipped by the sidebar instead of pinned to the window corner.
 * This is the same reason dsh-douyin appends its own dock host to `document.body`
 * (`node_modules/dsh-douyin/lib/client.js:1219-1220`). Keeping the dock out of
 * React's tree also guarantees the reconciler never touches the webview node the
 * main process has leased.
 *
 * ## Packaging contract
 *
 * `window.__ModuleLoader__.load({ id, factory })`; the factory's exports become
 * the client module face, so `apply` and `inject` live on `exports`. `react` is
 * a seed name in the shell's static table and needs no `dsh.client.external`
 * declaration. `apply` is defensive about `slots` being present rather than
 * throwing the whole bundle away.
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-webview',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const h = react.createElement;

    const SLOT = 'sidebar.footer.action';
    const ID = 'douyin-webview';
    const HOME = 'https://www.douyin.com/';
    /** Guest storage identity; the same string always maps to the same partition. */
    const WORKSPACE = 'dsh-douyin-webview';
    const STYLE_ID = 'dsh-douyin-webview-style';
    const MAX_REMOUNTS = 3;
    /**
     * Nothing about the panel is remembered between runs.
     *
     * 用户 m05305「我记得说过默认打开抖音的时候是打窗口吧？，你现在显示的是小窗口，不要被
     * 标题那个误导了」: a `-3` storage key used to keep the last-clicked step, and a
     * stored `"1"` (小窗口) from any earlier click made every later open come up small
     * no matter what the code defaulted to. The step is therefore not stored at all:
     * each open starts at 「大」 and only a click on the badge changes it while the
     * panel is on screen. The corner was never restored either — the first paint
     * always clamps to the canonical corner of the starting step.
     */
    /**
     * Width douyin's desktop layout is designed for. The guest is always scaled
     * by `panelWidth / FIT_WIDTH`, so a 500px panel renders the 1024px layout at
     * 47% instead of clipping its right-hand column.
     */
    const FIT_WIDTH = 1024;
    /**
     * 用户 m04481「貌似里图标太近了 把它和抖音的都往上移动5px」: how far the resting
     * foot line sits above the sidebar's launch icon. Both panels share this so they
     * sit on the same line.
     */
    const FOOT_LIFT = 5;

    /**
     * The desktop browser bridge, or null where it does not exist.
     *
     * `lib/preload-app.cjs` injects `dshDesktop` only when
     * `location.protocol === "dsh-app:" && location.hostname === "app" && process.isMainFrame`.
     * A plain browser tab on http://127.0.0.1:19387 has neither the bridge nor a
     * `<webview>` tag, so the panel says so instead of drawing an empty frame.
     */
    function desktopBrowser() {
      const bridge = globalThis.dshDesktop?.browser;
      if (bridge === null || typeof bridge !== 'object') return null;
      if (typeof bridge.acquire !== 'function' || typeof bridge.release !== 'function') return null;
      return bridge;
    }

    const CSS = `
/* 用户 m06832「然后把这三个整体右对齐」: the auto margin lives on the FIRST of the three
   icons, so the free space in the footer row is absorbed here and 抖音 + 酷狗 + 123 浏览器
   slide to the row's right edge together, keeping their order and spacing. Putting it on
   the last icon instead would only have moved that one. The readout that shares this row
   no longer occupies any width (dsh-status-clock cancels its own box with a matching
   negative right margin when it parks on the account row), so it cannot fight the
   auto margin.

   用户 2026-10-09「把抖音酷狗网络的图标整体挪到时间的右边」: this is the ONLY auto margin
   in the row, and that is load-bearing. A second auto margin on the last icon does not
   reinforce it — flexbox splits the free space EQUALLY between the two, so the group
   stops in the middle of the row. Measured 2026-10-09 21:25 on a 1936px window (sidebar
   columns 0..280, the row's content box ending at 268): 140px free, 70px wasted on each
   side, the last glyph's ink ending at 192. With the second auto margin gone, all 140px
   lands here and the group ends on 268 with its last ink at 262 — which is where the time
   one row below ends too (its text measures 263), so the three icons line up on the
   time's right edge rather than floating over the middle of the footer. */
/* 用户 2026-10-10「123浏览器的图标颜色怎么和抖音和酷狗的不一样？」: the three toggle rules have to
   agree on brightness. 酷狗's rule (dsh-kugou-panel/lib/client.js, .kgp-toggle) has no opacity at all,
   this one carried opacity:.72, and the 123 one carried the same — so the row could show different
   weights depending on which resting states were live. Measured 2026-10-10 17:15 (1936px PrintWindow,
   cursor parked off-window): peak channel 抖音 217 / 酷狗 218 / 123 166; pixels >= 200: 55 / 45 / 0.
   The dim state is removed from all three — hover and open now change the background plate only,
   which is 酷狗's existing behaviour. */
.dyw-toggle{display:grid;place-items:center;width:28px;height:28px;margin-left:auto;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;transition:background .15s}
.dyw-toggle:hover{background:rgba(127,127,127,.16)}
.dyw-toggle[data-open="true"]{background:rgba(127,127,127,.16)}
.dyw-dock{--dyw-sidebar-w:264px;--dyw-bar-h:30px;--dyw-w:min(500px,calc(100vw - 16px));--dyw-h:calc(var(--dyw-w) * 9 / 16 + var(--dyw-bar-h));position:fixed;left:0;top:0;width:var(--dyw-w);height:var(--dyw-h);/* 用户 m04658「能不能把抖音和酷狗的黑，改成我这个会话框的黑？」: the near-black literals are
   gone; the card paints itself out of the host's own theme tokens instead. The box the user
   pointed at is the composer well, painted --dsw-alias-bg-base by the conversation panel
   (dsh-client-ui-conversation/lib/client.js, .v1kfCW_editor), and a pixel sample of that box
   on this machine reads exactly #101014 — which is what the active skin (dsh-dream-skin
   "abyss", lib/client.js) writes into that very token. So one token reaches both surfaces,
   and the card follows any skin change for free. The tokens are inline custom properties on
   body and this dock is a body child, so it inherits them; the literal is only the fallback
   for a host that ships no theme at all. */
margin:0;padding:0;right:auto;bottom:auto;color:inherit;overflow:hidden;z-index:890;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,rgba(16,16,20,.72));border:1px solid var(--dsw-alias-border-l2,#2b2b2b);box-shadow:0 18px 44px rgba(0,0,0,.32)}
.dyw-dock[data-size="3"]{--dyw-w:min(calc(100vw - 16px),calc((var(--dyw-avail-h,calc(100vh - 16px)) - var(--dyw-bar-h)) * 16 / 9))}
/* Two steps, both 16:9 and both inside the window: the base (small) box is a
   fixed 500×281, and [data-size="3"] grows the width to whatever 16:9 box fits
   in --dyw-avail-h, the height left between the title bar and the sidebar's foot
   row. A theater mode used to grow the dock to 100vw×100vh; the user rejected
   that outright ("我不要这种全屏") because it covered the window's own
   minimise/maximise/close buttons. */
/* 用户 m05443「抖音大窗口模式下，恢复原来的颜色  不然看不见清字。」: the 大 step pushes the
   dock out over the conversation column, and a transparent bar there leaves the badge and 收起
   floating on the wallpaper — the user reported the text as unreadable. That step, and only
   that step, gets the filled header back; 小 keeps the transparent bar of 用户 m05407, where
   the bar sits over the panel's own background. 用户 m05504「只要抖音大窗口的修改一下，小窗口
   和酷狗都保持透明」 confirms this is the only place any fill belongs. */
.dyw-dock[data-size="3"] .dyw-bar{background:var(--dsw-alias-bg-layer-1,#111)}

/* R179（2026-10-14，用户 m03874「抖音的小窗口和酷狗的那个窗口，我之前不是都是透明的吗？你怎么把它
   全变成黑的？抖音大窗口是不变的」）—— 小窗口恢复透明、大窗口原样不动。
   真因：卡片底色一直用的是 --dsh-dream-skin-composer-base，而皮肤把那一个 token 定义成“不透明”的
   实底（皮肤源码注释原文：「Fill from the OPAQUE composer-base token (NOT the alpha-washed
   --dsw-alias-bg-base) so ... the wallpaper slider can't thin it」）。改用带 alpha 的
   --dsw-alias-bg-base，卡片就重新透出壁纸；大窗口在下面单独把这一个 token 恢复回来。 */
.dyw-dock[data-size="3"]{background:var(--dsh-dream-skin-composer-base,var(--dsw-alias-bg-base,#050505))}

/* Magnetism: the snap transition only exists for the 180ms after a drag ends. */
.dyw-dock[data-snapping="true"]{transition:left .18s ease,top .18s ease}
.dyw-dock[data-dragging="true"]{transition:none}
/* 用户 m00002「酷狗和抖音两个界面，能不能置底？不要挡住其他界面？」: outside any press
   the dock drops itself to the bottom of the page (z-index:-1) and stops taking hits, so the
   conversation, the composer and every other panel render over it; the sidebar icon raises
   it again. The dock is never torn down in that state, so the guest keeps playing. */
.dyw-dock[data-behind="true"]{z-index:-1;pointer-events:none;visibility:hidden}
/* A guest swallows pointer moves over itself, which would freeze the drag the
   moment the cursor crossed the video. This overlay keeps hit-testing inside the
   parent renderer for as long as the drag lasts. */
.dyw-dock[data-dragging="true"] .dyw-body::after{content:"";position:absolute;inset:0;z-index:3}
/* The dock is a free-floating 16:9 panel, 500px wide by default: the bar is a
   magnetic drag handle and bounds() in createDockDom keeps it inside the window
   while magnetism snaps it flush against the sidebar rail. Its position and size
   are not remembered at all: every open lands on the canonical corner of its 「大」
   step, and only a click on the size badge changes it while it is on screen.
       (R178 已作废此段：面板不再为对话框隐藏自己，全部按 z-index 排队，见下方层号表。)
html:has([data-sidebar-collapsed="true"]) .dyw-dock{--dyw-sidebar-w:56px}
/* R174 — 用户 m03520「不行啊，你就看，他会挡住设置的文字」: DS Bot's popups (the account
   menu, the reaction strip, the folder / model / session menus, the avatar editor) live in
   the app tree at z-index 60, i.e. BELOW this dock's 900, so the dock covered the account
   menu's first row. Lift them here rather than patching ds-bot's own bundle: while a popup
   is open the dock sits under those popups by plain z-index comparison, so a plain
   z-index decides again and 955 > 900 leaves the popup readable with the panel still up. */
.bt-menu,.bt-react-strip,.bt-drop,.bt-newchat,.bt-avedit,.bt-update-pop{z-index:955!important}
.dyw-bar{flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;gap:6px;height:var(--dyw-bar-h);padding:0 6px;background:transparent;color:var(--dsw-alias-label-primary,#e8e8e8);cursor:grab;touch-action:none;font:12px/1 system-ui,-apple-system,"Segoe UI",sans-serif}
/* 用户 m05407「抖音和酷狗的标题栏的颜色能不能改成和背景一样的透明？」: the bar no longer
   paints --dsw-alias-bg-layer-1, so the card reads as one surface — the guest area's own
   black simply stops 30px lower and the bar takes the dock's background instead. The
   controls keep their own hover chips, so they stay readable without a bar fill. */
.dyw-dock[data-dragging="true"] .dyw-bar{cursor:grabbing}
/* 用户 m04844「把大窗口按钮移到左边 右边就剩下绿色点和关闭按钮」, restated by 用户 m05522
   「切换大小窗口的标题还是放左边吧」: the size badge belongs on the left. One flex spacer then
   splits the bar — badge alone on the left, status dot next to 收起 on the right, and the gap
   between them is the drag handle.
   用户 m05441 had briefly moved the badge right and asked for a black chip behind each control;
   用户 m05504 took the chips back («不，我说错了»), and nothing in either bar is filled now
   except the one rule that keeps the douyin 大 step readable (see [data-size="3"] above).
   The dot copies 酷狗's (.kgp-bar-dot): grey while the guest is still loading, green
   once the douyin page is ready, driven by the data-phase paintDock already writes. */
.dyw-bar-gap{flex:1}
.dyw-bar-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:#3a3a3a}
.dyw-dock[data-phase="ready"] .dyw-bar-dot{background:#39c76a}
.dyw-bar-size{flex:0 0 auto;padding:0 6px;border-radius:4px;background:transparent;color:var(--dsw-alias-label-primary,#e8e8e8);opacity:.7;font:13px/19px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.4px}
.dyw-bar-size:hover{opacity:1;background:rgba(255,255,255,.12)}
.dyw-bar-btn{flex:0 0 auto;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary,#e8e8e8);cursor:pointer;font-size:14px;line-height:1;opacity:.7}
.dyw-bar-btn:hover{opacity:1;background:rgba(255,255,255,.12)}
.dyw-bar-btn:disabled{opacity:.3;cursor:default}
.dyw-body{position:relative;flex:1 1 auto;min-height:0;background:#000}
.dyw-host{position:absolute;inset:0}
/* Electron's webview is a shadow-DOM host whose inner iframe is sized by
   flex:1 against the host's UA display. Forcing display:block here made that
   iframe fall back to its intrinsic 150px height: the page rendered in a
   letterbox strip at the top of the panel and the rest stayed black. Keep the
   host a flex container so the guest actually fills it. */
.dyw-frame{width:100%;height:100%;border:0;display:flex;flex-direction:column;background:#000}
.dyw-hint{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:10px;padding:20px;box-sizing:border-box;color:#cfcfcf;font:12px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center}
.dyw-hint b{color:#fe2c55;font-weight:600;font-size:13px}
.dyw-hint code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;opacity:.7;word-break:break-word}
.dyw-hint[hidden]{display:none}
`;

    function installStyle() {
      if (typeof document === 'undefined') return;
      const existing = document.getElementById(STYLE_ID);
      // Refresh rather than skip: a hot module swap re-runs `apply` while the old
      // <style> element is still in the document, and a skip-on-exists check would
      // silently keep serving the previous CSS.
      if (existing !== null) {
        if (existing.textContent !== CSS) existing.textContent = CSS;
        return;
      }
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      (document.head ?? document.documentElement).appendChild(style);
    }

    function glyph() {
      return h(
        'svg',
        { width: 20, height: 20, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M14.2 3h3.1c.3 2.05 1.62 3.55 3.7 3.86v3.02c-1.45-.03-2.72-.44-3.85-1.2v6.5a5.72 5.72 0 1 1-5.72-5.72c.3 0 .6.02.9.07v3.15a2.6 2.6 0 1 0 1.87 2.5V3z',
          fill: 'currentColor',
        }),
      );
    }

    /**
     * The dock chrome, built with raw DOM so it can live on `document.body`.
     *
     * `onGeometry` fires after every move or resize so the caller can re-fit the
     * guest's zoom to the new width.
     */
    function createDockDom(onClose, onGeometry) {
      const dock = document.createElement('div');
      dock.className = 'dyw-dock';
      dock.setAttribute('data-phase', 'idle');
      // Hidden until placed: the CSS default corner is (0,0) and one frame of a
      // black panel there is plainly visible.
      dock.style.visibility = 'hidden';

      const bar = document.createElement('div');
      bar.className = 'dyw-bar';

      // Two steps, both 16:9 and both inside the window: "小" is a fixed 500×281
      // box, "大" is as wide as a 16:9 box can be without reaching the title bar
      // or the sidebar's foot row. Every open starts at "大" (用户 m04903, restated
      // by 用户 m05305), and the badge below is the only thing that changes it.
      const SIZES = [
        ['1', '小窗口'],
        ['3', '大窗口'],
      ];
      // 用户 m05305「我记得说过默认打开抖音的时候是打窗口吧？，你现在显示的是小窗口」:
      // every open starts at the 「大」 step — nothing is read back from storage, so a
      // previous click on 小窗口 can no longer make the next open come up small.
      // 用户 m04903 asked for this default in the first place.
      dock.setAttribute('data-size', '3');

      const size = document.createElement('span');
      size.className = 'dyw-bar-size';
      // The badge names the size a click lands on, not the current one: the user
      // asked for the two words to be swapped because this control means "switch",
      // so reading the destination off the badge is the whole point.
      // 用户 m05342「把小窗口改成标题改成 切换大窗口    大窗口标题改成 切换小窗口」: the
      // verb is spelled out in front of it, so nobody can read the badge as the
      // current state — 用户 m05305 had just been tripped up by exactly that.
      const nextSize = (value) => SIZES[(SIZES.findIndex(([id]) => id === value) + 1) % SIZES.length];
      size.textContent = '切换' + nextSize(dock.getAttribute('data-size'))[1];
      size.title = '点击切换尺寸（小窗口 / 大窗口）';
      size.style.cursor = 'pointer';
      size.addEventListener('click', () => {
        const next = nextSize(dock.getAttribute('data-size'));
        // Switching size used to re-clamp from wherever the panel happened to be
        // *after* the box changed, so "大 → 小" landed somewhere new every time:
        // the larger box had already been pushed away from the edge and the small
        // box kept that pushed corner. Each step now owns a fixed corner instead:
        // small bottom-left, large top-right (see homeCorner).
        // The new step's own corner, read *after* the attribute flips: homeCorner
        // reads both data-size and the current rect, so computing it first would
        // send the panel to the corner of the step it is leaving.
        dock.setAttribute('data-size', next[0]);
        size.textContent = '切换' + nextSize(next[0])[1];
        measure();
        const home = homeCorner(dock.getBoundingClientRect());
        const back = clamp(dock.getBoundingClientRect(), home.x, home.y);
        place(back.x, back.y, true);
        onGeometry?.();
      });

      // The bar carries exactly two controls: the size badge and "收起". Douyin's
      // own fullscreen control still works — the shim in mount() emulates the HTML
      // fullscreen API inside the guest — it just has no mirror button up here.
      // 用户 m04844: the badge moves to the far left, and right of the spacer sit
      // just the status dot and 收起. The dot mirrors 酷狗's: it is grey while the
      // guest loads and turns green once the page is ready, because paintDock
      // already stamps data-phase on the dock after every state change.
      const gap = document.createElement('span');
      gap.className = 'dyw-bar-gap';

      const dot = document.createElement('span');
      dot.className = 'dyw-bar-dot';
      dot.title = '抖音网页正在加载';

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'dyw-bar-btn';
      close.title = '收起';
      close.textContent = '×';
      close.addEventListener('click', onClose);

      const body = document.createElement('div');
      body.className = 'dyw-body';

      const host = document.createElement('div');
      host.className = 'dyw-host';

      const hint = document.createElement('div');
      hint.className = 'dyw-hint';

      bar.append(size, gap, dot, close);
      body.append(host, hint);
      dock.append(bar, body);
      document.body.appendChild(dock);
      /* 用户 m03701「回退，你怎么把背景颜色偷偷改了？」: R168 的实色底板覆盖（离屏 span 解析
         --dsh-dream-skin-composer-base 并把去 alpha 的 rgb() 写到 dock.style.background）已撤除。
         面板底色重新只由下面那条 CSS 规则决定，跟随皮肤 token（含 alpha）。 */
      {

      /* R178（2026-10-14，用户 m03796 / m03804 收口）—— 顶层机制整体撤除，只按层号排队。
         以前面板挂 Popover 顶层，顶层比文档里任何 z-index 都高，于是每冒出一个新弹层就得再补一条让位规则：
         平台自带的设置对话框（1000）和 DS BOT 的菜单就是这么被漏掉的，面板一直压在它们上面。
         现在面板只占一个普通层号。全文档层号表（本机实测，逐条可查）：
           皮肤壁纸 -1  <  面板 890  <  DS BOT 三个弹层 950/951/952  <  DS BOT 菜单·表情条 955
           <  DS BOT toast 1000  <  平台设置对话框 1000 / 账号栏 1001  <  平台下拉（模型·日程·插件）1100
         面板在最底下那一档，所以设置、菜单、下拉全部画在它上面；壁纸在最底下，盖不住它。
         没有检测、没有名单、没有下一个要补的例外；面板不再隐藏自己（用户 m03438「他要常驻的」）。
         这个函数只剩一个防御职责：万一 popover 属性被挂回来（UA 的 [popover]:not(:popover-open){display:none}
         会把面板整块吃掉），立刻摘掉。 */
      const topmostDock = (target) => {
        if (target === null || target === undefined) return;
        try { if (target.matches(':popover-open')) target.hidePopover(); } catch (e) {}
        try { if (target.hasAttribute('popover')) target.removeAttribute('popover'); } catch (e2) {}
      };
      globalThis.__dsDockTopmost = topmostDock;
      topmostDock(dock);
      }

      // --- placement: magnetic drag ---------------------------------------------
      // The rail is a *magnetic* edge, not a wall. It used to be a hard left
      // limit, which made the panel impossible to move toward the sidebar and
      // collapsed its horizontal range to a single x whenever the window was
      // barely wider than the panel. Now the panel may sit anywhere in the
      // window and magnetism parks it flush against the rail when it is dropped
      // near it — the bottom-left default is still "beside the rail".
      /**
       * Top edge of the sidebar's foot row — the settings button and this plugin's
       * own toggle. The panel used to be clamped to the window's bottom edge, which
       * parked its bottom-left corner on top of the douyin launch icon: the icon
       * was covered, so the second click that closes the panel never landed.
       * Reserving the foot keeps the toggle reachable.
       */
      function footTop() {
        const rect = document.querySelector('.dyw-toggle')?.getBoundingClientRect();
        // 用户 m04481「貌似里图标太近了 把它和抖音的都往上移动5px」: the foot line
        // (and with it the panel's resting bottom edge) is lifted 5px clear of the
        // icon, which the panel was visually crowding.
        if (rect !== undefined && rect.height > 0) return rect.top - FOOT_LIFT;
        return window.innerHeight - 44 - FOOT_LIFT;
      }

      /**
       * Bottom edge of the window's title bar. On win32 the shell draws its window
       * buttons as a `titleBarOverlay` of `--dsh-windows-titlebar-height` px over
       * the top of the page, so a panel parked at y=8 lands on them and they stop
       * responding. 8px is the fallback where no overlay exists.
       */
      function topInset() {
        const raw = globalThis.getComputedStyle?.(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height');
        const parsed = Number.parseFloat(raw);
        return Number.isFinite(parsed) && parsed > 0 ? parsed + 4 : 8;
      }

      /**
       * Publish the vertical space the panel may actually use, then let CSS size the
       * "large" step from it. Without this the large step asks for a 16:9 box as
       * tall as the whole viewport, which covers the window buttons.
       */
      function measure() {
        // No bottom margin on purpose: the large step must end exactly where the
        // sidebar's foot row starts. A 16px reserve left a visible strip under the
        // panel that the user read as "still not maximised".
        const available = Math.max(160, footTop() - topInset());
        dock.style.setProperty('--dyw-avail-h', `${Math.round(available)}px`);
      }

      /**
       * The canonical corner of each step. The small panel's bottom-left corner is
       * the *sidebar's* bottom-left corner — x=0, bottom edge resting on the foot
       * row (the user: "我要的是贴近侧边栏的左下角哦"), which is also the empty
       * area this plugin was originally asked to fill. The large one hugs the
       * top-right (under the title bar, flush to the right edge). Both a size
       * switch and every window state change send the panel here, so the rule
       * "小的在左下角，大的在右上角" holds no matter where it was dragged to.
       */
      function homeCorner(rect) {
        if (dock.getAttribute('data-size') === '3') {
          return { x: window.innerWidth - rect.width, y: topInset() };
        }
        return { x: 0, y: footTop() - rect.height };
      }

      function bounds(rect) {
        const rail = sidebarWidth(dock) + 8;
        const top = topInset();
        // Flush edges, no 8px reserve: homeCorner parks the small step on the
        // window's bottom-left corner and a clamp that pulled it 8px back would
        // undo that. minX is 0, not 8, for the same reason — the panel is allowed
        // to sit over the sidebar's empty lower half.
        const maxX = Math.max(0, window.innerWidth - rect.width);
        // The large step is maximised: it already spans every pixel between the
        // title bar and the foot row, so a vertical drag has nowhere to go. Pin it
        // to the top instead of letting it slide inside an 8px sliver (the user:
        // "大窗口的时候怎么还能上下移动？"). Horizontal freedom stays.
        const maximised = dock.getAttribute('data-size') === '3';
        return {
          minX: 0,
          rail: rail <= maxX ? rail : null,
          maxX,
          minY: top,
          maxY: maximised ? top : Math.max(top, footTop() - rect.height),
        };
      }

      function clamp(rect, x, y) {
        const box = bounds(rect);
        return {
          x: Math.min(Math.max(box.minX, x), box.maxX),
          y: Math.min(Math.max(box.minY, y), box.maxY),
        };
      }

      /** Magnetic: an axis only sticks once it is within SNAP px of an edge. */
      function snap(rect, x, y) {
        const SNAP = 48;
        const box = bounds(rect);
        const stick = (value, edges) => {
          const clamped = Math.min(Math.max(box.minX, value), box.maxX);
          let best = clamped;
          let bestGap = SNAP + 1;
          for (const edge of edges) {
            if (typeof edge !== 'number') continue;
            const gap = Math.abs(value - edge);
            if (gap <= SNAP && gap < bestGap) {
              best = edge;
              bestGap = gap;
            }
          }
          return best;
        };
        return {
          x: stick(x, [box.minX, box.rail, box.maxX]),
          y: stick(y, [box.minY, box.maxY]),
        };
      }

      function place(x, y, animate) {
        const point = clamp(dock.getBoundingClientRect(), x, y);
        if (animate) {
          dock.setAttribute('data-snapping', 'true');
          window.setTimeout(() => dock.removeAttribute('data-snapping'), 200);
        }
        dock.style.left = `${Math.round(point.x)}px`;
        dock.style.top = `${Math.round(point.y)}px`;
        return point;
      }

      /** Re-clamp after a size change, then re-fit the guest. */
      function settle(animate) {
        measure();
        const rect = dock.getBoundingClientRect();
        place(rect.left, rect.top, animate);
        onGeometry?.();
      }

      let drag = null;
      bar.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest('button, .dyw-bar-size') !== null) return;
        const rect = dock.getBoundingClientRect();
        drag = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
        dock.setAttribute('data-dragging', 'true');
        try {
          bar.setPointerCapture(event.pointerId);
        } catch {
          /* capture is best-effort; the drag overlay keeps the moves coming */
        }
        event.preventDefault();
      });
      bar.addEventListener('pointermove', (event) => {
        if (drag === null || event.pointerId !== drag.id) return;
        place(event.clientX - drag.dx, event.clientY - drag.dy, false);
      });
      const endDrag = (event) => {
        if (drag === null || event.pointerId !== drag.id) return;
        drag = null;
        dock.removeAttribute('data-dragging');
        const rect = dock.getBoundingClientRect();
        const stuck = snap(rect, rect.left, rect.top);
        place(stuck.x, stuck.y, true);
        onGeometry?.();
      };
      bar.addEventListener('pointerup', endDrag);
      bar.addEventListener('pointercancel', endDrag);

      // A window state change (maximise, restore, a resize, the rail collapsing)
      // sends each step back to its canonical corner instead of clamping it in
      // place. Self-unsubscribes once the dock is gone.
      const onResize = () => {
        if (!dock.isConnected) {
          window.removeEventListener('resize', onResize);
          return;
        }
        measure();
        const home = homeCorner(dock.getBoundingClientRect());
        const back = clamp(dock.getBoundingClientRect(), home.x, home.y);
        place(back.x, back.y, false);
        onGeometry?.();
      };
      window.addEventListener('resize', onResize);
      // Escape is handled inside the guest by the shim, which owns the in-panel
      // fullscreen state; the dock itself has nothing to un-expand.

      // First paint: the canonical corner of the starting step (「大」 ⇒ top-right).
      // The avail-height has to be measured *before* the first rect is read,
      // otherwise that step would size itself off the fallback (the whole viewport)
      // and reach up into the title bar.
      measure();
      const rect = dock.getBoundingClientRect();
      const home = homeCorner(rect);
      const start = clamp(rect, home.x, home.y);
      dock.style.left = `${Math.round(start.x)}px`;
      dock.style.top = `${Math.round(start.y)}px`;
      dock.style.visibility = '';

      return { dock, size, dot, host, hint, reclamp: () => settle(false) };
    }

    /** The rail width, read from the CSS variable that already tracks collapse. */
    function sidebarWidth(dock) {
      const raw = globalThis.getComputedStyle?.(dock).getPropertyValue('--dyw-sidebar-w');
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) ? parsed : 264;
    }

    /** Repaint the dock chrome from one state snapshot. */
    function paintDock(dom, state) {
      dom.dock.setAttribute('data-phase', state.phase);
      const ready = state.phase === 'ready';
      // The bar dot reads off data-phase through CSS; only its tooltip needs text.
      dom.dot.title = ready
        ? '抖音网页已就绪'
        : state.phase === 'error' || state.phase === 'unsupported'
          ? '抖音网页没有就绪'
          : '抖音网页正在加载';
      dom.hint.hidden = ready;
      if (ready) return;
      dom.hint.textContent = '';
      if (state.phase === 'unsupported') {
        dom.hint.append(
          el('b', null, '这个窗口用不了内嵌抖音'),
          el(
            'span',
            null,
            '抖音返回 X-Frame-Options: DENY，普通浏览器标签页里的 <iframe> 一定会被拒绝；只有 Electron 的 webview 租约能绕开。',
          ),
          el('code', null, '请用 DSH 桌面版窗口打开（dsh-app://app）。'),
        );
        return;
      }
      if (state.phase === 'error') {
        dom.hint.append(
          el('b', null, '抖音窗口挂载失败'),
          el('code', null, state.detail || '未知错误'),
          el('span', null, '点标题栏右上角的 ⟳ 重试。'),
        );
        return;
      }
      dom.hint.append(
        el('b', null, '正在打开抖音…'),
        el('span', null, '首次加载较慢；登录一次之后，登录态留在专属分区里，重启也不用再登。'),
      );
    }

    function el(tag, attrs, text) {
      const node = document.createElement(tag);
      if (attrs !== null && attrs !== undefined) for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      if (text !== undefined) node.textContent = text;
      return node;
    }

    /**
     * One guest bound to one lease.
     *
     * @param host - element the webview is appended to.
     * @param onStatus - receives `{ phase, detail }` for the dock chrome.
     */
    function createController(host, onStatus) {
      let bridge = null;
      let reservation = null;
      let element = null;
      let active = false;
      let disposed = false;
      let remounts = 0;
      let unsubscribeOpen = null;
      let fit = { width: 0 };

      const status = (phase, detail = '') => onStatus({ phase, detail });

      /**
       * douyin.com lays its desktop UI out for ~1024px and clips the right-hand
       * column below that rather than reflowing, so scale the whole guest down.
       * Zoom is per-origin in Electron, so this has to run again after every
       * document load, not just once at mount.
       */
      function syncFit() {
        if (element === null) return;
        const scale = fit.width > 0 ? Math.min(1, Math.max(0.5, fit.width / FIT_WIDTH)) : 1;
        try {
          element.setZoomFactor?.(scale);
        } catch {
          /* a guest mid-navigation refuses the call; the next dom-ready retries */
        }
      }

      function detach() {
        if (typeof unsubscribeOpen === 'function') {
          try {
            unsubscribeOpen();
          } catch {
            /* the preload bridge already dropped it */
          }
        }
        unsubscribeOpen = null;
        const held = element;
        element = null;
        if (held === null) return;
        try {
          held.remove();
        } catch {
          /* already gone */
        }
      }

      async function release() {
        const held = reservation;
        reservation = null;
        if (held === null || bridge === null) return;
        try {
          await bridge.release(held.lease);
        } catch {
          /* the main process already dropped it (releaseAll) */
        }
      }

      async function mount() {
        if (disposed || !active) return;
        bridge = desktopBrowser();
        if (bridge === null) {
          status('unsupported', '只有 DSH 桌面版窗口（dsh-app://app）才有 dshDesktop.browser');
          return;
        }
        status('leasing', '正在申请 webview 租约…');
        let held;
        try {
          held = await bridge.acquire(WORKSPACE);
        } catch (error) {
          status('error', String(error?.message ?? error));
          return;
        }
        if (disposed || !active) {
          try {
            await bridge.release(held.lease);
          } catch {
            /* nothing to do */
          }
          return;
        }
        reservation = held;
        status('attaching', '正在挂载抖音窗口…');

        const node = document.createElement('webview');
        node.className = 'dyw-frame';
        // Parity with @deepseek-ai/dsh-client-ui-sidebar-browser/lib/client.js:1336-1342:
        // `allowpopups` lets the guest reach `setWindowOpenHandler` (the main process
        // always answers `{ action: "deny" }`, but it first sends us
        // `browserOpenRequested` for http/https targets); `data-sidebar-browser-frame`
        // is the marker the shell's shortcut bridge looks for.
        // Electron's own UA carries `Electron/<version>`, and douyin.com gates parts of
        // its player on the UA string. Present as plain desktop Chrome instead.
        node.setAttribute(
          'useragent',
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        );
        node.setAttribute('name', held.lease);
        node.setAttribute('allowpopups', '');
        node.setAttribute('data-sidebar-browser-frame', 'webview');
        // The lease id IS the fragment; `params.src.slice(12)` in the main process reads it.
        node.setAttribute('src', `about:blank#${held.lease}`);
        node.setAttribute('partition', held.partition);
        // New-window links: the main process denies the popup and tells us the URL
        // instead. Follow it in this same guest rather than losing the click.
        try {
          unsubscribeOpen = bridge.onOpenRequested(held.lease, (url) => {
            if (disposed || element !== node) return;
            node.loadURL(url).catch(() => {
              /* a denied or aborted follow-up is not worth a visible error */
            });
          });
        } catch {
          unsubscribeOpen = null;
        }
        node.addEventListener('dom-ready', () => {
          if (disposed || element !== node) return;
          syncFit();
          // Douyin's own fullscreen button calls the HTML fullscreen API, which the
          // shell denies for every guest: `configureSession` installs
          // `setPermissionRequestHandler((_c, _p, cb) => cb(false))` on this
          // partition, and Electron's `WebContents::OnEnterFullscreenModeForTab`
          // returns early when `!allowed` — so the click is swallowed with no error.
          // Emulate it inside the guest instead: the requested element is pinned to
          // the guest's own viewport, which IS "the douyin window" — the desktop
          // window never changes size, so this is not the whole-app fullscreen the
          // user rejected. Injected into the guest's main world on every dom-ready
          // so the page's own enter/exit path keeps working (SPA re-renders included).
          const shim = '(function(){if(window.__dywFs)return;window.__dywFs=1;'
            + 'var d=document,c=null,st=null,s=d.createElement("style");'
            + 's.textContent=".dyw-fs{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;transform:none!important;object-fit:cover!important;z-index:2147483647!important;background:#000!important}";'
            + 'function e(){if(!s.isConnected)(d.head||d.documentElement).appendChild(s)}'
            + 'function f(el){try{d.dispatchEvent(new Event("fullscreenchange"))}catch(x){}try{d.dispatchEvent(new Event("webkitfullscreenchange"))}catch(x){}if(el){try{el.dispatchEvent(new Event("fullscreenchange"))}catch(x){}try{el.dispatchEvent(new Event("webkitfullscreenchange"))}catch(x){}}}'
            + 'function u(el){if(!el)return;el.classList.remove("dyw-fs");if(st&&st.p){try{st.p.insertBefore(el,st.n)}catch(x){try{st.p.appendChild(el)}catch(y){}}}st=null}'
            + 'function a(el){e();if(c&&c!==el)u(c);c=el;el.classList.add("dyw-fs");'
            + 'try{var q=el.getBoundingClientRect();if(q.width<innerWidth*0.9||q.height<innerHeight*0.9){st={p:el.parentNode,n:el.nextSibling};d.body.appendChild(el)}}catch(x){}'
            + 'f(el)}'
            + 'function r(){var el=c;u(c);c=null;f(el)}'
            + 'function pick(){try{var l=d.querySelectorAll("video");for(var i=0;i<l.length;i++){var b=l[i].getBoundingClientRect();if(b.width>160&&b.height>90&&b.bottom>0&&b.top<innerHeight&&b.right>0&&b.left<innerWidth)return l[i]}}catch(x){}return d.documentElement}'
            + 'window.__dywToggle=function(){if(c)r();else a(pick())};'
            + 'var p=Element.prototype;'
            + '["requestFullscreen","webkitRequestFullscreen","webkitRequestFullScreen","mozRequestFullScreen","msRequestFullscreen"].forEach(function(n){if(p[n])p[n]=function(){a(this);return Promise.resolve()}});'
            + 'var v=window.HTMLVideoElement&&HTMLVideoElement.prototype;'
            + 'if(v){v.webkitEnterFullscreen=function(){a(this)};v.webkitExitFullscreen=function(){r()};'
            + 'try{Object.defineProperty(v,"webkitSupportsFullscreen",{get:function(){return true},configurable:true})}catch(x){}'
            + 'try{Object.defineProperty(v,"webkitDisplayingFullscreen",{get:function(){return c===this},configurable:true})}catch(x){}}'
            + 'd.exitFullscreen=function(){r();return Promise.resolve()};'
            + 'd.webkitExitFullscreen=function(){r();return Promise.resolve()};'
            + 'try{Object.defineProperty(d,"fullscreenElement",{get:function(){return c},configurable:true})}catch(x){}'
            + 'try{Object.defineProperty(d,"webkitFullscreenElement",{get:function(){return c},configurable:true})}catch(x){}'
            + 'try{Object.defineProperty(d,"fullscreenEnabled",{get:function(){return true},configurable:true})}catch(x){}'
            + 'try{Object.defineProperty(d,"webkitFullscreenEnabled",{get:function(){return true},configurable:true})}catch(x){}'
            + 'd.addEventListener("dblclick",function(ev){var t=ev.target;if(t&&t.closest&&t.closest("input,textarea,[contenteditable]"))return;ev.preventDefault();window.__dywToggle()},true);'
            + 'd.addEventListener("keydown",function(ev){if(ev.key==="Escape"&&c){ev.stopPropagation();r()}},true);'
            + '})();';
          node.executeJavaScript(shim, true).catch(() => {
            /* a guest mid-navigation refuses the call; the next dom-ready retries */
          });
        });
        node.addEventListener(
          'dom-ready',
          () => {
            if (disposed || element !== node) return;
            remounts = 0;
            status('ready', '');
            node.loadURL(HOME).catch((error) => {
              if (disposed || element !== node) return;
              if (error?.code === 'ERR_ABORTED') return;
              status('error', String(error?.message ?? error));
            });
          },
          { once: true },
        );
        node.addEventListener('did-fail-load', (event) => {
          if (disposed || element !== node) return;
          if (!event.isMainFrame || event.errorCode === -3) return;
          status('error', `${event.errorDescription ?? 'load failed'} (${event.errorCode})`);
        });
        node.addEventListener(
          'destroyed',
          () => {
            if (disposed || element !== node) return;
            element = null;
            // The main process's releaseAll already dropped this lease.
            reservation = null;
            if (!active) return;
            if (remounts >= MAX_REMOUNTS) {
              status('error', '窗口被反复销毁（宿主窗口可能刚刷新过），已停止自动重挂');
              return;
            }
            remounts += 1;
            status('attaching', `窗口被销毁，正在重挂（第 ${remounts} 次）…`);
            setTimeout(() => {
              if (active && !disposed) void mount();
            }, 400);
          },
          { once: true },
        );

        element = node;
        host.appendChild(node);
        syncFit();
      }

      return {
        async open() {
          if (disposed || active) return;
          active = true;
          remounts = 0;
          await mount();
        },
        async close() {
          if (!active) return;
          active = false;
          detach();
          await release();
          status('idle', '');
        },
        reload() {
          if (element === null) return;
          element.reload?.();
        },
        /**
         * Toggle the page's fullscreen *inside the guest*. The shim installed on
         * every dom-ready owns that state; the expansion is bounded by the guest
         * viewport — this panel's body — never by the desktop window. Only the
         * page's own control calls this now; the bar has no mirror button.
         */
        toggleFullscreen() {
          if (element === null) return;
          element.executeJavaScript('window.__dywToggle&&window.__dywToggle()', true).catch(() => {
            /* a guest mid-navigation refuses the call; the next dom-ready retries */
          });
        },
        /** Called on every move/resize so the guest keeps matching the panel. */
        applyFit(width) {
          fit = { width };
          syncFit();
        },
        async dispose() {
          disposed = true;
          active = false;
          detach();
          await release();
        },
      };
    }

    /** The sidebar-foot button. The dock it toggles lives on `document.body`. */
    function DouyinToggle() {
      const [open, setOpen] = react.useState(false);
      const [state, setState] = react.useState({ phase: 'idle', detail: '' });
      const domRef = react.useRef(null);
      const controllerRef = react.useRef(null);
      // whether the dock is currently parked under the app (用户 m00002 置底)
      const behindRef = react.useRef(false);

      react.useEffect(() => {
        if (!open) return undefined;
        behindRef.current = false;
        const dom = createDockDom(
          () => setOpen(false),
          () => {
            const current = domRef.current;
            if (current === null) return;
            controllerRef.current?.applyFit(current.dock.getBoundingClientRect().width);
          },
        );
        domRef.current = dom;
        const controller = createController(dom.host, setState);
        controllerRef.current = controller;
        controller.applyFit(dom.dock.getBoundingClientRect().width);
        paintDock(dom, { phase: 'idle', detail: '' });
        void controller.open();
        return () => {
          domRef.current = null;
          controllerRef.current = null;
          void controller.dispose();
          dom.dock.remove();
        };
      }, [open]);

      react.useEffect(() => {
        const dom = domRef.current;
        if (dom === null) return;
        paintDock(dom, state);
      }, [state]);

      // 用户 m03438「我不是要他消失啊，他要常驻的」: the dock is PERMANENT now. The old
      // capture-phase pointerdown parked it under the app (`data-behind`) the moment the
      // user pressed anywhere else — and on a translucent skin that parked dock only read
      // as a blurry ghost through the layers above it (用户 m03422「我只要一点其他地方，
      // 就会模糊掉」). Removing the listener is what makes it resident: a click elsewhere
      // changes nothing, and the only ways out stay explicit — 收起 / ×. The raise branch
      // in the sidebar icon below is kept for a dock that is parked by some future caller.

      return h(
        'button',
        {
          type: 'button',
          className: 'dyw-toggle',
          'data-open': open ? 'true' : 'false',
          title: open ? '收起抖音内嵌窗口' : '打开抖音内嵌窗口',
          'aria-label': open ? '收起抖音内嵌窗口' : '打开抖音内嵌窗口',
          onClick: () => {
            // 用户 m00002「能不能置底」: a dock parked under the app is raised by the
            // icon instead of being torn down; only a front-facing dock closes here.
            if (open && behindRef.current) {
              behindRef.current = false;
              domRef.current?.dock.removeAttribute('data-behind');
              if (domRef.current) globalThis.__dsDockTopmost?.(domRef.current.dock, true);
              return;
            }
            setOpen((value) => !value);
          },
        },
        glyph(),
      );
    }

    function apply(ctx) {
      installStyle();
      if (typeof ctx?.slots?.inject !== 'function' || typeof ctx?.slots?.register !== 'function') {
        console.error('[dsh-douyin-webview] 没有 slots 服务，面板未挂载');
        return;
      }
      // `sidebar.footer.action` is declared by @deepseek-ai/dsh-client-ui-sidebar
      // (`lib/client.js:403` renders it, `:515` hands it `{ wide }`); registering
      // into an undeclared slot throws `slot "…" is not declared`, hence `inject`.
      ctx.slots.inject(SLOT, function* () {
        yield ctx.slots.register({ name: SLOT, id: ID, priority: 10 }, DouyinToggle);
      });
    }

    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});