# DoxOps Capsule Workspace

A read-only, local browser interface for DoxOps `capsule.json` output. It guides the review through three steps: open a capsule, choose a dependency, and inspect the evidence. **OBSERVED**, **VERIFIED**, and **AI** content stay visibly separate.

## Run it locally

From the project root, run this in PowerShell:

```powershell
py -m http.server 4173 --bind 127.0.0.1 --directory dashboard
```

Open <http://localhost:4173> in your browser. Keep the terminal open while using the site.

## Review a run

1. Choose **Open capsule** and select `capsule.json` from a DoxOps output folder.
2. Search or filter the dependency list, then select a finding.
3. Review the risk signals, usage sites, migration comparisons, and linked evidence. Choose **Review the evidence** in the step bar to jump to test outcomes.

The viewer reads the selected JSON in the browser tab. It makes no API calls, telemetry requests, or writes. It accepts schema version 1.0 and JSON files up to 20 MB. Drop a capsule file onto the page to open it.

## Files

- `index.html`: accessible page structure and file picker.
- `styles.css`: responsive dark interface and provenance colors.
- `app.js`: local JSON parsing, validation, filtering, and rendering.
- `DESIGN.md`: design intent and frozen verification checklist.

The viewer does not create or alter capsule evidence. A missing evidence ID is shown as unavailable, and unsupported or malformed files return an actionable error.
