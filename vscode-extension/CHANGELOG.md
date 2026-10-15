# Changelog

## 0.1.0 (2026-10-15)

First release, built for Hacktoberfest Hack Day Mumbai (Track 1: Gemma 4).

- Commands: Scan Workspace, Run with Gemma 4 (cancellable, streamed to the DoxOps output channel), Load Results Folder, Open Report (sandboxed webview, or in the browser), Apply Verified Fix, Apply All Verified Fixes, Show Capsule, Doctor, Set Gemini API Key.
- DoxOps activity bar view: dependencies ranked by risk with indicators, usage sites, proposed replacement, attempts and executed test results, each labelled OBSERVED, VERIFIED or AI.
- Diagnostics on manifest declarations and usage sites, with quick fixes to apply a verified patch or show the capsule.
- Status bar summary of at-risk and verified dependencies.
- Patches are applied with `git apply` only after `git apply --check` passes and a confirmation that shows status and provenance.
