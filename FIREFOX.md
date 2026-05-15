# Building the Firefox Version

This document explains how to build the Firefox-compatible ZIP of
`plantuml-for-github` and submit it to Mozilla AMO (addons.mozilla.org).

The Firefox build is maintained in a separate directory from the
Chrome build because it requires non-trivial transformations of the
PlantUML engine bundle (see "Why the chunked engine?" below). Keeping
the two builds in separate directories means a Chrome update never
risks triggering a Firefox-specific re-review and vice versa, and each
store's submission stays simple.

## Prerequisites

- **Python 3.8+** (only the standard library is used).
- The TeaVM-compiled `vendor/plantuml.js` source file present at the
  repository root.
- A Mozilla Account with two-factor authentication enabled, registered
  on https://addons.mozilla.org/developers/ .

## Why the chunked engine?

Mozilla's AMO linter (`addons-linter`) refuses to parse JavaScript
files larger than 5 MB. Our TeaVM-compiled `vendor/plantuml.js` weighs
about 24 MB (non-minified, kept readable for AMO reviewers), so a
naive submission is rejected at upload time with the error
`File is too large to parse`.

Three workarounds that do NOT work and should not be retried:

1. **Hosting the engine on a remote server and fetching it at runtime**
   is forbidden by Mozilla's "Remotely Hosted Code" policy. Add-ons
   that load executable code from the network are rejected.
2. **Decompressing a gzipped bundle at runtime and `import()`-ing a
   blob URL** is blocked by Manifest V3's CSP rules: Firefox does not
   allow `blob:` in `script-src` for extension pages, and Mozilla has
   explicitly stated they will not relax this.
3. **Asking TeaVM to emit multiple smaller files** is not supported.
   TeaVM produces a single output file regardless of options.

The working approach: pre-split the engine into N classic `<script>`
chunks, each well under 5 MB. The chunks are loaded in order by
`renderer.html`. Top-level `let` and `const` declarations are rewritten
to `var` so all chunks share the same global scope. The original
`export { ... }` is replaced by a `window.__plantuml = { ... }`
assignment so `renderer.js` can pick the API up synchronously.

## Build steps

All commands are run from the repository root.

### 1. Split the engine

```powershell
python split_plantuml.py
```

This reads `vendor/plantuml.js` and produces seven files in the same
directory: `plantuml.0.js` through `plantuml.6.js`, each about 3.9 MB.
The script reports the size of every chunk and warns if any exceeds
the 4 MB target.

You only need to re-run this after `vendor/plantuml.js` itself has
been regenerated (typically after a PlantUML engine update).

### 2. Verify locally

Before packaging, sanity-check that the chunked engine actually runs:

1. Open Firefox.
2. Navigate to `about:debugging#/runtime/this-firefox`.
3. Click **"Load Temporary Add-on..."** and select `manifest.json`
   from the repository root.
4. Open any GitHub page containing a `plantuml` code block (e.g. the
   project's own README).
5. Confirm the diagram renders.

If the page console shows `PlantUML engine did not load:
window.__plantuml.render is missing`, one of the chunks failed to
parse. Re-run `split_plantuml.py` and inspect the offending chunk
manually.

### 3. Build the ZIP

```powershell
python build_zip.py
```

This writes `plantuml-for-github-<version>.zip` at the repository
root, where `<version>` is read from `manifest.json`. The script:

- Includes only the files needed at runtime (`manifest.json`,
  `content.js`, `renderer.html`, `renderer.js`, `LICENSE`, the icons,
  the seven engine chunks, and `viz-global.js`).
- Explicitly excludes `vendor/plantuml.js` (the unchunked original),
  `vendor/plantuml.js.gz` (a leftover from earlier experiments), and
  `vendor/plantuml.filtered.js` (an analysis artifact).
- Uses forward slashes in all archive paths (PowerShell's
  `Compress-Archive` writes backslashes on some Windows builds, which
  AMO rejects with `Invalid file name in archive`).
- Refuses to write the archive if any of the seven chunks is missing
  or if any included JS file exceeds 5 MB.

A successful run ends with
`OK - paths use forward slashes, no JS file exceeds 5 MB.`

### 4. Submit to AMO

1. Sign in at https://addons.mozilla.org/developers/ .
2. Click **"Submit a New Add-on"** (or the equivalent for an update).
3. On the distribution page, keep **"On this site"** selected (listed
   distribution; AMO hosts the public catalog entry and handles
   updates).
4. On the upload page, select `plantuml-for-github-<version>.zip`.
5. Answer **No** to "Is this add-on compatible with Firefox for
   Android?" unless you have actively tested it on mobile.
6. Wait for the automated validation to complete. Warnings about
   `innerHTML` and an `eslint-plugin-no-unsanitized` error in
   `viz-global.js` are expected and harmless (see "Known validator
   warnings" below).
7. Continue to the metadata page and fill in the description,
   categories, tags, screenshots, support URL, and homepage.

### 5. Source code submission

Because the engine is generated code, AMO will ask for a "source code
package" so a reviewer can reproduce the build. Submit a ZIP
containing the entire repository at the tagged commit, including:

- The Java source of the PlantUML project (or a link to its tag).
- The TeaVM configuration used to produce `vendor/plantuml.js`.
- `split_plantuml.py` and `build_zip.py` from this repository.
- A `BUILD.md` or this `FIREFOX.md` file with the exact commands.

A reviewer should be able to run `python split_plantuml.py` followed
by `python build_zip.py` on a fresh checkout and end up with a byte-
for-byte identical ZIP (modulo timestamps).

## Known validator warnings

The AMO automated linter reports five warnings on every build. All
are benign and should not block review:

- **`Unsafe assignment to innerHTML` (x3 in `content.js`)** —
  the assignments use static SVG icon strings and constant empty
  strings, never user-controlled data.
- **`Error in no-unsanitized: Unexpected Callee` in
  `vendor/viz-global.js`** — an internal linter bug triggered by
  minified code patterns it does not recognize; reported upstream by
  others.
- **`Manifest key not supported by the specified minimum Firefox for
  Android version`** — cosmetic. The extension is desktop-only and
  does not declare `gecko_android`; the linter still cross-checks
  `data_collection_permissions` (Android 142+) against
  `gecko.strict_min_version` (140) and emits this warning.

These can be mentioned in the source code submission's "approval
note" to save the reviewer time.

## Files involved in the Firefox build

| File | Role |
|---|---|
| `manifest.json` | Adds `browser_specific_settings.gecko` for Firefox |
| `renderer.html` | Loads the seven engine chunks before `renderer.js` |
| `renderer.js` | Reads the API from `window.__plantuml` synchronously |
| `vendor/plantuml.0.js` ... `plantuml.6.js` | The pre-split engine |
| `split_plantuml.py` | Produces the chunks from `vendor/plantuml.js` |
| `build_zip.py` | Packages the extension into a Firefox-ready ZIP |
| `FIREFOX.md` | This file |

The Chrome build, in its own directory, uses the unchunked
`vendor/plantuml.js` directly and does not need any of the above
machinery.
