# Changelog

All notable changes to **PlantUML for GitHub** are documented here.
The project is published as two browser extensions (Chrome and Firefox)
that share the same version number from `0.2.2` onward.

## 0.3.1

- **`!include <lib/...>` now works for 16 standard-library
  collections**, most notably **C4** (`!include <C4/C4_Context>`
  and friends), fixing
  [#10](https://github.com/plantuml/plantuml-for-github/issues/10).
  The engine lazy-loads a `<lib>.min.js` bundle next to
  `renderer.html`; the extension previously did not ship any of
  these bundles, so every stdlib include failed with a fatal
  parsing error. The extension now bundles the self-contained
  libraries that are small enough to ship (~2.5 MB raw in total):
  adaml, archimate, azure, c4, classy, classy-c4, cloudinsight,
  cloudogu, domainstory, edgy, eip, elastic, gcp, k8s, kubernetes,
  osa2.
- The heavy sprite collections (ibm, tupadr3, awslib*, material*,
  logos, office, osa, bootstrap*) are **not** bundled: together
  they would add ~90 MB to the package. Supporting them needs an
  on-demand data download, which is tracked separately.

## 0.3.0

- **The Graphviz WebAssembly module is gone.** Graph layout (class,
  component, deployment, state, and use-case diagrams) is now done by
  Smetana, PlantUML's built-in Java port of the Graphviz layout
  algorithms, which TeaVM compiles into `plantuml.js` along with the
  rest of the engine. `vendor/viz-global.js` is no longer shipped.
- The manifest is back to the stock Manifest V3 Content Security
  Policy: the `'wasm-unsafe-eval'` relaxation is not needed anymore
  because nothing instantiates WebAssembly.
- Engine updated from 1.2026.4beta4 to a 1.2026.8beta1 snapshot
  (plantuml/plantuml commit `0e4f452`), which includes the Smetana
  browser support and the Smetana performance work from upstream
  PlantUML. Build commands are documented in FIREFOX.md.
- The extension is much smaller: the Chrome build ships one 3.9 MB
  engine file where it previously shipped 8.8 MB across two files.
- Diagrams that go through graph layout can look slightly different
  than before: Smetana and Graphviz produce equivalent but not
  pixel-identical layouts.

## 0.2.4

- Added a **right-click context menu** on the rendered diagram with
  two entries: **Copy as bitmap** and **Copy as SVG**. The menu
  appears wherever you right-click on the SVG itself (inline or in
  the edit-as-draft preview) and matches GitHub's light/dark theme.
- **Copy as SVG** writes the SVG markup to the clipboard as
  `text/plain` (with the `xmlns` attribute set so the result is a
  valid standalone SVG document -- paste into Inkscape, save to a
  `.svg` file, etc.).
- **Copy as bitmap** from the context menu writes a PNG to the
  clipboard using the same engine as the header bitmap button
  (`devicePixelRatio` scaling, theme background). The header button
  keeps its existing visual feedback; the context-menu version is
  silent.
- The menu closes on outside click, Escape, scroll, resize, window
  blur, or selecting an entry.

## 0.2.3

- Added an **Edit as draft** button (pencil icon) in the diagram
  header that opens a large two-column editor: the PlantUML source
  on the left, a live preview on the right that updates as you type.
- The modal includes a **Copy as bitmap** button so you can grab a
  PNG of your edited diagram.
- Drafts are local only: your changes never touch the GitHub source
  and are discarded when you close the modal. Copy/paste the source
  if you want to keep your edits.
- Close the modal with the close button, by clicking outside it, or
  by pressing Escape.
- The preview shows scrollbars when the diagram is too large to fit,
  so big diagrams stay readable at their natural size.

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
