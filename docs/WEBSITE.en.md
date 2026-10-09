# Website and interactive demo

The public site combines static pages from `site/` with an interactive demo built from the shared `apps/web/` client. The demo uses sample accounts and messages. Its mail assistant shows a preset conversation, answers, and source citations; it does not connect to a real mailbox or require a model provider. The standalone demo defaults to `demo=1&preview=site`, carries `noindex,nofollow`, and uses a CSP with `connect-src 'none'` to block network connections.

## Build and preview locally

Install the repository dependencies, then run these commands from the repository root:

```powershell
node scripts/build-site.mjs
node scripts/preview-site.mjs
```

The builder renders documentation and the sitemap, builds the shared Agent contracts, and writes the `apps/web/` bundle to `site/demo/`. The preview server listens on `127.0.0.1:5176` by default.

The website demos stay in their respective inbox and assistant views. Source mail opens in a dialog inside the assistant instead of switching workspaces. This applies only to `preview=site`; the ordinary client and development `demo=1` retain workspace switching.

Each demo starts loading automatically when at least a quarter of its main surface is visible and scrolling has settled. Its height is reserved before the first paint to keep the page and anchor positions stable. The waiting and loading states use the client's logo, expanding wordmark, and loading bar, without a manual start button. When ready, the startup placeholder fades out while the client fades in with a slight upward movement. Reduced-motion preferences disable the animations. A retry button appears only after a failed load. Browsers without IntersectionObserver also load automatically using viewport geometry. Scrolling away preserves an already loaded demo's state; opening and closing source mail also preserves the host page's scroll position.

The site's theme and language controls reload only demos that have already started; unopened demos use the latest choices when they enter the viewport. Each demo also has a reset button. The website preview defers the first-run translation prompt without recording acceptance; using translation still requires confirmation.

Once the client is ready and at least half of the demo is visible, a three-step tour plays once. The inbox shows the unified inbox, a sender search, and the message reader; the assistant shows an answer, its citations, and the original source mail. Actions stay for about two seconds, while reading steps allow about three seconds, with smooth close-ups of the relevant area. A simulated cursor moves to each control before clicking and follows the camera, without a focus frame. Close-ups transform the actual shared client. `site/demo-tour.js` operates existing search, reader, and source controls in the same-origin iframe without calling a model or mailbox API.

Scrolling away or hiding the browser tab pauses the tour; returning resumes it. Clicking, typing, or scrolling inside the client stops autoplay and restores the normal scale until the visitor explicitly plays it again. The toolbar provides pause, replay, and a close-up toggle, and the demo remains interactive after the tour. Close-ups are disabled below a demo width of 760 pixels. Reduced-motion preferences disable autoplay by default, while explicit playback still shows the steps without zooming. Public previews load dialogs on demand instead of preloading them during idle time; the normal client's preload policy stays the same.

Browser tab icons share the app's brand outline. The README header uses a transparent SVG wordmark generated from `wordmark-reference.png` and the same brand outline; its text color follows `prefers-color-scheme`. Run `npm run build:brand` to generate the brand SVGs and `npm run build:brand:check` to verify that generated files are in sync.

The homepage, documentation overview, and articles use the same global navigation: Home, Features, Assistant, Privacy, Docs, and GitHub, with a separate download button. The current page or section is marked with `aria-current`. Theme and language preferences persist across pages; articles keep their own sidebar and table of contents. At widths of 900 pixels or less, a native `details` menu replaces the desktop links and remains usable without JavaScript. Shared navigation styles live in `site/base.css`.

## Website interaction regression

After building, run the dedicated Playwright site suite:

```powershell
npx playwright test --config playwright.site.config.ts
```

The suite covers both embedded demos, mail search and starring, site theme and language sync, assistant source citations, the narrow-screen menu, safe defaults for a standalone demo, and the absence of API requests from the demo. Navigation checks cover consistent links across the homepage and documentation, nested article links back to homepage sections, language and theme persistence, and the mobile menu with JavaScript disabled.
Demo lifecycle checks cover the startup placeholder without client requests before visibility, the absence of a manual start button, stable height and scroll position, fixed workspaces, source-dialog focus restoration, retries after failed loading, and automatic loading without IntersectionObserver.
Tour checks cover real search and reading, source dialogs, a single completed run, close-up toggling, visitor input taking control, offscreen pause and resume, reduced motion, and narrow layouts.

## Publishing

The GitHub Pages workflow builds and publishes `site/` when related site, docs, web client, contracts, or build configuration changes reach `main`; it can also be started manually. `site/demo/` is a build artifact and is not committed. Client code, documentation pages, and the sitemap are generated together for each deployment.

Pull requests run the same `npm ci --ignore-scripts` install and `node scripts/build-site.mjs` build on Ubuntu. The required `validate` check also requires this Linux build to pass. Script tests verify that the lockfile includes every platform binding declared by Rolldown, Lightning CSS, esbuild, and workspace TypeScript packages. When repairing a lockfile, resolve bindings for the existing tool versions in a clean staging directory without `node_modules`, and review dependency versions before committing the repair.
