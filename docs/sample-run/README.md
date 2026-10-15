# Sample run: LinkWatch with Gemma 4 on a laptop

`report.html` is the unedited report from a real `doxops run` against
[rishrek/LinkWatch](https://github.com/rishrek/LinkWatch) at `f52f3930c8e7`, produced on
15 Oct 2026 with `scripts/demo.ps1` on Windows 11 (RTX 4070, 32 GB RAM), model `gemma4:e4b`
through local Ollama, Python 3.12 and 3.13. Download it and open it in a browser.
Local paths in it are already redacted to `<out>` and `~` by DoxOps.

| Result | Value |
| --- | --- |
| Dependencies analysed | 15 |
| Flagged at risk | 11 |
| Verified on both Pythons | 6 (jinja2, requests, idna, certifi, chardet, six) |
| Partially verified (tests pass, some call sites not reached by tests) | 3 (pydantic, setuptools, appdirs) |
| Not verified | 2 (nose, toml) |
| All accepted migrations together | 1 failing test fixed, 0 regressions on 3.12 and 3.13 |
| Commands executed and logged as evidence | 181 |

The two failures are kept on purpose because they show the guardrails working:

- **toml**: Gemma swapped `toml` for `tomli` but opened the file in text mode. The re-run test
  failed with `TypeError: File must be opened in binary mode`, so DoxOps rejected every attempt
  instead of reporting a fix.
- **nose**: Gemma's Makefile edit did not match the file exactly once, so DoxOps refused to apply
  it and reported the leftover `nosetests` call. The model had copied line-number gutters from
  its prompt into the edit; the edit matcher now strips them.
