# Changelog

All notable changes to **PlantUML for GitHub** are documented here.
The project is published as two browser extensions (Chrome and Firefox)
that share the same version number from `0.2.2` onward.

## 0.2.2

- Added a **Copy as bitmap** button in the diagram header that copies
  the rendered diagram to the clipboard as a PNG image (uses
  `ClipboardItem` with a `Promise<Blob>` to preserve the click's
  transient user activation while the SVG-to-PNG conversion runs in
  the sandboxed renderer iframe).
- The PNG is rendered at `devicePixelRatio` for crisp output and
  uses the current theme background so it looks right when pasted
  into light or dark targets.
- Added the `clipboardWrite` permission to both manifests.
- Visual feedback on the button: green flash on success, red flash
  with an error tooltip on failure.

## 0.2.1

- First Firefox version.
- Same feature set as Chrome 0.1.0, packaged for Firefox (Manifest V3,
  `browser_specific_settings.gecko`, vendor bundle split into 7
  classic-script chunks to stay under Mozilla AMO's 5 MB per-file
  limit).
- Iframe rendered without the `sandbox` attribute on Firefox:
  `moz-extension://` pages loaded in a sandboxed iframe get a
  nullprincipal origin, which blocks ES module loading. Isolation
  from `github.com` is already provided by the cross-origin
  extension page.

## 0.1.0

- First Chrome version.
- Detects fenced code blocks tagged `plantuml`, `puml`, or `wsd`
  (Linguist's canonical name) on any `github.com` page and replaces
  them with a sandboxed iframe that renders the diagram client-side
  using the TeaVM-compiled PlantUML engine.
- Header bar with a toggle button to switch between the rendered
  diagram and the original source.
- Dark / light theme tracking via GitHub's `data-color-mode`
  attribute (with OS-preference fallback for `auto`).
- `MutationObserver` to catch code blocks injected after initial
  page load (issues, PRs, discussions, lazy-loaded comments).
