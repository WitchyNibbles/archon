"""Span-preserving JSONC editing: the only part of installation that rewrites a
file a person wrote by hand.

Claude Code reads `.claude/settings.json` and `.mcp.json` as JSON with comments and
trailing commas, and people keep both there on purpose. So Archon never reserialises
those documents: it scans them for the exact byte spans of the members it owns, and
inserts or lifts its own text at those offsets. Everything outside an owned span --
comments, key order, indentation, a trailing comma -- comes back byte for byte, which
is what `uninstall` restoring the original file means (AC-23).

`InstallError` lives here rather than in `install` because every refusal in this layer
is the same refusal: the document is not a shape Archon can own, so nothing is written.
`_block` is here for the same reason: the marked ``CLAUDE.md`` region is one more
span inside a file a person wrote, located rather than reserialised.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

_DECODER = json.JSONDecoder()


class InstallError(ValueError):
    """An unsafe or malformed installation input was rejected before writing."""


def _skip(text: str, index: int) -> int:
    """Advance past whitespace, separators and the comment forms Claude Code accepts."""
    while index < len(text):
        if text[index].isspace() or text[index] == ",":
            index += 1
        elif text.startswith("//", index):
            end = text.find("\n", index)
            index = len(text) if end < 0 else end + 1
        elif text.startswith("/*", index):
            end = text.find("*/", index)
            if end < 0:
                raise InstallError("Unterminated comment in configuration; nothing was changed")
            index = end + 2
        else:
            return index
    return index


def _scan_object(text: str, start: int) -> tuple[dict[str, tuple[int, int]], int]:
    index = _skip(text, start)
    if index >= len(text) or text[index] != "{":
        raise InstallError("Expected a JSON object in configuration")
    index += 1
    spans: dict[str, tuple[int, int]] = {}
    while True:
        index = _skip(text, index)
        if index >= len(text):
            raise InstallError("Unterminated JSON object; nothing was changed")
        if text[index] == "}":
            return spans, index + 1
        key, index = _raw(text, index)
        if not isinstance(key, str):
            raise InstallError("JSON object keys must be strings")
        index = _skip(text, index)
        if index >= len(text) or text[index] != ":":
            raise InstallError("Malformed JSON object member; nothing was changed")
        begin = _skip(text, index + 1)
        _, index = _decode(text, begin)
        spans[key] = (begin, index)


def _scan_array(text: str, start: int) -> tuple[list[tuple[int, int]], int]:
    index = _skip(text, start)
    if index >= len(text) or text[index] != "[":
        raise InstallError("Expected a JSON array in configuration")
    index += 1
    spans: list[tuple[int, int]] = []
    while True:
        index = _skip(text, index)
        if index >= len(text):
            raise InstallError("Unterminated JSON array; nothing was changed")
        if text[index] == "]":
            return spans, index + 1
        begin = index
        _, index = _decode(text, begin)
        spans.append((begin, index))


def _raw(text: str, index: int) -> tuple[Any, int]:
    try:
        return _DECODER.raw_decode(text, index)
    except ValueError as exc:
        raise InstallError("Invalid JSON configuration; nothing was changed") from exc


def _decode(text: str, index: int) -> tuple[Any, int]:
    index = _skip(text, index)
    if index >= len(text):
        raise InstallError("Truncated JSON configuration; nothing was changed")
    if text[index] == "{":
        members, end = _scan_object(text, index)
        return {key: _decode(text, span[0])[0] for key, span in members.items()}, end
    if text[index] == "[":
        elements, end = _scan_array(text, index)
        return [_decode(text, span[0])[0] for span in elements], end
    return _raw(text, index)


def _members(text: str, start: int = 0) -> dict[str, tuple[int, int]]:
    return _scan_object(text, start)[0]


def _document(text: str) -> Any:
    return _decode(text, 0)[0] if text.strip() else {}


def _line_indent(text: str, index: int) -> str:
    """The indentation of the line holding ``index``, so additions line up with it."""
    line = text[text.rfind("\n", 0, index) + 1 : index]
    return line[: len(line) - len(line.lstrip())]


def _shift(rendered: str, indent: str) -> str:
    return rendered.replace("\n", "\n" + indent)


@dataclass(frozen=True)
class _Unit:
    """One owned insertion: a member of, or an element in, a JSON container."""

    id: str
    path: tuple[str, ...]
    key: str | None
    value: Any

    def canonical(self) -> str:
        return json.dumps(self.value, ensure_ascii=False, sort_keys=True)


def _descend(text: str, path: tuple[str, ...]) -> tuple[tuple[int, int], tuple[str, ...]]:
    begin = _skip(text, 0)
    span = (begin, _decode(text, begin)[1])
    for index, name in enumerate(path):
        members = _members(text, span[0])
        if name not in members:
            return span, path[index:]
        span = members[name]
    return span, ()


def _wrap(remaining: tuple[str, ...], key: str | None, value: Any) -> tuple[str, Any]:
    node: Any = {key: value} if key is not None else [value]
    for name in reversed(remaining[1:]):
        node = {name: node}
    return remaining[0], node


def _placement(text: str, span: tuple[int, int], key: str | None, rendered: str) -> tuple[int, str]:
    opener = text[span[0]]
    if opener == "{":
        items = list(_scan_object(text, span[0])[0].values())
    elif opener == "[":
        items = _scan_array(text, span[0])[0]
    else:
        raise InstallError("Managed configuration member is not a JSON container")
    prefix = (json.dumps(key) + ": ") if key is not None else ""
    if items:
        indent = _line_indent(text, min(start for start, _end in items))
        anchor = max(end for _start, end in items)
        newline = text.find("\n", anchor)
        tail = text[anchor : newline if newline >= 0 else len(text)]
        if tail.lstrip().startswith("//"):
            # A trailing comment annotates the entry above it, not Archon's.
            return anchor + len(tail), "\n" + indent + ", " + prefix + _shift(rendered, indent)
        return anchor, ",\n" + indent + prefix + _shift(rendered, indent)
    outer = _line_indent(text, span[0])
    indent = outer + "  "
    return span[1] - 1, "\n" + indent + prefix + _shift(rendered, indent) + "\n" + outer


def _insert(text: str, unit: _Unit) -> tuple[str, str]:
    span, remaining = _descend(text, unit.path)
    key, value = _wrap(remaining, unit.key, unit.value) if remaining else (unit.key, unit.value)
    rendered = json.dumps(value, ensure_ascii=False, indent=2)
    position, inserted = _placement(text, span, key, rendered)
    return text[:position] + inserted + text[position:], inserted


def _strip(text: str, records: list[dict[str, str]]) -> tuple[str, dict[str, bool]]:
    """Lift owned insertions innermost first: a nested one is contiguous only then."""
    present: dict[str, bool] = {}
    for record in reversed(records):
        present[record["id"]] = record["text"] in text
        if present[record["id"]]:
            text = text.replace(record["text"], "", 1)
    return text, present


def _current(previous: list[dict[str, str]], units: list[_Unit], text: str) -> bool:
    if [record["id"] for record in previous] != [unit.id for unit in units]:
        return False
    if any(record["value"] != unit.canonical() for record, unit in zip(previous, units, strict=True)):
        return False
    return all(_strip(text, previous)[1].values())


def _satisfied(text: str, unit: _Unit) -> bool:
    """The array already holds this element, so Archon adds and owns nothing."""
    span, remaining = _descend(text, unit.path)
    if remaining or unit.key is not None or text[span[0]] != "[":
        return False
    return unit.value in _decode(text, span[0])[0]


def _block(text: str, begin: str, end: str) -> tuple[int, int] | None:
    """The span of one marked region in a Markdown file, or None if unmarked.

    Two regions, or an end without a begin, mean the file no longer says which
    bytes Archon owns, so nothing is removed and the caller refuses.
    """
    starts = [m.start() for m in re.finditer(rf"(?m)^{re.escape(begin)}\r?$", text)]
    ends = [m.end() for m in re.finditer(rf"(?m)^{re.escape(end)}\r?$", text)]
    if not starts and not ends:
        return None
    if len(starts) != 1 or len(ends) != 1 or ends[0] <= starts[0]:
        raise InstallError("Ambiguous managed markers; no content removed")
    return starts[0], ends[0]
