"""The witchy status line: model, context, and subscription windows at a glance.

Claude Code pipes one JSON payload per render and shows whatever one line comes
back. This is a sensor, never a gate: nothing here decides anything, so a field
the engine has not filled in yet -- ``used_percentage`` is null before the first
response, ``rate_limits`` exists only under subscription auth -- reads as a dash
rather than an error the person has to decode. The payload shape is recorded in
``docs/research/2026-09-22-claude-code-platform.md`` section 5.
"""
from __future__ import annotations

import json
import math
import re
import sys
from typing import Any, TextIO

__all__ = ["main", "render"]

MAX_INPUT_BYTES = 1_048_576
# Unicode has no witch hat; the mage is the nearest single-codepoint glyph.
HAT = "🧙"
CLOCK = "🕐"
CALENDAR = "📅"
WIDTH = 12
FULL_CELL = "█"
PARTIAL_CELLS = " ▏▎▍▌▋▊▉"
EMPTY_CELL = "░"
DASH = "--"

RESET = "\x1b[0m"
BOLD = "\x1b[1m"
Colour = tuple[int, int, int]
# Sky blue -> periwinkle -> violet -> orchid, left to right along the bar.
GRADIENT: tuple[Colour, ...] = ((120, 190, 255), (140, 150, 255), (175, 125, 255), (215, 120, 245))
TRACK: Colour = (72, 72, 92)
SKY, VIOLET, ORCHID = GRADIENT[0], GRADIENT[2], GRADIENT[3]
MUTED: Colour = (140, 140, 165)
DIVIDER = "│"
DIVIDER_COLOUR: Colour = (88, 88, 108)


def _fg(rgb: Colour) -> str:
    return "\x1b[38;2;{};{};{}m".format(*rgb)


def _paint(text: str, rgb: Colour, *, bold: bool = False) -> str:
    return f"{BOLD if bold else ''}{_fg(rgb)}{text}{RESET}"


def _get(payload: Any, *path: str) -> Any:
    for name in path:
        if not isinstance(payload, dict):
            return None
        payload = payload.get(name)
    return payload


def _percent(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return min(100.0, max(0.0, float(value)))


def _blend(position: float) -> Colour:
    """The gradient colour at ``position`` in [0, 1]."""
    scaled = position * (len(GRADIENT) - 1)
    index = min(int(scaled), len(GRADIENT) - 2)
    low, high, t = GRADIENT[index], GRADIENT[index + 1], scaled - index
    return (round(low[0] + (high[0] - low[0]) * t), round(low[1] + (high[1] - low[1]) * t),
            round(low[2] + (high[2] - low[2]) * t))


def _model(payload: Any) -> str:
    name = _get(payload, "model", "display_name")
    name = re.sub(r"\s*\(.*\)\s*$", "", name) if isinstance(name, str) and name.strip() else DASH
    level = _get(payload, "effort", "level")
    label = f"{name}/{level}" if isinstance(level, str) and level else name
    return _paint(label, GRADIENT[1], bold=True)


def _bar(payload: Any) -> str:
    used = _percent(_get(payload, "context_window", "used_percentage"))
    eighths = round((used or 0.0) / 100 * WIDTH * 8)
    cells = []
    for index in range(WIDTH):
        fill = min(8, max(0, eighths - index * 8))
        colour = _blend(index / (WIDTH - 1))
        if fill == 8:
            cells.append(_fg(colour) + FULL_CELL)
        elif fill:
            cells.append(_fg(colour) + PARTIAL_CELLS[fill])
        else:
            cells.append(_fg(TRACK) + EMPTY_CELL)
    label = DASH if used is None else f"{round(used)}%"
    tip = _blend(min(1.0, (used or 0.0) / 100))
    return "".join(cells) + RESET + " " + _paint(label, tip, bold=True)


def _left(payload: Any, window: str, glyph: str) -> str:
    used = _percent(_get(payload, "rate_limits", window, "used_percentage"))
    if used is None:
        return f"{glyph} {_paint(DASH, MUTED)}"
    left = round(100 - used)
    colour = SKY if left > 50 else VIOLET if left > 20 else ORCHID
    return f"{glyph} {_paint(f'{left}%', colour, bold=left <= 20)}"


def render(payload: Any) -> str:
    """One status line for one engine payload; never raises on a malformed one."""
    parts = [HAT, _model(payload), _bar(payload), _left(payload, "five_hour", CLOCK),
             _left(payload, "seven_day", CALENDAR)]
    return " " + _paint(f" {DIVIDER} ", DIVIDER_COLOUR).join(parts) + " "


def main(stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> int:
    """Render stdin's payload. Always exit 0: a blank status line tells nobody anything."""
    try:
        payload = json.loads(stdin.read(MAX_INPUT_BYTES))
    except (ValueError, OSError):
        payload = None
    stdout.write(render(payload) + "\n")
    return 0
