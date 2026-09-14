"""Process profile selected by the executable, not by ambient configuration."""

from __future__ import annotations

_public_instance = False


def enable_public_instance() -> None:
    global _public_instance
    _public_instance = True


def is_public_instance() -> bool:
    return _public_instance
