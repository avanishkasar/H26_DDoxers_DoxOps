"""Compare a candidate test run with the baseline, test by test, and explain each break."""

from __future__ import annotations

from .models import Comparison, SuiteRun, TestDelta
from .risk import attribute_warning

_PASS = {"passed", "xfailed", "skipped"}
_RAN_OK = {"passed", "xfailed"}

EXPLANATIONS = {
    "ImportError": "A name the code imports no longer exists in the installed version (API removed or moved).",
    "ModuleNotFoundError": "A module is missing: the dependency was removed, renamed, or not installed.",
    "AttributeError": "An attribute or method the code uses does not exist in the new library (API change).",
    "TypeError": "A call signature changed: arguments were added, removed, renamed, or reordered.",
    "ValueError": "The new library validates input differently or returns different values.",
    "Timeout": "Behaviour change around timeouts: the new code path waits for a different amount of time.",
    "ReadTimeout": "The new HTTP client applies a default timeout the old one did not have.",
    "ConnectTimeout": "The new HTTP client applies a default connect timeout the old one did not have.",
    "AssertionError": "The code runs but produces a different result: a behavioural incompatibility.",
    "UnicodeDecodeError": "Text decoding differs: charset detection or default encoding changed.",
    "DeprecationWarning": "A deprecated API is used and warnings are configured as errors.",
    "Skipped": "The test ran before but is skipped after the change, so it no longer proves anything.",
}


def explain(failure_class: str | None) -> str | None:
    if not failure_class:
        return None
    return EXPLANATIONS.get(failure_class, f"Raised {failure_class}; inspect the evidence log for the traceback.")


def _dep_warning_count(run: SuiteRun, module_to_dist: dict[str, str]) -> int:
    return sum(
        w.count
        for w in run.warnings
        if w.category in ("DeprecationWarning", "PendingDeprecationWarning", "FutureWarning")
        and attribute_warning(w, module_to_dist, {}) is not None
    )


def compare(baseline: SuiteRun, candidate: SuiteRun, module_to_dist: dict[str, str] | None = None) -> Comparison:
    m2d = module_to_dist or {}
    comp = Comparison(python=candidate.python)
    before = {t.nodeid: t for t in baseline.tests}
    after = {t.nodeid: t for t in candidate.tests}
    for nodeid in sorted(set(before) | set(after)):
        b, a = before.get(nodeid), after.get(nodeid)
        if b and not a:
            change = "removed"
        elif a and not b:
            change = "new"
        else:
            assert a and b
            # a test that ran and passed before but is skipped afterwards counts as a regression, so a
            # migration cannot hide breakage by skipping tests; a failure turned into a skip is not a fix
            b_ok = b.outcome in _PASS
            a_ok = a.outcome in _RAN_OK or (a.outcome == "skipped" and b.outcome == "skipped")
            change = {
                (False, True): "fixed",
                (True, False): "regressed",
                (False, False): "still-failing",
                (True, True): "still-passing",
            }[(b_ok, a_ok)]
        setattr(comp, change.replace("-", "_"), getattr(comp, change.replace("-", "_")) + 1)
        fc = a.failure_class if a else None
        if a and a.outcome == "skipped" and change in ("regressed", "still-failing"):
            fc = "Skipped"
        comp.deltas.append(
            TestDelta(
                nodeid=nodeid,
                python=candidate.python,
                before=b.outcome if b else "absent",
                after=a.outcome if a else "absent",
                change=change,  # type: ignore[arg-type]
                after_message=(a.message if a and (a.outcome not in _PASS or fc == "Skipped") else "")[:600],
                failure_class=fc,
                explanation=explain(fc) if change in ("regressed", "still-failing") else None,
            )
        )
    comp.warnings_before = sum(w.count for w in baseline.warnings)
    comp.warnings_after = sum(w.count for w in candidate.warnings)
    comp.dependency_warnings_before = _dep_warning_count(baseline, m2d)
    comp.dependency_warnings_after = _dep_warning_count(candidate, m2d)
    return comp
