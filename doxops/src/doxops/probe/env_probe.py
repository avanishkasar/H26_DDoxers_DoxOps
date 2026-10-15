"""Runs inside the target virtualenv: map import names to distributions and probe imports.

Usage: python env_probe.py <out.json> <comma,separated,distributions> [<module> ...]
Probes the given modules plus every public top-level module of the given distributions.
Standard library only.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import sysconfig
from importlib import metadata


def _probe(module: str, strict: bool) -> tuple[bool, str | None]:
    flags = ["-W", "error::DeprecationWarning", "-W", "error::PendingDeprecationWarning"] if strict else []
    proc = subprocess.run(
        [sys.executable, *flags, "-c", f"import {module}"],
        capture_output=True,
        text=True,
        encoding="utf-8",  # the child writes UTF-8 (PYTHONIOENCODING); never decode with the Windows code page
        errors="replace",
        timeout=120,
        check=False,
    )
    if proc.returncode == 0:
        return True, None
    lines = [ln for ln in proc.stderr.strip().splitlines() if ln.strip()]
    return False, "\n".join(lines[-6:])


def _norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def main() -> None:
    out_path, dists_arg, extra = sys.argv[1], sys.argv[2], sys.argv[3:]
    wanted = {_norm(d) for d in dists_arg.split(",") if d}
    pkg_map = metadata.packages_distributions()
    modules = list(dict.fromkeys(extra))
    for module, owners in sorted(pkg_map.items()):
        if module.startswith("_") or "-" in module or "." in module:
            continue
        if any(_norm(o) in wanted for o in owners) and module not in modules:
            modules.append(module)
    installed = {}
    requires: dict[str, list[str]] = {}
    scripts: dict[str, list[str]] = {}
    for dist in metadata.distributions():
        name = dist.metadata["Name"]
        if not name:
            continue
        installed[name] = dist.version
        requires[name] = sorted(
            {_norm(re.split(r"[ ;<>=!~\[(]", r, maxsplit=1)[0]) for r in (dist.requires or []) if "extra ==" not in r}
        )
        eps = [ep.name for ep in dist.entry_points if ep.group == "console_scripts"]
        if eps:
            scripts[name] = sorted(eps)
    probes = []
    for module in modules:
        ok, err = _probe(module, strict=False)
        strict_ok, strict_err = _probe(module, strict=True) if ok else (False, err)
        probes.append({"module": module, "ok": ok, "error": err, "strict_ok": strict_ok, "strict_error": strict_err})
    payload = {
        "python": sys.version.split()[0],
        "packages_distributions": {k: sorted(set(v)) for k, v in pkg_map.items()},
        "installed": installed,
        "requires": requires,
        "console_scripts": scripts,
        "purelib": sysconfig.get_paths()["purelib"],
        "probes": probes,
    }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)


if __name__ == "__main__":
    main()
