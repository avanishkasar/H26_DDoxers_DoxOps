# Notes for coding agents

- The Python tool lives in `doxops/` (package `doxops/src/doxops`, tests in `doxops/tests`).
- Dashboard UI work: read `doxops/src/doxops/web/CODEX.md` first. Only edit files in `doxops/src/doxops/web/`;
  the API in `doxops/src/doxops/server.py` is a fixed contract.
- Setup: `cd doxops && uv venv && uv pip install -e ".[dev]"`
- Check before you finish: `cd doxops && .venv/bin/ruff format . && .venv/bin/ruff check . && .venv/bin/python -m pytest -q`
- Run the dashboard: `cd doxops && .venv/bin/doxops serve` (loopback only; it runs the target project's tests).
- Never present AI output as verified: keep the OBSERVED / VERIFIED / AI labels visible.
