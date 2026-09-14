# Repository scripts

This directory contains repository-wide verification helpers.

- `check-generated.mjs` regenerates reference artifacts and fails when tracked files change or scoped generated files are untracked.
- `smoke_wheels.py` extracts built Python wheels and verifies that the API catalog and built-in regions load without relying on the repository layout.

Run these through the root commands or CI rather than importing them as application code.
