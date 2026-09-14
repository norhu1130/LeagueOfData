"""Python counterpart of TypeScript AST canonicalization and hashing.

The hash keys result caches and drill-down tokens, so both languages must produce identical output.
Rules remove spans and presentation spelling, sort object keys, fold integral floats, and preserve
array order.
"""

from __future__ import annotations

import hashlib
import math
from decimal import Decimal
from typing import Any

ALWAYS_DROP = frozenset({"span"})
PRESENTATION_KEYS = frozenset({"raw"})
MIN_CANONICAL_ABS = 1e-6
MAX_CANONICAL_ABS = 1e21


def canonicalize(value: Any, *, drop_raw: bool = True) -> Any:
    """Convert a value to a JSON-serializable canonical form."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        if abs(value) >= MAX_CANONICAL_ABS:
            raise ValueError(
                f"Canonical integers must have an absolute value below {MAX_CANONICAL_ABS}: {value}"
            )
        return value
    if isinstance(value, float):
        return _normalize_number(value)
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return [canonicalize(v, drop_raw=drop_raw) for v in value]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key in sorted(value):
            if key in ALWAYS_DROP:
                continue
            if drop_raw and key in PRESENTATION_KEYS:
                continue
            v = value[key]
            if v is None and key not in _NULLABLE_KEYS:
                # TypeScript removes undefined but retains meaningful null AST fields.
                out[key] = None
                continue
            out[key] = canonicalize(v, drop_raw=drop_raw)
        return out
    raise TypeError(f"Cannot canonicalize value of type {type(value).__name__}")


#: Keys where null is meaningful; all nulls are currently retained.
_NULLABLE_KEYS: frozenset[str] = frozenset()


def _normalize_number(value: float) -> int | float:
    """Fold integral floats and reject values whose JS/Python spellings diverge."""
    if not math.isfinite(value):
        raise ValueError(f"Cannot canonicalize non-finite number: {value}")
    magnitude = abs(value)
    if magnitude != 0 and not MIN_CANONICAL_ABS <= magnitude < MAX_CANONICAL_ABS:
        raise ValueError(
            "Canonical numbers must be zero or have an absolute value in "
            f"[{MIN_CANONICAL_ABS}, {MAX_CANONICAL_ABS}): {value}"
        )
    if value.is_integer():
        return int(value)
    return value


def canonical_stringify(value: Any) -> str:
    """Serialize sorted keys identically to TypeScript `canonicalStringify`."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _float_to_json(value)
    if isinstance(value, str):
        return _string_to_json(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical_stringify(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = [
            _string_to_json(k) + ":" + canonical_stringify(v) for k, v in sorted(value.items())
        ]
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"Cannot serialize value of type {type(value).__name__}")


def _float_to_json(value: float) -> str:
    """Match JavaScript's shortest round-trippable float representation."""
    if value == 0:
        return "0"
    text = repr(value)
    # ECMAScript uses fixed notation for the allowed range even when Python's repr chooses an
    # exponent. Expanding the shortest Python representation preserves its exact decimal digits.
    if "e" in text or "E" in text:
        return format(Decimal(text), "f")
    return text


#: Escapes used by JSON.stringify, implemented directly because Python differs subtly.
_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
    "\b": "\\b",
    "\f": "\\f",
}


def _string_to_json(value: str) -> str:
    out = ['"']
    for ch in value:
        escaped = _ESCAPES.get(ch)
        if escaped is not None:
            out.append(escaped)
        elif ord(ch) < 0x20:
            out.append(f"\\u{ord(ch):04x}")
        else:
            # JSON.stringify preserves non-ASCII text such as localized labels.
            out.append(ch)
    out.append('"')
    return "".join(out)


def canonical_json(ast: Any, *, drop_raw: bool = True) -> str:
    return canonical_stringify(canonicalize(ast, drop_raw=drop_raw))


def canonical_hash(ast: Any) -> str:
    """Return the content hash used by cache keys and drill-down tokens."""
    digest = hashlib.sha256(
        canonical_json(_normalize_commutative_for_hash(ast)).encode("utf-8")
    ).hexdigest()
    return f"sha256:{digest}"


def _normalize_commutative_for_hash(value: Any) -> Any:
    """Sort associative boolean operands for semantic cache-key equivalence."""
    if isinstance(value, list):
        return [_normalize_commutative_for_hash(item) for item in value]
    if not isinstance(value, dict):
        return value

    normalized = {key: _normalize_commutative_for_hash(item) for key, item in value.items()}
    op = normalized.get("op")
    if normalized.get("kind") != "BinaryExpr" or op not in {"AND", "OR"}:
        return normalized

    operands: list[Any] = []

    def collect(node: Any) -> None:
        if isinstance(node, dict) and node.get("kind") == "BinaryExpr" and node.get("op") == op:
            collect(node.get("left"))
            collect(node.get("right"))
        else:
            operands.append(node)

    collect(normalized)
    operands.sort(key=lambda item: canonical_stringify(canonicalize(item)))
    result = operands[0]
    for operand in operands[1:]:
        result = {"kind": "BinaryExpr", "op": op, "left": result, "right": operand}
    return result
