"""Allow ``python -m doxops`` (used by the local dashboard to start runs)."""

from .cli import main

if __name__ == "__main__":
    main(prog_name="doxops")
