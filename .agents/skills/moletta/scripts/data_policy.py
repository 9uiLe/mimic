"""Bound selected local inputs and reject limited known credential signatures.

This is local input protection, not a classifier for arbitrary confidential data.
It does not enforce host filesystem or network permissions.
"""

from __future__ import annotations

import os
import json
from pathlib import Path
import re
import stat

from model import DataError


MAX_BYTES = 1024 * 1024
_CREDENTIAL_NAMES = frozenset({
    ".netrc", ".npmrc", ".pypirc", ".pgpass", ".git-credentials",
    "credentials", "credentials.json", "credentials.yaml", "credentials.yml",
    "secrets.json", "secrets.yaml", "secrets.yml", "secrets.toml",
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "kubeconfig",
    "application_default_credentials.json", "service-account.json",
})
_CREDENTIAL_SUFFIXES = frozenset({".key", ".pem", ".p12", ".pfx", ".jks", ".keystore", ".crt", ".cer"})
_SECRET = re.compile(
    r"-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----"
    r"|(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"
    r"|sk-[A-Za-z0-9_-]{20,}"
    r"|xox[baprs]-[A-Za-z0-9-]{10,}"
    r"|(?:AKIA|ASIA)[A-Z0-9]{16}"
    r"|AIza[A-Za-z0-9_-]{30,}"
    r"|ya29\.[A-Za-z0-9_-]{20,}"
    r"|\bauthorization\s*[:=]\s*[\"']?\s*(?:bearer|basic)\s+[^\s\"']+"
    r"|\b(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|passwd|"
    r"client[-_]?secret|secret(?:[-_]?key)?|aws[-_]?secret[-_]?access[-_]?key|private[-_]?key)"
    r"[\"']?\s*[:=]\s*[\"']?[^\s\"',;{}]+",
    re.IGNORECASE,
)
_CREDENTIAL_OPTION = re.compile(
    r"^--?(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|passwd|"
    r"client[-_]?secret|secret(?:[-_]?key)?|private[-_]?key)$", re.IGNORECASE)


def credential_name(path: Path) -> bool:
    name = path.name.casefold()
    return (name.startswith(".env") or name.startswith("client_secret")
            or name in _CREDENTIAL_NAMES or path.suffix.casefold() in _CREDENTIAL_SUFFIXES)


def _limit(max_bytes: int) -> None:
    if type(max_bytes) is not int or max_bytes <= 0:
        raise DataError("Input size limit must be a positive integer")


def validate_bytes(raw: bytes, *, label: str = "Selected input", allow_opaque: bool = False,
                   max_bytes: int = MAX_BYTES) -> None:
    """Raise generic diagnostics without echoing a matched value or input path."""
    _limit(max_bytes)
    if len(raw) > max_bytes:
        raise DataError(f"{label}: exceeds the allowed size")
    # Latin-1 preserves ASCII signatures even inside an explicitly selected binary.
    if _SECRET.search(raw.decode("latin-1")):
        raise DataError(f"{label}: known credential signature is not allowed")
    if allow_opaque:
        return
    try:
        text = raw.decode("utf-8")
    except UnicodeError:
        raise DataError(f"{label}: opaque data requires explicit artifact selection") from None
    if any(ord(character) < 32 and character not in "\t\n\r" or ord(character) == 127
           for character in text):
        raise DataError(f"{label}: opaque data requires explicit artifact selection")


def check_text(text: str, *, label: str = "Selected text", max_bytes: int = MAX_BYTES) -> None:
    try:
        raw = text.encode("utf-8")
    except UnicodeError:
        raise DataError(f"{label}: valid UTF-8 text is required") from None
    validate_bytes(raw, label=label, max_bytes=max_bytes)


def read_file(path: Path, *, label: str = "Selected input", allow_opaque: bool = False,
              max_bytes: int = MAX_BYTES) -> bytes:
    """Read at most a fixed cap from a selected regular file, never a symlink leaf."""
    _limit(max_bytes)
    if credential_name(path):
        raise DataError(f"{label}: credential filenames are not allowed")
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            details = os.fstat(stream.fileno())
            if not stat.S_ISREG(details.st_mode):
                raise DataError(f"{label}: select a regular file")
            if details.st_size > max_bytes:
                raise DataError(f"{label}: exceeds the allowed size")
            raw = stream.read(max_bytes + 1)
    except OSError:
        raise DataError(f"{label}: selected input cannot be read safely") from None
    validate_bytes(raw, label=label, allow_opaque=allow_opaque, max_bytes=max_bytes)
    return raw


def decode_json(raw: bytes, *, label: str = "Selected JSON", max_bytes: int = MAX_BYTES):
    """Validate decoded JSON too, so Unicode escapes do not bypass signatures."""
    validate_bytes(raw, label=label, max_bytes=max_bytes)
    def unique_object(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise DataError(f"{label}: duplicate JSON key")
            value[key] = item
        return value
    def reject_constant(value):
        raise DataError(f"{label}: non-finite JSON number")
    try:
        value = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=unique_object,
                           parse_constant=reject_constant)
        normalized = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except DataError:
        raise
    except (ValueError, UnicodeError, RecursionError):
        raise DataError(f"{label}: valid finite JSON is required") from None
    # Normalization can expand whitespace and non-ASCII bytes; size was bounded
    # at input. This pass checks decoded signatures without an incidental cap.
    validate_bytes(normalized, label=label, max_bytes=max(max_bytes, len(normalized)))
    return value


def read_json(path: Path, *, label: str = "Selected JSON", max_bytes: int = MAX_BYTES):
    return decode_json(read_file(path, label=label, max_bytes=max_bytes), label=label, max_bytes=max_bytes)


def check_argv(argv: list[str]) -> None:
    """Check literal arguments; command names are not a network permission policy."""
    check_text("\n".join(argv), label="Command arguments")
    for index, argument in enumerate(argv):
        if _CREDENTIAL_OPTION.fullmatch(argument) and index + 1 < len(argv):
            raise DataError("Command arguments: credential options are not allowed")
        for token in re.split(r"[\s\"'=;,()\[\]{}<>]+", argument):
            if token and credential_name(Path(token)):
                raise DataError("Command arguments: credential filenames are not allowed")
