"""
Build a Chrome-compatible ZIP for the plantuml-for-github extension.

Why Python and not PowerShell's Compress-Archive:
  Compress-Archive on some Windows builds writes path separators as
  backslashes inside the archive, which violates the ZIP spec and can
  trip strict validators. Python's zipfile uses '/' consistently and
  lets us set arcname explicitly, so we're safe.

Chrome-specific packaging:
  The Chrome build ships the minified TeaVM-compiled engine
  (vendor/plantuml.js, ~4 MB on disk) as a single file, imported
  by renderer.js as an ES module. Graph layout is done by Smetana,
  PlantUML's built-in port of Graphviz layout, which is compiled
  into the same file, so there is no separate viz-global.js and no
  WebAssembly module. This script enforces that vendor/plantuml.js
  is present and packs only the files needed for the Chrome build.
"""

import json
import zipfile
from pathlib import Path

# This script lives at the repo root, next to the Chrome/ and Firefox/
# source directories. Source files for the Chrome build come from CHROME_DIR.
ROOT = Path(__file__).resolve().parent
CHROME_DIR = ROOT / "Chrome"

# Read version from Chrome's manifest.json so the output name stays in sync
with open(CHROME_DIR / "manifest.json", "r", encoding="utf-8") as f:
    manifest = json.load(f)
version = manifest["version"]
# Output the ZIP at the repo root, next to the Chrome/ and Firefox/ dirs.
OUT = ROOT / f"plantuml-for-github-chrome-{version}.zip"

# Exact list of files to ship, as (arcname inside ZIP -> source path).
# Listing every file explicitly avoids accidentally bundling leftover
# artifacts (e.g. *.gz, *.filtered.js) from earlier experiments.
FILES = {
    "manifest.json":         CHROME_DIR / "manifest.json",
    "content.js":            CHROME_DIR / "content.js",
    "renderer.html":         CHROME_DIR / "renderer.html",
    "renderer.js":           CHROME_DIR / "renderer.js",
    "icons/icon16.png":      CHROME_DIR / "icons" / "icon16.png",
    "icons/icon48.png":      CHROME_DIR / "icons" / "icon48.png",
    "icons/icon128.png":     CHROME_DIR / "icons" / "icon128.png",
    "vendor/plantuml.js":    CHROME_DIR / "vendor" / "plantuml.js",
}

# Standard-library bundles the engine lazy-loads for `!include <lib/...>`.
# TeaVmScriptLoader resolves `<lib>.min.js` relative to renderer.html, so
# these MUST live at the extension root (not under vendor/). Only the
# self-contained libraries small enough to ship are bundled; the heavy
# sprite collections (ibm, tupadr3, awslib*, material*, logos, office,
# osa, bootstrap*) stay out - together they would add ~90 MB.
STDLIB_BUNDLES = [
    "adaml", "archimate", "azure", "c4", "classy", "classy-c4",
    "cloudinsight", "cloudogu", "domainstory", "edgy", "eip",
    "elastic", "gcp", "k8s", "kubernetes", "osa2",
]
for lib in STDLIB_BUNDLES:
    FILES[f"{lib}.min.js"] = CHROME_DIR / f"{lib}.min.js"

# Pre-flight check: every declared file must exist.
missing = [arcname for arcname, src in FILES.items() if not src.exists()]
if missing:
    raise SystemExit(
        "ERROR: missing files:\n"
        + "\n".join(f"  - {m}" for m in missing)
    )

if OUT.exists():
    OUT.unlink()
    print(f"Removed old archive: {OUT.name}")

with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for arcname, src in FILES.items():
        zf.write(src, arcname=arcname)
        print(f"  + {arcname}")

print(f"\nCreated: {OUT}")
print(f"Size: {OUT.stat().st_size / 1024 / 1024:.2f} MB")

# Sanity check: re-open the archive and confirm no backslashes lurk in
# entry names. No per-file size cap on Chrome, so we just report sizes.
print("\nVerification - archive contents:")
with zipfile.ZipFile(OUT, "r") as zf:
    bad_slash = []
    for info in zf.infolist():
        size_mb = info.file_size / 1024 / 1024
        marker = ""
        if "\\" in info.filename:
            marker += " [BAD-SLASH]"
            bad_slash.append(info.filename)
        print(f"  {info.filename}  ({size_mb:.2f} MB){marker}")

    print()
    if bad_slash:
        print(f"*** ERROR: {len(bad_slash)} entries use backslashes ***")
    else:
        print("OK - all archive entries use forward slashes.")
