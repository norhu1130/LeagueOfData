"""Select Korean particles from the final consonant of a word.

Event and champion names may end in Hangul, digits, or Latin letters, all of which can appear
directly in localized product copy.
"""

from __future__ import annotations

#: Latin endings conventionally pronounced with a final consonant in Korean.
_CONSONANT_ENDING_LETTERS = frozenset("lmnr")

#: Whether the Korean reading of each digit ends with a consonant.
_DIGIT_HAS_FINAL = {
    "0": True,
    "1": True,
    "2": False,
    "3": True,
    "4": False,
    "5": False,
    "6": True,
    "7": True,
    "8": True,
    "9": False,
}


def has_final_consonant(word: str) -> bool:
    """Return whether the final character is pronounced with a final consonant."""
    if not word:
        return False
    ch = word.rstrip(")]\"'」』 ")[-1:] or word[-1]

    if "가" <= ch <= "힣":
        return (ord(ch) - 0xAC00) % 28 != 0
    if ch.isdigit():
        return _DIGIT_HAS_FINAL[ch]
    if ch.isalpha():
        return ch.lower() in _CONSONANT_ENDING_LETTERS
    return False


def particle(word: str, with_final: str, without_final: str) -> str:
    """Append the particle variant appropriate for the final consonant."""
    return f"{word}{with_final if has_final_consonant(word) else without_final}"


def eul_reul(word: str) -> str:
    """Append the Korean object particle."""
    return particle(word, "을", "를")


def i_ga(word: str) -> str:
    """Append the Korean subject particle."""
    return particle(word, "이", "가")


def eun_neun(word: str) -> str:
    """Append the Korean topic particle."""
    return particle(word, "은", "는")


def gwa_wa(word: str) -> str:
    """Append the Korean conjunction particle."""
    return particle(word, "과", "와")


def euro_ro(word: str) -> str:
    """Append the directional particle, applying the special rieul rule."""
    if word and "가" <= word[-1] <= "힣" and (ord(word[-1]) - 0xAC00) % 28 == 8:
        return f"{word}로"
    return particle(word, "으로", "로")
