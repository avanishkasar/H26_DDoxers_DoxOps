# Capsule workspace design plan

## Intent

- Audience: maintainers and judges inspecting a DoxOps run.
- Page kind: static local viewer for the existing `capsule.json` contract, redesigned as a guided review workspace.
- Preserved constraints: read-only; no API calls, no invented dependency/test evidence; show provenance labels wherever capsule facts appear.
- Missing source data: there is no generated capsule in the repository. The initial state asks the user to open one and shows no fabricated metrics.

## Direction

- Color: background `#080d14`; panel `#101925`; raised surface `#141f2d`; border `#596e86`; primary ink `#edf3fa`; muted ink `#a0afc2`; quiet ink `#8293a9`; blue observed `#83b8ff`; green verified `#66dfb5`; amber AI `#f5c56b`; red risk `#ff8791`; focus ring `#f2f7ff`.
- Typography: system sans for headings and prose (24px page title, 18px section title, 14px body, 1.5 leading); system monospace for paths, versions, evidence ids, and commands (12px, 1.45 leading).
- Layout: report workspace. Header spans the viewport. Desktop uses a 315px dependency rail and a flexible detail pane, max content width 1480px. Below 1000px the rail and detail stack; below 680px controls and panels use one column and 16px gutters.
- Spacing: 4, 8, 12, 16, 24, 32px; owned by component padding/gap. Panel radius 12px; control radius 8px; no decorative shadows.
- Interactions: open JSON file button and drag/drop on import panel; three-step flow for loading, choosing, and reviewing; searchable dependency list; status filter; selectable dependency rows; step navigation; collapsible evidence/source details; keyboard-operable controls with visible focus. Parsing errors name the problem and next action.
- Signature: a provenance evidence rail beside each fact group, colored blue/green/amber and labeled OBSERVED/VERIFIED/AI. On narrow screens it moves above the fact text. This is subject-specific because DoxOps makes source certainty its central distinction.

## Inventory and wireframes

1. Header: DoxOps wordmark, local-file status, open-file action.
2. Import/empty state: explain local JSON loading and the three review steps; no metrics before data exists.
3. Run summary: target, commit, Python versions, generation time, evidence counts.
4. Three-step guide: open capsule, choose dependency, review evidence.
5. Dependency navigation: risk score/severity/status, text search, status filter.
6. Dependency detail: replacement, analysis, rationale, migration steps, risk indicators, usage sites, verification comparisons, attempts, open concerns.
7. Evidence drawer: command, exit status, duration, hash, log excerpt, provenance.

Desktop (1280px): `header`; below it `run summary`; then the horizontal three-step guide; then `315px dependency rail | flexible detail`.

Mobile (390px): `header`; `import and run summary`; a vertical three-step guide; `search and dependency list`; `selected dependency detail`; facts flow in one column with 16px gutters. No information is hidden.

## Critique and repair

- Subject substitution: a generic issue tracker could use a dependency list, but the three-color provenance rail and evidence command/hash fields are selected specifically because this project separates what was observed, executed, and suggested. The step sequence follows the capsule's actual workflow: load the artifact, select a finding, follow its proof.
- Default clusters: avoid equal KPI hero cards and generic gradient branding. Use compact run metadata, a ranked dependency rail, and evidence-first detail hierarchy. No decorative gradients or arbitrary accent color.
- Free axes: ink-navy surfaces and semantic blue/green/amber are tied to the report and provenance contract; monospace is reserved for machine identifiers. Borders carry hierarchy, so shadows are omitted. Motion is limited to control feedback and evidence navigation; reduced-motion is respected.
- Concentration: remove the provenance rail and the interface loses its defining evidence distinction; there is no competing decorative signature.
- Arithmetic: breakpoints are 1000px and 680px; at 390px the page uses 16px outer gutters and 20px card padding. Text can wrap; command/hash fields use overflow wrapping.

## Frozen verification checklist

- brief-fidelity: only displays supplied capsule fields and keeps AI distinct from verified facts.
- hierarchy: file import, run context, dependency selection, then evidence detail.
- consistency: semantic provenance colors and named spacing/type tokens are used throughout.
- responsive: verify 390px, 900px, 1280px widths and check horizontal overflow.
- content-integrity: initial state has no fabricated data; invalid files explain how to recover.
- distinctiveness: labeled provenance rail remains the signature.
- copy-quality: labels use active actions; errors and empty state explain next steps.
- contrast: measured primary/background 17.44:1, muted/panel 7.92:1, quiet/background 6.21:1, provenance labels at least 7.68:1, focus/panel 16.44:1, and panel border/raised surface 3.16:1.
- behavior: keyboard and mouse file loading, search, status filter, dependency selection, and evidence expansion.
- workflow: step 1 opens a capsule, step 2 focuses dependency search, and step 3 scrolls to verification evidence after a dependency is selected.
