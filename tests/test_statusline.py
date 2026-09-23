"""The status line is a sensor a person glances at, so every assertion is about
what they would read -- and a payload the engine has not filled in yet must still
read as a status line, never as a traceback."""

from __future__ import annotations

import io
import json
import re
from typing import Any

import pytest

from archon import statusline

ANSI = re.compile(r"\x1b\[[0-9;]*m")

FULL = {
    "model": {"id": "claude-opus-5-5[1m]", "display_name": "Opus 5.5 (1M context)"},
    "effort": {"level": "high"},
    "context_window": {"used_percentage": 50, "context_window_size": 1_000_000},
    "rate_limits": {
        "five_hour": {"used_percentage": 23.5, "resets_at": 1738425600},
        "seven_day": {"used_percentage": 41.2, "resets_at": 1738857600},
    },
}


def plain(payload: Any) -> str:
    return ANSI.sub("", statusline.render(payload))


def test_full_payload_reads_in_the_documented_order() -> None:
    text = plain(FULL)
    assert text.startswith(f" {statusline.HAT} │ Opus 5.5/high │ ")
    assert text.endswith(f" 50% │ {statusline.CLOCK} 76% │ {statusline.CALENDAR} 59% ")
    assert "[" not in text and "]" not in text


def test_sections_are_divided_by_dark_gray_rules_without_backgrounds() -> None:
    rendered = statusline.render(FULL)
    assert "\x1b[48;" not in rendered
    assert plain(FULL).count(statusline.DIVIDER) == 4
    assert f"{statusline._fg(statusline.DIVIDER_COLOUR)} {statusline.DIVIDER} " in rendered


def test_limits_show_what_is_left_not_what_was_used() -> None:
    payload = {**FULL, "rate_limits": {"five_hour": {"used_percentage": 100}, "seven_day": {"used_percentage": 0}}}
    text = plain(payload)
    assert f"{statusline.CLOCK} 0%" in text and f"{statusline.CALENDAR} 100%" in text


def test_bar_fills_in_proportion_to_context_used() -> None:
    empty = plain({**FULL, "context_window": {"used_percentage": 0}})
    full = plain({**FULL, "context_window": {"used_percentage": 100}})
    half = plain(FULL)
    assert statusline.FULL_CELL not in empty
    assert full.count(statusline.FULL_CELL) == statusline.WIDTH
    assert half.count(statusline.FULL_CELL) == statusline.WIDTH // 2


def test_bar_cells_carry_a_gradient_not_one_colour() -> None:
    colours = re.findall(r"\x1b\[38;2;(\d+;\d+;\d+)m" + statusline.FULL_CELL, statusline.render(
        {**FULL, "context_window": {"used_percentage": 100}}))
    assert len(colours) == statusline.WIDTH and len(set(colours)) > statusline.WIDTH // 2


@pytest.mark.parametrize("payload", [{}, None, [], {"model": "x", "context_window": {"used_percentage": None}},
                                     {"rate_limits": {"five_hour": {"used_percentage": "soon"}}}])
def test_missing_or_malformed_fields_degrade_to_dashes(payload: Any) -> None:
    text = plain(payload)
    assert text.startswith(f" {statusline.HAT} │ ") and text.endswith(" ")
    assert f"{statusline.CLOCK} --" in text and f"{statusline.CALENDAR} --" in text


def test_model_without_effort_shows_the_name_alone() -> None:
    assert "│ Sonnet 5 │" in plain({"model": {"display_name": "Sonnet 5"}})


def test_percentages_are_clamped() -> None:
    text = plain({"context_window": {"used_percentage": 140},
                  "rate_limits": {"five_hour": {"used_percentage": 130}, "seven_day": {"used_percentage": -5}}})
    assert " 100% │" in text and f"{statusline.CLOCK} 0%" in text and f"{statusline.CALENDAR} 100%" in text


def test_main_never_fails_on_garbage_input() -> None:
    out = io.StringIO()
    assert statusline.main(io.StringIO("not json{"), out) == 0
    assert ANSI.sub("", out.getvalue()).startswith(f" {statusline.HAT}")


def test_main_renders_stdin_payload() -> None:
    out = io.StringIO()
    assert statusline.main(io.StringIO(json.dumps(FULL)), out) == 0
    assert "Opus 5.5/high" in out.getvalue()
