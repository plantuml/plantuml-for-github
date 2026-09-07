"""
fetch_stdlib.py -- refresh the vendored stdlib bundles from the project site.

The extension ships the self-contained stdlib bundles (see STDLIB_BUNDLES)
as byte-for-byte copies of the published files at
https://plantuml.github.io/plantuml/js-plantuml/. They go stale whenever the
site republishes (a library version bump upstream), so refreshing them is
part of preparing a release: run this script, review the reported changes,
and commit.

Every bundle is written to BOTH Chrome/ and Firefox/ at the directory root:
the engine resolves `<lib>.min.js` relative to renderer.html, so the files
cannot live under vendor/. Identical content at two paths costs one blob in
git.

The bundle list appears in three places that must stay in sync:
this script, build_zip_chrome.py and build_zip_firefox.py (STDLIB_BUNDLES
in each), plus the web_accessible_resources list in template/manifest.json.
"""

import sys
import urllib.request
from pathlib import Path

BASE_URL = "https://plantuml.github.io/plantuml/js-plantuml/"

# Self-contained libraries small enough to ship; the heavy sprite
# collections (ibm, tupadr3, awslib*, material*, logos, office, osa,
# bootstrap*) stay out -- together they would add ~90 MB.
STDLIB_BUNDLES = [
    "adaml", "archimate", "azure", "c4", "classy", "classy-c4",
    "cloudinsight", "cloudogu", "domainstory", "edgy", "eip",
    "elastic", "gcp", "k8s", "kubernetes", "osa2",
]

ROOT = Path(__file__).resolve().parent
TARGET_DIRS = [ROOT / "Chrome", ROOT / "Firefox"]


def main() -> int:
    changed = 0
    for lib in STDLIB_BUNDLES:
        name = f"{lib}.min.js"
        url = BASE_URL + name
        try:
            with urllib.request.urlopen(url) as resp:
                fresh = resp.read()
        except Exception as e:
            print(f"ERROR  {name}: {e}")
            return 1

        current = TARGET_DIRS[0] / name
        if current.exists() and current.read_bytes() == fresh:
            print(f"same     {name}  ({len(fresh) / 1024:.0f} KB)")
            continue

        status = "updated" if current.exists() else "NEW"
        for d in TARGET_DIRS:
            (d / name).write_bytes(fresh)
        print(f"{status:8s} {name}  ({len(fresh) / 1024:.0f} KB)")
        changed += 1

    print(f"\n{changed} bundle(s) changed." if changed else "\nAll bundles already current.")
    if changed:
        print("Review with `git diff --stat`, then commit both Chrome/ and Firefox/ copies.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
