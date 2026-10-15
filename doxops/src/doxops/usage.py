"""Static usage discovery: where and how each dependency is used in the repository."""

from __future__ import annotations

import ast
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .models import ToolReference, UsageSite

SKIP_DIRS = {".git", ".venv", "venv", "env", "node_modules", "__pycache__", ".doxops", "build", "dist", ".tox", ".nox"}
TOOL_FILES = (
    "Makefile",
    "makefile",
    "Dockerfile",
    "tox.ini",
    "noxfile.py",
    "setup.cfg",
    ".pre-commit-config.yaml",
    "Procfile",
)
TOOL_GLOBS = (".github/workflows/*.yml", ".github/workflows/*.yaml", "*.sh", "scripts/*.sh")


def iter_python_files(root: Path, exclude: set[str]) -> list[Path]:
    out: list[Path] = []
    for path in root.rglob("*.py"):
        rel_parts = path.relative_to(root).parts
        if set(rel_parts[:-1]) & SKIP_DIRS or (rel_parts and rel_parts[0] in exclude):
            continue
        out.append(path)
    return sorted(out)


def local_modules(root: Path, exclude: set[str]) -> set[str]:
    names: set[str] = set()
    for child in root.iterdir():
        if child.name in SKIP_DIRS or child.name in exclude or child.name.startswith("."):
            continue
        if child.is_dir() and ((child / "__init__.py").is_file() or any(child.glob("*.py"))):
            names.add(child.name)
        elif child.suffix == ".py":
            names.add(child.stem)
    src = root / "src"
    if src.is_dir():
        names |= {c.name for c in src.iterdir() if c.is_dir()}
    return names


@dataclass
class FileScan:
    sites: list[UsageSite] = field(default_factory=list)
    imported_top: set[str] = field(default_factory=set)


def _is_private(name: str) -> bool:
    return name.startswith("_") and not (name.startswith("__") and name.endswith("__"))


class _Visitor(ast.NodeVisitor):
    def __init__(self, rel: str, lines: list[str]) -> None:
        self.rel = rel
        self.lines = lines
        self.alias: dict[str, str] = {}  # local name -> dotted module/attr path
        self.result = FileScan()
        self._seen: set[tuple[int, str, str]] = set()
        self._parents: dict[int, ast.AST] = {}

    def _snippet(self, line: int) -> str:
        return self.lines[line - 1].strip() if 0 < line <= len(self.lines) else ""

    def _add(self, node: ast.AST, dotted: str, kind: str, symbol: str | None = None) -> None:
        line = getattr(node, "lineno", 0)
        key = (line, dotted, kind)
        if key in self._seen:
            return
        self._seen.add(key)
        self.result.sites.append(
            UsageSite(
                file=self.rel,
                line=line,
                col=getattr(node, "col_offset", 0),
                module=dotted.split(".", 1)[0],
                symbol=symbol or dotted,
                kind=kind,  # type: ignore[arg-type]
                snippet=self._snippet(line),
            )
        )

    def visit(self, node: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            self._parents[id(child)] = node
        super().visit(node)

    def visit_Import(self, node: ast.Import) -> None:
        for name in node.names:
            top = name.name.split(".", 1)[0]
            self.result.imported_top.add(top)
            local = name.asname or top
            self.alias[local] = name.name if name.asname else top
            self._add(node, name.name, "import")
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.level or not node.module:
            self.generic_visit(node)
            return
        top = node.module.split(".", 1)[0]
        self.result.imported_top.add(top)
        for name in node.names:
            dotted = f"{node.module}.{name.name}"
            self.alias[name.asname or name.name] = dotted
            kind = "private-api" if any(_is_private(p) for p in dotted.split(".")) else "from-import"
            self._add(node, dotted, kind, symbol=dotted)
        self.generic_visit(node)

    def _resolve(self, node: ast.AST) -> str | None:
        parts: list[str] = []
        while isinstance(node, ast.Attribute):
            parts.append(node.attr)
            node = node.value
        if isinstance(node, ast.Name) and node.id in self.alias:
            return ".".join([self.alias[node.id], *reversed(parts)])
        return None

    def visit_Attribute(self, node: ast.Attribute) -> None:
        parent = self._parents.get(id(node))
        if not isinstance(parent, ast.Attribute):  # only the outermost attribute of a chain
            dotted = self._resolve(node)
            if dotted:
                if any(_is_private(p) for p in dotted.split(".")[1:]):
                    kind = "private-api"
                elif isinstance(parent, ast.Call) and parent.func is node:
                    kind = "call"
                else:
                    kind = "attribute"
                self._add(node, dotted, kind)
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        parent = self._parents.get(id(node))
        if node.id in self.alias and isinstance(node.ctx, ast.Load) and not isinstance(parent, ast.Attribute):
            kind = "call" if isinstance(parent, ast.Call) and parent.func is node else "attribute"
            self._add(node, self.alias[node.id], kind)
        self.generic_visit(node)

    def _check_patch(self, target: ast.AST, node: ast.AST) -> None:
        if isinstance(target, ast.Attribute):
            dotted = self._resolve(target)
            if dotted:
                self._add(node, dotted, "monkeypatch")

    def visit_Assign(self, node: ast.Assign) -> None:
        for target in node.targets:
            self._check_patch(target, node)
        self.generic_visit(node)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        self._check_patch(node.target, node)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        # setattr(module.Thing, "name", value) is monkeypatching too
        if isinstance(node.func, ast.Name) and node.func.id == "setattr" and node.args:
            dotted = self._resolve(node.args[0])
            if dotted:
                self._add(node, dotted, "monkeypatch")
        self.generic_visit(node)


def scan_file(path: Path, root: Path) -> FileScan:
    rel = path.relative_to(root).as_posix()
    text = path.read_text(encoding="utf-8", errors="replace")
    try:
        tree = ast.parse(text, filename=rel)
    except SyntaxError:
        return FileScan()
    visitor = _Visitor(rel, text.splitlines())
    visitor.visit(tree)
    return visitor.result


@dataclass
class UsageReport:
    sites: list[UsageSite]
    imported_top: dict[str, list[str]]  # top-level module -> files importing it
    third_party_top: set[str]
    local: set[str]
    tool_references: list[ToolReference]


def scan_repository(root: Path, exclude: set[str] | None = None) -> UsageReport:
    exclude = exclude or set()
    local = local_modules(root, exclude)
    sites: list[UsageSite] = []
    imported: dict[str, list[str]] = {}
    for path in iter_python_files(root, exclude):
        result = scan_file(path, root)
        sites.extend(result.sites)
        rel = path.relative_to(root).as_posix()
        for top in result.imported_top:
            imported.setdefault(top, []).append(rel)
    stdlib = set(sys.stdlib_module_names) | {"__future__"}
    third = {m for m in imported if m not in stdlib and m not in local}
    sites = [s for s in sites if s.module in third]
    return UsageReport(sites=sites, imported_top=imported, third_party_top=third, local=local, tool_references=[])


def find_tool_references(root: Path, commands: dict[str, str], exclude: set[str] | None = None) -> list[ToolReference]:
    """Find build/CI files invoking console scripts (``nosetests``) or ``python -m module``.

    ``commands`` maps a command word to the distribution that provides it.
    """
    exclude = exclude or set()
    files: set[Path] = set()
    for name in TOOL_FILES:
        files |= {p for p in root.glob(name) if p.is_file()}
    for pattern in TOOL_GLOBS:
        files |= {p for p in root.glob(pattern) if p.is_file()}
    files = {p for p in files if p.relative_to(root).parts[0] not in exclude}
    refs: list[ToolReference] = []
    if not commands:
        return refs
    pattern = re.compile(r"(?<![\w./-])(?:-m\s+)?(" + "|".join(re.escape(c) for c in commands) + r")(?![\w-])")
    for path in sorted(files):
        rel = path.relative_to(root).as_posix()
        for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
            if line.lstrip().startswith("#"):
                continue
            for m in pattern.finditer(line):
                refs.append(ToolReference(tool=m.group(1), source_file=rel, line=lineno, text=line.strip()))
    return refs
