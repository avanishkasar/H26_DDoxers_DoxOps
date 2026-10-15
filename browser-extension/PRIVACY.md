# Privacy policy: DoxOps for GitHub (browser extension)

Last updated: 2026-10-15. Publisher: Team DDoxers.

## Summary

DoxOps for GitHub collects nothing. It has no accounts, no analytics, no telemetry, no ads and
no server of its own. It does not read, store or send personal information.

## What the extension contacts

When you open a public GitHub repository page (or click the toolbar button on one), the
extension makes read-only HTTPS requests to exactly three hosts, and to no others:

| Host | What is requested | Why |
|---|---|---|
| `raw.githubusercontent.com` | The repository's root `requirements.txt`, `requirements-dev.txt`, `pyproject.toml` and `setup.py` | To list the declared Python dependencies |
| `pypi.org` | Public package metadata (JSON API and Simple API) for each declared package | To check release dates, yanked versions, project status and supported Python versions |
| `api.github.com` | One unauthenticated repository lookup, only when no manifest file is found | To tell a private repository apart from a repository with no Python manifests |

The requests carry no cookies, tokens or credentials (`credentials: "omit"`). They contain only
the repository owner, repository name, branch or tag and package names, all of which are
already public. Those services receive the request as for any browser request (for example
your IP address), under their own privacy policies.

## What is stored

Scan results (10 minutes) and PyPI responses (1 hour) are cached in the browser's
`storage.session` area on your device. It is cleared when the browser closes and is never
synced or sent anywhere.

## Files you load

A `capsule.json` you choose with **Load capsule.json** is read locally inside the popup to
display it. It is not uploaded or stored.

## Links the extension opens

**Fix in VS Code** opens a `vscode://` link on your computer so VS Code can clone the
repository. **Copy CLI command** writes a command to your clipboard. Neither sends data to us.

## Data sharing and sale

There is no data to share or sell. Nothing is sent to Team DDoxers or to any third party
beyond the three read-only hosts above.

## Changes and contact

Any change to this policy will be published in this file in the project repository:
https://github.com/avanishkasar/h26_ddoxers_doxops/blob/main/browser-extension/PRIVACY.md.
Questions: open an issue at https://github.com/avanishkasar/h26_ddoxers_doxops/issues.
