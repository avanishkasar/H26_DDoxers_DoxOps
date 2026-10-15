# Publishing DoxOps for GitHub to Microsoft Edge Add-ons

Publishing on Edge Add-ons is free. Steps follow Microsoft's guide
(https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension).
Certification **can take up to 7 business days**, so for the demo load the extension unpacked
(see the last section) and submit in parallel.

## What to upload

| Partner Center field | File |
|---|---|
| Package (.zip, `manifest.json` at the zip root) | `doxops-edge-0.1.0.zip` (built by `npm run package`; a copy is in `/mnt/project-files/hackathon/`) |
| Extension logo (1:1, 300 x 300 recommended, 128 x 128 minimum) | `store/logo-300.png` (300 x 300, regenerate with `npm run store-logo`) |
| Screenshots (optional, up to 6, 640 x 480 or 1280 x 800) | `store/screenshot-1-scan.png`, `store/screenshot-2-capsule.png` (1280 x 800) |
| Privacy policy URL | https://github.com/avanishkasar/h26_ddoxers_doxops/blob/main/browser-extension/PRIVACY.md (the repository must be public for the URL to work) |

Build the package first:

```powershell
cd browser-extension
npm ci
npm test
npm run package   # writes doxops-edge-0.1.0.zip
```

## Step 1. Register a developer account (free)

1. Go to https://partner.microsoft.com/dashboard/microsoftedge/public/login?ref=dd and sign in
   with a Microsoft account.
2. Choose **Register as a Microsoft Edge extension developer**, pick an **Individual** or
   **Company** account, fill in the contact details (publisher display name: `Team DDoxers`)
   and accept the agreement. There is no registration fee.

## Step 2. Create the extension and upload the package

1. In Partner Center, go to **Home** > **Edge** card > **Overview** (or the Edge developer
   dashboard) and click **Create new extension**.
2. On **Upload package (.zip file)**, drag `doxops-edge-0.1.0.zip` onto
   **Drag your package here (.zip)** or click **Browse your files**.
3. Wait for validation. If it reports an error, fix it, run `npm run package` again and
   re-upload. Then click **Continue**.

## Step 3. Availability

1. **Visibility**: `Public`.
2. **Markets**: leave the default (all markets, including future markets).
3. Click **Save & Continue**.

## Step 4. Properties

1. **Category**: `Developer tools`.
2. **Website**: https://github.com/avanishkasar/h26_ddoxers_doxops
3. **Support contact detail**: https://github.com/avanishkasar/h26_ddoxers_doxops/issues
4. **Mature content**: leave unchecked.
5. Click **Save & Continue**.

## Step 5. Privacy

1. **Single purpose description**: paste the text under "Single purpose" below.
2. **Permission justification**: paste one line per permission from "Permission
   justifications" below.
3. **Are you using remote code?**: **No, I am not using remote code** (everything is bundled
   in the package; there is no `eval` and no remote script).
4. **Data usage**: select no data types (the extension collects nothing) and tick the
   certification boxes.
5. **Privacy policy URL**: the `PRIVACY.md` URL from the table above. It is only mandatory
   when an extension collects personal information, but provide it anyway; reviewers check it
   against the host permissions.
6. Click **Save & Continue**.

## Step 6. Store listing (English)

1. Open **Store listings** > **Details for English**.
2. **Extension name** and **Short description** come from `manifest.json` (change them there
   and re-upload if needed).
3. **Description**: paste the full description below (Partner Center needs 250 to 10,000
   characters).
4. **Extension logo**: `store/logo-300.png`.
5. **Screenshots**: `store/screenshot-1-scan.png`, then `store/screenshot-2-capsule.png`.
6. **Search terms**: paste the 7 terms below (at most 7 terms, 30 characters each, 21 words
   in total).
7. Small and large promotional tiles and a YouTube URL are optional; skip them.
8. Click **Save draft**. The language **Status** should show **Complete**.

## Step 7. Submit

1. In **Store listings**, click **Publish**.
2. In **Notes for certification**, paste the text under "Notes for certification" below.
3. Click **Publish** again. Status moves to **In review**; after certification (up to 7
   business days) it changes to **In the Store**.

## For the demo: load unpacked (works today, no review)

1. `cd browser-extension`, then `npm ci` and `npm run build` (output in `dist/`).
2. In Edge open `edge://extensions`, turn on **Developer mode** (left pane or bottom left).
3. Click **Load unpacked** and select the `browser-extension/dist` folder.
4. Pin the DoxOps icon from the Extensions (puzzle) menu, then open
   https://github.com/rishrek/LinkWatch. The badge appears bottom right; click the toolbar
   icon for the full list.

The same `dist/` folder loads in Chrome through `chrome://extensions` > **Developer mode** >
**Load unpacked**.

---

# Listing copy (ready to paste)

## Extension name (from manifest.json)

DoxOps for GitHub

## Short description (from manifest.json, 125 characters)

Flags at-risk Python dependencies on GitHub repository pages (observed from PyPI) and hands off to DoxOps for verified fixes.

## Description

```
DoxOps for GitHub shows which Python dependencies of a GitHub repository are at risk, right on the repository page, before you clone anything.

Open any public repository and DoxOps reads its root requirements.txt, requirements-dev.txt, pyproject.toml (PEP 621, PEP 735 dependency groups and Poetry) and setup.py, then checks every declared package against PyPI. A small badge shows how many dependencies are at risk; click it or the toolbar icon for the ranked list.

What it flags
- Packages archived, deprecated or quarantined on PyPI (PEP 792 project status)
- Pins to yanked releases and packages missing from PyPI
- Projects marked inactive or with no release for 3 or more years
- Pins one or more major versions behind the latest release
- Packages that do not support current Python (3.12 and 3.13)
- The same package declared with different constraints in different files

Every finding is labelled OBSERVED and shows its evidence and score, using the same indicators, weights and severity bands as the DoxOps command-line tool.

From warning to verified fix
- Fix in VS Code: opens the repository in VS Code; the DoxOps VS Code extension's Start panel then scans it or finds and fixes it with the project's own tests.
- Copy CLI command: copies "doxops run <repository URL>" for the DoxOps command-line tool.
- Load capsule.json: open a DoxOps result file to see each dependency's status (verified, partially verified, unverified, failed) and the proposed replacement, marked VERIFIED or AI.

Honest limits
The browser cannot install packages or run tests, so it only reports what it can observe from repository files and PyPI. Fixes are verified only by DoxOps on your machine.

Privacy
No account, no analytics, nothing collected. The extension only reads from raw.githubusercontent.com, pypi.org and api.github.com, without cookies or credentials. Results are cached in session storage and cleared when the browser closes.

Open source, by Team DDoxers.
```

## Search terms (7 terms, 11 words)

```
python dependencies
pypi
dependency risk
requirements.txt
pyproject
outdated packages
github security
```

## Single purpose

```
Shows at-risk Python dependencies of the GitHub repository being viewed, using public repository files and PyPI metadata, and links to DoxOps to fix them.
```

## Permission justifications

```
storage: caches PyPI responses (1 hour) and scan results (10 minutes) in session storage, cleared when the browser closes, to avoid repeat requests.
activeTab: lets the toolbar popup read the URL of the current tab to know which GitHub repository to scan.
Host raw.githubusercontent.com: reads the repository's requirements.txt, pyproject.toml and setup.py files.
Host pypi.org: reads public package metadata (JSON and Simple APIs) for each declared dependency.
Host api.github.com: one unauthenticated lookup, only when no manifest is found, to tell a private repository from a non-Python one.
Content script on github.com: shows the at-risk badge on repository pages.
```

## Notes for certification

```
No account or credentials are needed. To test: open https://github.com/rishrek/LinkWatch . After a few seconds a "DoxOps: N at risk" badge appears at the bottom right; click it, or click the toolbar icon, to see the list of dependencies with their evidence. "Copy CLI command" copies a command line; "Fix in VS Code" opens a vscode:// link (VS Code needs to be installed to handle it); "Load capsule.json" opens a local JSON file picker. All code is bundled in the package; there is no remote code. The extension only contacts raw.githubusercontent.com, pypi.org and api.github.com, read-only and without cookies.
```
