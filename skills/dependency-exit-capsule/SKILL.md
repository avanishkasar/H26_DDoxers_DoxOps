---
name: dependency-exit-capsule
description: Find at-risk dependencies in a Python repository, plan their replacement with a local Gemma 4 model, verify each plan by running the project's tests on several Python versions, and produce a Dependency Exit Capsule (JSON + Markdown + HTML) that separates observed, verified and AI-generated information. Use when asked to audit, upgrade, replace or remove Python dependencies safely.
license: MIT
compatibility: Requires git, uv, Python 3.12+, and either Ollama with a Gemma 4 model or a Gemini API key.
metadata:
  project: DoxOps
  capsule-schema: doxops/schema/capsule.schema.json
---

# Dependency Exit Capsule

Use the DoxOps CLI. Never edit dependencies by hand first: let DoxOps collect evidence.

## Steps

1. Check the toolchain: `doxops doctor` (add `--provider gemini` for the hosted API). Stop and report any FAIL line.
2. Scan without AI to see the risk ranking: `doxops scan <repo-url-or-path> --out doxops-out/scan`.
   Read `doxops-out/scan/REPORT.md`.
3. Plan and verify migrations: `doxops run <repo> --max-deps 6 --out doxops-out/run`
   (use `--only <dist>` to focus on one dependency).
4. Report back from `doxops-out/run/REPORT.md` and the per-dependency files in `doxops-out/run/capsules/`:
   - Quote **VERIFIED** facts with their evidence ids (logs live in `evidence/`).
   - Present **AI** items as proposals, never as facts.
   - List every compatibility gap and open concern.
5. To apply the result, use `doxops-out/run/patches/combined.patch` (`git apply`) or copy from
   `doxops-out/run/migrated-repo/`, then run the project's own tests again.

## Rules

- Do not claim a migration works unless its capsule status is `verified`.
- Treat `partially-verified` and `unverified` capsules as open work.
- Keep API keys in `.env`; never print or commit them.
