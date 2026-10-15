# DoxOps dashboard: UI brief for a coding agent

You are redesigning `doxops/src/doxops/web/index.html`, the page served by `doxops serve`.
The Python server (`doxops/src/doxops/server.py`) and its API are fixed. Change only files in this folder.

## What the page is for

DoxOps finds at-risk Python dependencies in a repository, asks Gemma 4 for a replacement plan, then
verifies the plan by actually running the project's tests. The dashboard is shown to hackathon judges
standing next to a laptop. Optimise for that:

- Big and readable from a metre away: body text at least 17px, key numbers at least 36px.
- Dark theme with high contrast (WCAG AA or better). Colour is never the only signal: always add text.
- One screen tells the story: input -> live log -> counts -> table of dependencies -> links to evidence.
- Two primary actions: **Find problems** (`mode: "scan"`, no AI) and **Find and fix with Gemma 4** (`mode: "run"`).

## Labelling rule (mandatory)

Every fact in `capsule.json` carries `provenance`: `observed`, `verified` or `ai`.

- Show a visible text badge next to each fact: `OBSERVED`, `VERIFIED` or `AI`.
- `ai` must always be visibly labelled **AI**. Never show AI text as verified, never hide the badge,
  never style AI output like verified output. Unknown or missing provenance is shown as `AI`.
- Capsule `status` (`verified`, `partially-verified`, `unverified`, `failed`, `not-attempted`) is shown as
  text exactly as given; do not upgrade it.

## API contract (unchanged; same origin only)

All responses are JSON unless noted. Errors are `{"error": "message"}` with a 4xx status.
POST requests must send `Content-Type: application/json` (the browser adds a same-origin `Origin`).

`GET /api/health`

```json
{"version": "0.1.0", "busy": false,
 "defaults": {"provider": "ollama", "models": {"ollama": "gemma4:e4b", "gemini": "gemma-4-26b-a4b-it"},
              "pythons": ["3.12", "3.13"]}}
```

`POST /api/runs` with body

```json
{"target": "https://github.com/rishrek/LinkWatch", "mode": "run", "provider": "ollama",
 "model": null, "pythons": ["3.12", "3.13"], "max_deps": null}
```

- `target`: `https://github.com/owner/repo` or an existing absolute folder path (required).
- `mode`: `"scan"` or `"run"`; `provider`: `"ollama"` or `"gemini"` (used by `run` only).
- `model`: string or null; `pythons`: 1 to 6 strings like `"3.12"`; `max_deps`: null or 1..100.
- Responses: `202 {"id": "3f9c1a2b4d5e"}`, `400` invalid field, `409` another run is active.

`GET /api/runs` -> `{"runs": [Run, ...]}` newest first, where `Run` is

```json
{"id": "3f9c1a2b4d5e", "target": "...", "mode": "run", "provider": "ollama", "model": null,
 "pythons": ["3.12", "3.13"], "max_deps": null, "status": "running",
 "created": "2026-10-15T10:00:00Z", "started": "2026-10-15T10:00:00Z", "finished": null, "exit_code": null,
 "summary": {"dependencies": 14, "at_risk": 5, "capsules": 5, "verified": 3, "partially_verified": 1,
             "unverified": 1, "not_attempted": 0}}
```

`status` is one of `queued`, `running`, `done`, `failed`, `cancelled`. `summary` is null until
`capsule.json` exists.

`GET /api/runs/<id>` -> `Run` plus `"files": ["report.html", "REPORT.md", "capsule.json", "web.log",
"patches/combined.patch", "capsules/jinja2.md", ...]` and `"log": [last 200 log lines]`. Poll every 2 s
while the status is `queued` or `running`.

`POST /api/runs/<id>/cancel` with body `{}` -> `200 {"id": "...", "status": "..."}`, `409` if not active.

`GET /api/runs/<id>/capsule.json` and `GET /api/runs/<id>/files/<path>` serve run files
(`report.html`, `REPORT.md`, `capsule.json`, `web.log`, `capsules/*.md|json`, `patches/*.patch`,
`evidence/*.log`). Open them in a new tab (`target="_blank" rel="noopener noreferrer"`); encode each
path segment with `encodeURIComponent`.

## capsule.json fields to display

- `risks[]`: `name`, `score` (0-100), `severity` (`none|low|medium|high|critical`), `at_risk` (bool),
  `indicators[]` with `code`, `title`, `detail`, `weight`, `provenance`, `evidence_ids`.
  Top indicator = highest `weight`.
- `capsules[]` (one per dependency DoxOps tried to migrate): `dependency`, `status`,
  `proposed_replacement` (`{text, provenance}`, may be null), `rationale`, `analysis`
  (`{text, provenance}`, usually `ai`), `migration_steps[]`, `open_concerns[]`, `compatibility_gaps[]`,
  `executed_results[]` (per Python: `fixed`, `regressed`, `still_failing`, `still_passing`).
- `combined_comparisons[]`: per Python, the same counts for all migrations applied together.
- `target.source`, `target.commit`, `model.provider`, `model.model`, `limitations[]`.

Table columns: dependency, score, severity, status, top indicator (badge + title),
proposed replacement (badge + text). Counts: at risk, verified, partially verified, unverified.

## Constraints

- A single static `index.html`, optionally with `.css` / `.js` files in this same folder, loaded as
  `/static/<file>`. No build step, no npm, no frameworks, no CDN, no web fonts: it must work offline.
- Build the DOM with `textContent` / `createElement` only. Never use `innerHTML`, `outerHTML`,
  `insertAdjacentHTML` or `document.write` with any data from the API or the repository.
- Keep the API and its field names unchanged; do not add CORS, cookies or third-party requests.
- Keep both buttons, the cancel button, the log panel and the error line working.
- Phone width still usable (no horizontal page scroll; the table may scroll inside its container).

## Acceptance checklist

- [ ] `doxops serve` opens the page; it loads with no console errors and no network requests to other hosts.
- [ ] Empty target shows a readable error; an invalid target shows the server's `error` text.
- [ ] Find problems and Find and fix both start a run; the log updates every 2 s; buttons disable while active.
- [ ] Cancel stops an active run and the status becomes `cancelled`.
- [ ] When the run finishes: four counts, the dependency table, links to the full report and patches.
- [ ] Every fact shown has an OBSERVED / VERIFIED / AI badge; AI is never presented as verified.
- [ ] Reloading the page reattaches to the latest run.
- [ ] `grep -n innerHTML doxops/src/doxops/web/*` finds nothing that touches data.
- [ ] `cd doxops && .venv/bin/python -m pytest -q tests/test_server.py` still passes.
