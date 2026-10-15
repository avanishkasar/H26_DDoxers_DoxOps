from __future__ import annotations

from pathlib import Path

import pytest

REQUIREMENTS = """\
toml==0.10.2
requests==2.31.0  # http
-r requirements-extra.txt
# PyYAML==5.1
six
"""

PYPROJECT = """\
[build-system]
requires = ["setuptools>=61"]

[project]
name = "demo"
requires-python = ">=3.10"
dependencies = [
    "toml==0.10.2",
    "requests>=2",
    "six",
]
"""

APP = """\
import json
import toml
import requests
from requests.utils import _parse_content_type_header
from requests import Session as S


def load(path):
    return toml.load(path)


def fetch(url):
    return S().get(url, timeout=5)


requests.Session.request = lambda *a, **k: None
"""


@pytest.fixture
def demo_repo(tmp_path: Path) -> Path:
    root = tmp_path / "demo"
    (root / "demo").mkdir(parents=True)
    (root / "tests").mkdir()
    (root / "requirements.txt").write_text(REQUIREMENTS, encoding="utf-8")
    (root / "requirements-extra.txt").write_text("idna==2.7\n", encoding="utf-8")
    (root / "pyproject.toml").write_text(PYPROJECT, encoding="utf-8")
    (root / "demo" / "__init__.py").write_text("", encoding="utf-8")
    (root / "demo" / "app.py").write_text(APP, encoding="utf-8")
    (root / "tests" / "test_app.py").write_text(
        "from demo.app import load\n\n\ndef test_x():\n    assert load\n", encoding="utf-8"
    )
    (root / "Makefile").write_text("PYTHON ?= python3.12\n\ntest-nose:\n\tnosetests tests/\n", encoding="utf-8")
    (root / "Dockerfile").write_text("FROM python:3.12-slim\n", encoding="utf-8")
    return root
