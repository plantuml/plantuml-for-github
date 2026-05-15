"""
Build a Firefox-compatible ZIP for the plantuml-for-github extension.

Why Python and not PowerShell's Compress-Archive:
  Compress-Archive on some Windows builds writes path separators as
  backslashes inside the archive, which violates the ZIP spec and is
  rejected by Mozilla's AMO validator ("Invalid file name in archive").
  Python's zipfile uses '/' consistently and lets us set arcname
  explicitly, so we're safe.

Firefox-specific packaging:
  AMO's addons-linter refuses to parse JS files larger than 5 MB. The
  TeaVM-compiled plantuml.js weighs ~24 MB and blocks submission. We
  ship the engine pre-split into 7 chunks (vendor/plantuml.0.js ...
  vendor/plantuml.6.js, produced by split_plantuml.py), each under
  4 MB. renderer.html loads them in order as classic scripts.
  This script lists every shipped file explicitly so the original
  plantuml.js is never accidentally bundled into the Firefox ZIP.
"""

import json
import zipfile
from pathlib import Path

# This script lives at the repo root, next to the Chrome/ and Firefox/
# source directories. Source files for the Firefox build come from FIREFOX_DIR.
ROOT = Path(__file__).resolve().parent
FIREFOX_DIR = ROOT / "Firefox"

# Read version from Firefox's manifest.json so the output name stays in sync
with open(FIREFOX_DIR / "manifest.json", "r", encoding="utf-8") as f:
    manifest = json.load(f)
version = manifest["version"]
# Output the ZIP at the repo root, next to the Chrome/ and Firefox/ dirs.
# Historical name (no "-firefox-" suffix) because this is the artifact
# already published on AMO.
OUT = ROOT / f"plantuml-for-github-firefox-{version}.zip"

# Exact list of files to ship, as (arcname inside ZIP -> source path).
# Listing every file explicitly guarantees we never accidentally bundle
# the monolithic vendor/plantuml.js (which would fail AMO's 5 MB linter
# limit) or leftover artifacts (*.gz, *.filtered.js) from earlier
# experiments. We ship the 7 chunks plantuml.0.js ... plantuml.6.js
# instead, produced by split_plantuml.py.
FILES = {
    "manifest.json":         FIREFOX_DIR / "manifest.json",
    "content.js":            FIREFOX_DIR / "content.js",
    "renderer.html":         FIREFOX_DIR / "renderer.html",
    "renderer.js":           FIREFOX_DIR / "renderer.js",
    "icons/icon16.png":      FIREFOX_DIR / "icons" / "icon16.png",
    "icons/icon48.png":      FIREFOX_DIR / "icons" / "icon48.png",
    "icons/icon128.png":     FIREFOX_DIR / "icons" / "icon128.png",
    "vendor/plantuml.0.js":  FIREFOX_DIR / "vendor" / "plantuml.0.js",
    "vendor/plantuml.1.js":  FIREFOX_DIR / "vendor" / "plantuml.1.js",
    "vendor/plantuml.2.js":  FIREFOX_DIR / "vendor" / "plantuml.2.js",
    "vendor/plantuml.3.js":  FIREFOX_DIR / "vendor" / "plantuml.3.js",
    "vendor/plantuml.4.js":  FIREFOX_DIR / "vendor" / "plantuml.4.js",
    "vendor/plantuml.5.js":  FIREFOX_DIR / "vendor" / "plantuml.5.js",
    "vendor/plantuml.6.js":  FIREFOX_DIR / "vendor" / "plantuml.6.js",
    "vendor/viz-global.js":  FIREFOX_DIR / "vendor" / "viz-global.js",
}

# Pre-flight check: every declared file must exist.
# If a chunk is missing, run `python split_plantuml.py` to regenerate them.
missing = [arcname for arcname, src in FILES.items() if not src.exists()]
if missing:
    raise SystemExit(
        "ERROR: missing files:\n"
        + "\n".join(f"  - {m}" for m in missing)
        + "\n  If chunks are missing, run `python split_plantuml.py` first."
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

# Sanity check: re-open the archive and confirm no backslashes and no
# oversized files lurking around.
print("\nVerification - archive contents:")
with zipfile.ZipFile(OUT, "r") as zf:
    bad_slash = []
    too_large = []
    LINTER_LIMIT = 5 * 1024 * 1024
    for info in zf.infolist():
        size_mb = info.file_size / 1024 / 1024
        marker = ""
        if "\\" in info.filename:
            marker += " [BAD-SLASH]"
            bad_slash.append(info.filename)
        # Only flag uncompressed JS files over the linter limit.
        if info.filename.endswith(".js") and info.file_size >= LINTER_LIMIT:
            marker += " [TOO-LARGE-FOR-AMO]"
            too_large.append(info.filename)
        print(f"  {info.filename}  ({size_mb:.2f} MB){marker}")

    print()
    if bad_slash:
        print(f"*** ERROR: {len(bad_slash)} entries use backslashes ***")
    if too_large:
        print(f"*** ERROR: {len(too_large)} JS files exceed AMO's 5 MB limit ***")
    if not bad_slash and not too_large:
        print("OK - paths use forward slashes, no JS file exceeds 5 MB.")
