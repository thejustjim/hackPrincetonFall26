"""Hard rule: Clarity never tells anyone their water is "safe". It reports what readings show."""
import re

_PHRASES = [
    (r"\b(?:is|are|looks?|seems?)\s+(?:perfectly\s+|totally\s+|completely\s+|now\s+)?safe(?:\s+to\s+drink)?\b", "is within normal range"),
    (r"\b(?:it'?s|that'?s|water'?s)\s+(?:perfectly\s+|totally\s+|now\s+)?safe(?:\s+to\s+drink)?\b", "it's within normal range"),
    (r"\bsafe\s+to\s+drink\b", "within normal range"),
    (r"\bsafe\s+range\b", "normal range"),
    (r"\bsafety\b", "water quality"),
    (r"\bsafely\b", "with care"),
]
_BARE = re.compile(r"(?<![A-Za-z])(?<!un)safe\b", re.IGNORECASE)


def scrub(text: str) -> str:
    """Rewrite any claim that water is safe into neutral, reading-based wording."""
    out = text
    for pat, repl in _PHRASES:
        out = re.sub(pat, repl, out, flags=re.IGNORECASE)
    # "SAFE" verdict label from the dashboard, and any leftover bare "safe"
    out = re.sub(r"\bverdict\s+SAFE\b", "verdict: within normal range", out)
    out = _BARE.sub("within normal range", out)
    return out


def violates(text: str) -> bool:
    return bool(_BARE.search(text)) or bool(re.search(r"\bsafe(ly|ty)\b", text, re.IGNORECASE))
