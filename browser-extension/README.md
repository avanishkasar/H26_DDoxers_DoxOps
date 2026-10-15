# DoxOps for GitHub (browser extension for Edge and Chrome)

Flags at-risk Python dependencies on any public GitHub repository page and hands off to
DoxOps (CLI or VS Code extension) for the verified fix.

By Team DDoxers. Manifest V3, TypeScript (strict), no runtime dependencies, no remote code.
The same build runs in Microsoft Edge and Google Chrome (both Chromium, both Manifest V3);
the manifest uses no browser-specific keys beyond `minimum_chrome_version`, which Edge honours.

## What it does

- On a repository page (`https://github.com/<owner>/<repo>/...`), it reads the root
  `requirements.txt`, `requirements-dev.txt`, `pyproject.toml` (PEP 621, PEP 735 dependency
  groups, Poetry) and `setup.py` (`install_requires`, best effort) from
  `raw.githubusercontent.com`, at the branch/tag in the URL or the default branch.
- For each declared package it reads PyPI metadata (JSON API plus the Simple API's PEP 792
  project status) and scores it with the same indicator codes, weights and severity bands as
  the DoxOps CLI (`doxops/src/doxops/risk.py`):

  | Indicator | Weight | Source |
  |---|---|---|
  | `INDEX_STATUS` (archived / deprecated / quarantined, PEP 792) | 35 | PyPI Simple API |
  | `YANKED_PIN` | 30 | PyPI |
  | `NOT_ON_INDEX` (404 on PyPI) | 30 | PyPI |
  | `INACTIVE_CLASSIFIER` | 25 | PyPI |
  | `STALE_PROJECT` (no release for 3 / 5+ years) | 15 / 25 | PyPI |
  | `DEPRECATION_NOTICE` | 20 | PyPI summary/description |
  | `OUTDATED_PIN` (same major / 1 behind / 2+ behind) | 5 / 15 / 20 | PyPI |
  | `PYTHON_UNSUPPORTED` (for Python 3.12 / 3.13, the CLI defaults) | 20 | PyPI |
  | `PYTHON_CLASSIFIERS_OLD` | 5 | PyPI |
  | `MANIFEST_DRIFT` (different constraints in different files) | 15 | repository |
  | `DUPLICATE_DECLARATION` (browser only: same file twice) | 10 | repository |

  Severity: 60+ critical, 40+ high, 20+ medium (at risk), 1+ low.
- A small badge (bottom-right, closed Shadow DOM) shows `DoxOps: N at risk`, coloured by the
  worst severity; click it for the ranked list. No badge on non-repository pages, private
  repositories or repositories without Python manifests.
- The toolbar popup shows the full list and three hand-offs:
  - **Fix in VS Code**: opens `vscode://vscode.git/clone?url=...`, so VS Code's built-in Git
    extension clones and opens the repository. With the DoxOps VS Code extension installed
    (`doxops-0.2.0.vsix`, see `../vscode-extension`), its **Start** panel in the DoxOps
    activity bar then offers **Find problems (scan, no AI)** or **Find and fix with Gemma 4**,
    with fixes verified by the project's own tests. The browser does not start the scan itself.
  - **Copy CLI command**: `doxops run https://github.com/<owner>/<repo>`.
  - **Load capsule.json**: open a `capsule.json` produced by DoxOps for this repository to
    see each dependency's status (verified, partially-verified, unverified, failed,
    not-attempted) and the proposed replacement with its provenance (VERIFIED or AI).

## The honest limit

Everything the browser shows is **OBSERVED**: read from repository files and PyPI. It cannot
install packages, import them or run tests, so these CLI indicators are not available here:
`IMPORT_FAILS`, `IMPORT_DEPRECATED`, `TESTS_FAIL`, `RUNTIME_DEPRECATION`, `CONFLICT`,
`TOOL_BROKEN` (need execution) and `UNDECLARED`, `UNUSED`, `PRIVATE_API`, `MONKEYPATCH`,
`NO_TIMEOUT`, `MISSING` (need a scan of every source file). Browser scores are therefore lower
than the CLI's for the same repository. Fixes are verified only by the DoxOps CLI or the VS
Code extension, with the project's own tests.

Other limits: only root-level manifests are read; `setup.cfg`, `Pipfile` and nested
requirement files are not; refs containing `/` fall back to the default branch; at most 150
packages are looked up per repository.

## Install (load unpacked)

Build it first (below), or unzip `doxops-edge-0.1.0.zip` into a folder.

**Microsoft Edge**

1. Open `edge://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select `browser-extension/dist` (or the unzipped folder).
3. Pin the DoxOps icon from the Extensions (puzzle) menu.

**Google Chrome**

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select `browser-extension/dist` (or the unzipped folder).

Then open any GitHub repository, for example https://github.com/rishrek/LinkWatch.

**Edge Add-ons store**: the listing is being submitted through Partner Center (free;
certification takes up to 7 business days). Steps, listing copy and store assets are in
[EDGE-PUBLISH.md](EDGE-PUBLISH.md) and `store/`; the privacy policy is [PRIVACY.md](PRIVACY.md).

## Build (PowerShell)

```powershell
cd browser-extension
npm ci
npm run build      # type-check + bundle into dist/
npm test           # node:test suite on the pure logic
npm run package    # build + doxops-edge-0.1.0.zip (manifest.json at the zip root)
npm run store-logo # store/logo-300.png for Partner Center
```

The same commands work in bash. Node 22 or newer is required.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Caches PyPI results (1 hour) and scan results (10 minutes) in `chrome.storage.session` (the same API in Edge), which is cleared when the browser closes. |
| `activeTab` | Lets the popup read the URL of the tab you clicked it on, to know which repository to scan. |
| `https://raw.githubusercontent.com/*` | Reads the repository's manifest files. |
| `https://pypi.org/*` | Reads package metadata from the JSON and Simple APIs. |
| `https://api.github.com/*` | One unauthenticated call, only when no manifest is found, to tell a private repository from a non-Python one. |
| Content script on `https://github.com/*` | Shows the badge on repository pages. |

## Privacy

The extension contacts only `raw.githubusercontent.com`, `pypi.org` and `api.github.com`,
without cookies or credentials, and only for the public repository you are viewing. Nothing is
sent anywhere else, there is no analytics, and nothing leaves your machine except those reads.
A `capsule.json` you load is read locally in the popup and never uploaded. Full policy:
[PRIVACY.md](PRIVACY.md).

## Layout

```
src/core/        pure logic, no chrome.* APIs (tested with node:test)
  repo.ts          GitHub URL detection
  requirements.ts  PEP 508 / requirements.txt parsing, PEP 503 names
  toml.ts          minimal tolerant TOML reader
  manifests.ts     pyproject (PEP 621, Poetry), setup.py, drift
  pypi.ts          PyPI client (10 s timeout, 6 concurrent, retry on 429/5xx, 1 h cache)
  github.ts        raw file fetch, private / non-Python detection
  risk.ts          OBSERVED-only port of the CLI's risk.py
  capsule.ts       capsule.json validation
src/background/  service worker (message handling, dedupe, session cache)
src/popup/       toolbar popup
src/content/     in-page badge
src/ui/          shared DOM rendering and styles (createElement/textContent only)
test/            unit tests and fixtures (LinkWatch manifests, trimmed capsule.json)
scripts/         icons, store logo and zip packaging (node:zlib only)
store/           Partner Center logo (300x300) and screenshots (1280x800)
```
