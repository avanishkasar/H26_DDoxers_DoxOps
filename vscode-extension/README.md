# DoxOps for VS Code

Find and fix at-risk Python dependencies without leaving the editor. The extension drives the
[DoxOps](https://github.com/avanishkasar/H26_DDoxers_DoxOps) CLI: it scans your workspace, asks
Gemma 4 for a migration plan per at-risk dependency, and shows only the fixes DoxOps proved by
running your tests.

## What it does

- **Start panel** in the DoxOps sidebar: paste a GitHub URL (`https://github.com/rishrek/LinkWatch`) or a folder path,
  or leave it empty for the open folder, then click **Find problems** (scan, no AI) or **Find and fix with Gemma 4**.
  GitHub repositories are cloned into the extension's own storage first. The panel also holds the provider, model,
  Python versions and CLI path, and shows the results: counts, the combined test result, and every at-risk dependency
  with its reason and replacement labelled OBSERVED, VERIFIED or AI, plus **Details** and **Apply fix** links.
- **DoxOps view** in the activity bar: every dependency ranked by risk score, with its indicators,
  usage sites (click to jump to the line), proposed replacement, every migration attempt
  (accepted or rejected, with the verdict) and the executed test results per Python version.
- **Diagnostics** on the line that declares each at-risk dependency (`requirements*.txt`,
  `pyproject.toml`, `setup.py`, `Pipfile`) and on each usage site, for example
  `DoxOps: jinja2 at risk (score 85): import jinja2 fails on Python 3.12, 3.13 [VERIFIED]`.
- **Quick fixes** on those diagnostics: *apply verified fix* and *show capsule*.
- **Apply Verified Fix** runs `git apply --check` first, then shows the dependency, the chosen
  replacement, its status and its provenance labels in a modal before `git apply`. Only
  `verified` and `partially-verified` capsules can be applied; partially verified ones show an
  extra warning listing the open concerns.
  A patch that is already in the tree is reported as already applied and never applied twice.
- **Apply All** applies `patches/combined.patch` the same way. It is offered only when the
  combined test run regressed nothing and `patches/combined-conflicts.txt` does not exist.
- **Open Report** shows `report.html` in a sandboxed webview (scripts off, strict
  Content-Security-Policy), or in your browser.
- **Status bar**: `DoxOps: N at risk · M verified`, click to open the report.

## Commands

| Command | What it runs |
|---|---|
| DoxOps: Scan Workspace (no AI) | `doxops scan <folder> --out <dir> --python ...` |
| DoxOps: Run with Gemma 4 (plan + verify) | `doxops run <folder> --out <dir> --provider ... [--model ...] --python ... [--max-deps N]` |
| DoxOps: Load Results Folder... | Opens an existing DoxOps output folder (one that contains `capsule.json`) |
| DoxOps: Open Report / Open Report in Browser | `report.html` of the loaded results |
| DoxOps: Apply Verified Fix... / Apply All Verified Fixes | `git apply --check`, confirm, `git apply` |
| DoxOps: Show Capsule | Reveals the dependency and opens `capsules/<dist>.md` |
| DoxOps: Doctor | `doxops doctor` |
| DoxOps: Set Gemini API Key | Stores the key in VS Code SecretStorage |
| DoxOps: Show Output | The `DoxOps` output channel with the streamed CLI output |

Runs are cancellable from the progress notification; the CLI and everything it started (uv,
pytest) are stopped and the run's partial output folder is deleted. Only one run happens at a time.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `doxops.executable` | `""` | Path to the CLI. Empty: `doxops` on `PATH`, then `doxops/.venv` and `.venv` in the workspace folder (`Scripts\doxops.exe` on Windows, `bin/doxops` elsewhere). |
| `doxops.provider` | `ollama` | `ollama` (local Gemma 4) or `gemini` (hosted Gemma 4). |
| `doxops.model` | `""` | Model id; empty uses the CLI default (`gemma4:e4b` / `gemma-4-26b-a4b-it`). |
| `doxops.pythons` | `["3.12", "3.13"]` | Python versions to verify on. |
| `doxops.maxDeps` | `0` | Migrate at most N highest-risk dependencies; `0` means all. |
| `doxops.outputDirectory` | `""` | Where runs are written (one timestamped subfolder each). Empty: the extension's private storage, so nothing is written into your workspace. Inside the workspace it must be under `doxops-out` or `.doxops`, the folders the CLI does not copy. |
| `doxops.ollamaHost` | `""` | Passed as `OLLAMA_HOST` when set. |

The Gemini API key comes from the `GEMINI_API_KEY` environment variable or from
**DoxOps: Set Gemini API Key** (VS Code SecretStorage). It is passed only to the CLI process and
never written to the output channel.

## How AI output stays labelled

DoxOps labels every statement **OBSERVED** (read from files or PyPI), **VERIFIED** (proven by a
command DoxOps executed, with evidence ids such as `E020`) or **AI** (model output not yet
proven). The extension keeps those labels everywhere it shows a fact: tree descriptions,
tooltips, diagnostics and the apply confirmation. A model suggestion is never offered as a fix on
its own; the Apply commands only use patches whose attempt DoxOps accepted after the tests ran,
and rejected attempts stay visible with their verdict.

## Install

Requires VS Code 1.90 or later, the DoxOps CLI (`pip install -e ./doxops` from the repository,
or `uv pip install -e ./doxops`), git, and for `Run with Gemma 4` either Ollama with a Gemma 4
model or a Gemini API key.

```powershell
code --install-extension doxops-0.2.0.vsix
```

The extension only runs in trusted workspaces, because DoxOps installs your dependencies and
runs your test suite.

## Build from source (PowerShell)

```powershell
Set-Location vscode-extension
npm ci
npm test            # compiles with tsc and runs the unit tests (node:test)
npm run package     # writes doxops-0.2.0.vsix
```

`npm run watch` recompiles on change; press F5 in VS Code with this folder open to start an
Extension Development Host.

## License

MIT, Team DDoxers.
