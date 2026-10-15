# Changelog

## 0.2.0 (2026-10-15)

- New **Start** panel in the DoxOps sidebar: paste a GitHub URL or a folder path (or leave it empty for the open folder), then **Find problems** or **Find and fix with Gemma 4**. GitHub repositories are cloned into the extension's storage first.
- Model provider, model id, Python versions and the CLI path can be set from the panel.
- Results summary in the panel: at-risk, verified, partially verified and unverified counts, the combined test result, and each at-risk dependency with its reason and replacement labelled OBSERVED, VERIFIED or AI, with Details and Apply fix links.
- Results for a cloned repository reopen automatically when you open it in a new window.
- Commands: Find Problems in a GitHub Repository or Folder, Find and Fix a GitHub Repository or Folder with Gemma 4.

## 0.1.0 (2026-10-15)

First release, built for Hacktoberfest Hack Day Mumbai (Track 1: Gemma 4).

- Commands: Scan Workspace, Run with Gemma 4 (cancellable, streamed to the DoxOps output channel), Load Results Folder, Open Report (sandboxed webview, or in the browser), Apply Verified Fix, Apply All Verified Fixes, Show Capsule, Doctor, Set Gemini API Key.
- DoxOps activity bar view: dependencies ranked by risk with indicators, usage sites, proposed replacement, attempts and executed test results, each labelled OBSERVED, VERIFIED or AI.
- Diagnostics on manifest declarations and usage sites, with quick fixes to apply a verified patch or show the capsule.
- Status bar summary of at-risk and verified dependencies.
- Patches are applied with `git apply` only after `git apply --check` passes and a confirmation that shows status and provenance.
