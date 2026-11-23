#!/usr/bin/env python3
"""Ergon (ἔργον) — Local, SQLite-backed day planner.

Serves the planner on 127.0.0.1 and keeps three things true:
- Reminders fire as macOS notifications, whether or not a window is open
- Habits (repeating tasks) come back: finishing one schedules its next date, and a missed one moves on
- Tasks live in one table; a task's day and project decide which lists show it
"""

from __future__ import annotations

import argparse
import calendar
from contextlib import contextmanager
import json
import mimetypes
import os
import plistlib
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import uuid
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

APP_DIR = Path(__file__).resolve().parent
STATIC = APP_DIR / "static"
DB_PATH = APP_DIR / "ergon.sqlite3"
DEFAULT_PORT = 8001
LAUNCH_AGENT_LABEL = "local.ergon.server"
LAUNCH_AGENT_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCH_AGENT_LABEL}.plist"
LAUNCH_AGENT_LOG = Path.home() / "Library" / "Logs" / "Ergon" / "server.log"
NOTIFIER_SOURCE = APP_DIR / "notifier" / "main.swift"
NOTIFIER_APP = APP_DIR / "notifier" / "Ergon.app"
NOTIFIER_BINARY = NOTIFIER_APP / "Contents" / "MacOS" / "Ergon"
# Ergon's own Mac app; the notifier opens it by its id.
MAC_APP_SOURCE = APP_DIR / "mac" / "main.swift"
MAC_APP = Path.home() / "Applications" / "Ergon.app"
MAC_APP_ID = "local.ergon.app"
LSREGISTER = ("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework"
              "/Support/lsregister")
# How long a reminder waits on the notifier, and how long the installer gives you to answer macOS.
NOTIFIER_TIMEOUT_SECONDS = 20
INSTALL_PROMPT_TIMEOUT_SECONDS = 120

ID_RE = re.compile(r"^[0-9a-f-]{8,64}$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
REMINDER_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")
LINK_RE = re.compile(r"\[\[(https?:[^\]]+)\](?:\[([^\]]*)\])?\]")
# Long enough to count a whole month of a habit's days.
RECENT_DONE_DAYS = 32
DELETED_RETENTION_DAYS = 30
REPEAT_FREQUENCIES = ("DAILY", "WEEKLY", "MONTHLY", "YEARLY")
WEEKDAY_CODES = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")  # in date.weekday() order
MAX_REPEAT_INTERVAL = 99

TASK_FIELDS = ("id", "title", "project_id", "day", "day_rank", "list_rank",
               "remind_at", "reminded_at", "done_at", "repeat", "next_id", "series_id", "habit_rank", "overdue_rank",
               "minutes")
PROJECT_FIELDS = ("id", "title", "description", "rank", "completed_at")
BOX_FIELDS = ("id", "text", "x", "y")
ARROW_FIELDS = ("id", "from_id", "to_id")
MAX_BOX_TEXT = 2000
# Planning by time: how long a task takes, and the time a day has for tasks, both in minutes.
MAX_MINUTES = 24 * 60
# A couple of hours on weekdays, more on weekends, until you say otherwise.
DEFAULT_DAY_MINUTES = {"MO": 120, "TU": 120, "WE": 120, "TH": 120, "FR": 120, "SA": 300, "SU": 300}
# How far from the middle of the Goals map a box can go.
MAX_MAP_DISTANCE = 1_000_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    rank INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id),
    day TEXT,                                -- YYYY-MM-DD; NULL means unscheduled
    day_rank INTEGER NOT NULL DEFAULT 0,     -- order within the day
    list_rank INTEGER NOT NULL DEFAULT 0,    -- order within the project, or the inbox
    habit_rank INTEGER,                      -- order within Habits, while the task repeats
    overdue_rank INTEGER,                    -- order within Overdue, once moved there; NULL keeps it by day
    remind_at TEXT,                          -- local YYYY-MM-DDTHH:MM
    repeat TEXT,                             -- an RFC 5545 rule, e.g. FREQ=WEEKLY;BYDAY=MO,WE
    next_id TEXT,                            -- the task finishing this repeating one created
    series_id TEXT,                          -- shared by every date of a habit, finished or not
    minutes INTEGER,                         -- how long it takes, as planned; NULL when not said
    reminded_at TEXT,
    done_at TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL
);
-- The time there is for tasks on a day, when it isn't the default.
CREATE TABLE IF NOT EXISTS day_times (
    day TEXT PRIMARY KEY,                    -- YYYY-MM-DD for that day only, or MO … SU for every such weekday
    minutes INTEGER NOT NULL
);
-- Goals: a map of boxes of text, joined by arrows.
CREATE TABLE IF NOT EXISTS boxes (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    x REAL NOT NULL,                         -- where its top left corner is on the map
    y REAL NOT NULL,
    deleted_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS arrows (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES boxes(id),
    to_id TEXT NOT NULL REFERENCES boxes(id),
    deleted_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_day ON tasks(day);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS tasks_reminder ON tasks(remind_at) WHERE remind_at IS NOT NULL;
"""

reminders_changed = threading.Event()
# A notifier still waiting on the "allow notifications?" prompt.
awaiting_permission: subprocess.Popen | None = None


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _today() -> str:
    return date.today().isoformat()


@contextmanager
def _database():
    connection = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("BEGIN IMMEDIATE")
    try:
        yield connection
        connection.execute("COMMIT")
    except BaseException:
        connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


def initialize_database() -> None:
    connection = sqlite3.connect(DB_PATH, timeout=10)
    try:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(SCHEMA)
        # Columns added after a database was first made.
        for table, column in (("projects", "description TEXT NOT NULL DEFAULT ''"),
                              ("tasks", "repeat TEXT"), ("tasks", "next_id TEXT"), ("tasks", "series_id TEXT"),
                              ("tasks", "habit_rank INTEGER"), ("tasks", "overdue_rank INTEGER"),
                              ("tasks", "minutes INTEGER")):
            if not any(info[1] == column.split()[0] for info in connection.execute(f"PRAGMA table_info({table})")):
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {column}")
        # Habits made before Habits could be put in order go after the rest, soonest first.
        unranked = connection.execute("""
            SELECT id FROM tasks WHERE repeat IS NOT NULL AND habit_rank IS NULL AND done_at IS NULL AND deleted_at IS NULL
            ORDER BY day, day_rank
        """).fetchall()
        start = connection.execute("SELECT COALESCE(MAX(habit_rank), -1) + 1 FROM tasks").fetchone()[0]
        for offset, (task_id,) in enumerate(unranked):
            connection.execute("UPDATE tasks SET habit_rank = ? WHERE id = ?", (start + offset, task_id))
        # Unfinished tasks used to move to today, remembering the day they came from.
        # They go back to that day, where they now show as overdue.
        if any(info[1] == "carried_from" for info in connection.execute("PRAGMA table_info(tasks)")):
            connection.execute("UPDATE tasks SET day = carried_from WHERE carried_from IS NOT NULL AND done_at IS NULL")
            connection.execute("ALTER TABLE tasks DROP COLUMN carried_from")
        connection.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('revision', '0')")
        connection.commit()
    finally:
        connection.close()
    cutoff = (datetime.now() - timedelta(days=DELETED_RETENTION_DAYS)).isoformat(timespec="seconds")
    with _database() as connection:
        connection.execute("DELETE FROM tasks WHERE deleted_at < ?", (cutoff,))
        connection.execute("""
            DELETE FROM projects WHERE deleted_at < ?
              AND id NOT IN (SELECT project_id FROM tasks WHERE project_id IS NOT NULL)
        """, (cutoff,))
        connection.execute("""
            DELETE FROM arrows WHERE deleted_at < ?
               OR from_id IN (SELECT id FROM boxes WHERE deleted_at < ?) OR to_id IN (SELECT id FROM boxes WHERE deleted_at < ?)
        """, (cutoff, cutoff, cutoff))
        connection.execute("DELETE FROM boxes WHERE deleted_at < ?", (cutoff,))


def _touch(connection: sqlite3.Connection) -> None:
    connection.execute("UPDATE meta SET value = value + 1 WHERE key = 'revision'")


def _state_tag(connection: sqlite3.Connection) -> str:
    revision = connection.execute("SELECT value FROM meta WHERE key = 'revision'").fetchone()["value"]
    return f"{revision}:{_today()}"


def _next_rank(connection: sqlite3.Connection, column: str, where: str, *params) -> int:
    # Finished tasks keep their places, so a new task goes below them too.
    row = connection.execute(
        f"SELECT COALESCE(MAX({column}), -1) + 1 AS rank FROM tasks "
        f"WHERE {where} AND deleted_at IS NULL", params,
    ).fetchone()
    return row["rank"]


def _next_day_rank(connection: sqlite3.Connection, day: str) -> int:
    return _next_rank(connection, "day_rank", "day = ?", day)


def _next_habit_rank(connection: sqlite3.Connection) -> int:
    return _next_rank(connection, "habit_rank", "repeat IS NOT NULL")


def _next_list_rank(connection: sqlite3.Connection, project_id: str | None) -> int:
    if project_id:
        return _next_rank(connection, "list_rank", "project_id = ?", project_id)
    return _next_rank(connection, "list_rank", "project_id IS NULL AND day IS NULL")


def _parse_rule(text: str) -> dict:
    """Reads the part of RFC 5545 repeat rules that Ergon writes, such as FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE.
    TIMES is Ergon's own, for habits done some number of times a week or month on any days: FREQ=WEEKLY;TIMES=6."""
    rule = {"freq": "", "interval": 1, "by_day": [], "by_month_day": [], "set_pos": 0, "week_start": 0, "until": None,
            "times": 0}
    try:
        for part in text.split(";"):
            key, value = part.split("=")
            if key == "FREQ" and value in REPEAT_FREQUENCIES:
                rule["freq"] = value
            elif key == "INTERVAL" and value.isdigit() and 1 <= int(value) <= MAX_REPEAT_INTERVAL:
                rule["interval"] = int(value)
            elif key == "BYDAY":
                rule["by_day"] = sorted({WEEKDAY_CODES.index(code) for code in value.split(",")})
            elif key == "BYMONTHDAY":
                rule["by_month_day"] = sorted({int(number) for number in value.split(",")})
            elif key == "BYSETPOS":
                rule["set_pos"] = int(value)
            elif key == "WKST":
                rule["week_start"] = WEEKDAY_CODES.index(value)
            elif key == "TIMES" and value.isdigit() and int(value) >= 1:
                rule["times"] = int(value)
            elif key == "UNTIL" and re.fullmatch(r"\d{8}", value):
                rule["until"] = date(int(value[:4]), int(value[4:6]), int(value[6:]))
            else:
                raise ValueError(part)
    except ValueError as error:
        raise ValueError("That is not a repeat Ergon understands.") from error
    freq, by_day, by_month_day, set_pos = rule["freq"], rule["by_day"], rule["by_month_day"], rule["set_pos"]
    # Weekdays pick days in a week, or with a position ("the last weekday") one day in a month.
    valid = (freq
             and (not by_day or freq == "WEEKLY" or set_pos)
             and (not set_pos or (freq == "MONTHLY" and by_day and 1 <= abs(set_pos) <= 5))
             and (not by_month_day or (freq == "MONTHLY" and not by_day))
             and all(1 <= abs(number) <= 31 for number in by_month_day)
             and (not rule["times"] or (rule["interval"] == 1 and not by_day and not by_month_day
                                        and 1 <= rule["times"] <= {"WEEKLY": 7, "MONTHLY": 31}.get(freq, 0))))
    if not valid:
        raise ValueError("That is not a repeat Ergon understands.")
    return rule


def _occurs_on(rule: dict, anchor: date, day: date) -> bool:
    """Whether a rule, counted from `anchor` (one of its dates), falls on `day`."""
    interval = rule["interval"]
    # A habit done some times a week or month can be done on any day.
    if rule["times"]:
        return True
    if rule["freq"] == "DAILY":
        return (day - anchor).days % interval == 0
    if rule["freq"] == "WEEKLY":
        def week_of(value: date) -> date:
            return value - timedelta(days=(value.weekday() - rule["week_start"]) % 7)
        weekdays = rule["by_day"] or [anchor.weekday()]
        return (week_of(day) - week_of(anchor)).days // 7 % interval == 0 and day.weekday() in weekdays
    if rule["freq"] == "YEARLY":
        return (day.year - anchor.year) % interval == 0 and (day.month, day.day) == (anchor.month, anchor.day)
    if ((day.year - anchor.year) * 12 + day.month - anchor.month) % interval:
        return False
    length = calendar.monthrange(day.year, day.month)[1]
    if rule["set_pos"]:
        matching = [number for number in range(1, length + 1)
                    if date(day.year, day.month, number).weekday() in rule["by_day"]]
        position = rule["set_pos"] - 1 if rule["set_pos"] > 0 else rule["set_pos"]
        return -len(matching) <= position < len(matching) and matching[position] == day.day
    # As in Apple's apps, a month without the day (the 31st, say) is skipped.
    month_days = rule["by_month_day"] or [anchor.day]
    return day.day in {number if number > 0 else length + 1 + number for number in month_days}


def _first_occurrence(rule: dict, anchor: date, start: date) -> date | None:
    """The rule's first date on or after `start`, or None once it has ended."""
    for offset in range(366 * (8 + rule["interval"])):
        day = start + timedelta(days=offset)
        if rule["until"] and day > rule["until"]:
            return None
        if _occurs_on(rule, anchor, day):
            return day
    return None


def _period(rule: dict, day: date) -> tuple[date, date]:
    """The first and last day of the week or month holding `day`, for counting a habit's times."""
    if rule["freq"] == "WEEKLY":
        start = day - timedelta(days=(day.weekday() - rule["week_start"]) % 7)
        return start, start + timedelta(days=6)
    return day.replace(day=1), day.replace(day=calendar.monthrange(day.year, day.month)[1])


def _moved_day(task, day: date) -> dict:
    """A task moved to `day`, taking its reminder along at the same time of day."""
    fields = {"day": day.isoformat()}
    if task["remind_at"]:
        remind_at = datetime.fromisoformat(task["remind_at"]) + (day - date.fromisoformat(task["day"]))
        fields["remind_at"] = remind_at.strftime("%Y-%m-%dT%H:%M")
        # A reminder whose time has already passed counts as sent, rather than going off late.
        fields["reminded_at"] = _now() if remind_at <= datetime.now() else None
    return fields


def _advance(connection: sqlite3.Connection, task, finishing: bool = True) -> dict | None:
    """The day and reminder of a repeating task's next date, or None once it has ended. The next date is
    never in the past. A habit done some times a week or month comes back the next day until it has
    been done that many times, then on the first day of the next week or month."""
    rule = _parse_rule(task["repeat"])
    due = date.fromisoformat(task["day"])
    if rule["times"]:
        start, end = _period(rule, due)
        done = connection.execute("""
            SELECT COUNT(*) AS count FROM tasks
            WHERE series_id = ? AND id != ? AND done_at IS NOT NULL AND deleted_at IS NULL AND day BETWEEN ? AND ?
        """, (task["series_id"], task["id"], start.isoformat(), end.isoformat())).fetchone()["count"] + finishing
        day = max(due + timedelta(days=1) if done < rule["times"] else end + timedelta(days=1), date.today())
        if rule["until"] and day > rule["until"]:
            return None
    else:
        day = _first_occurrence(rule, due, max(due + timedelta(days=1), date.today()))
    return None if day is None else _moved_day(task, day)


def _repeat_task(connection: sqlite3.Connection, task: dict, next_id: str) -> bool:
    """Adds the next date of a repeating task as a task of its own, in the same place in its project."""
    advanced = _advance(connection, task)
    if advanced is None:
        return False
    connection.execute("""
        INSERT INTO tasks (id, title, project_id, day, day_rank, list_rank, habit_rank, remind_at, reminded_at, repeat,
                           series_id, minutes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (next_id, task["title"], task["project_id"], advanced["day"], _next_day_rank(connection, advanced["day"]),
          task["list_rank"], task["habit_rank"], advanced.get("remind_at"), advanced.get("reminded_at"), task["repeat"],
          task["series_id"] or task["id"], task["minutes"], _now()))
    return True


def _catch_up(connection: sqlite3.Connection) -> None:
    """A habit still undone when its next date comes moves on to that date, so a missed day is let go
    rather than piling up. One done some times a week or month moves to each new day until it is done."""
    today = date.today()
    missed = connection.execute("""
        SELECT * FROM tasks WHERE repeat IS NOT NULL AND day < ? AND done_at IS NULL AND deleted_at IS NULL
    """, (today.isoformat(),)).fetchall()
    moved = False
    for task in missed:
        rule = _parse_rule(task["repeat"])
        due = date.fromisoformat(task["day"])
        latest = today if rule["times"] else None
        following = None if rule["times"] else _first_occurrence(rule, due, due + timedelta(days=1))
        while following and following <= today:
            latest = following
            following = _first_occurrence(rule, latest, latest + timedelta(days=1))
        if latest is None:
            continue
        changes = {**_moved_day(task, latest), "day_rank": _next_day_rank(connection, latest.isoformat())}
        assignments = ", ".join(f"{column} = ?" for column in changes)
        connection.execute(f"UPDATE tasks SET {assignments} WHERE id = ?", (*changes.values(), task["id"]))
        moved = True
    if moved:
        _touch(connection)


def _state() -> dict:
    cutoff = (datetime.now() - timedelta(days=RECENT_DONE_DAYS)).isoformat(timespec="seconds")
    with _database() as connection:
        _catch_up(connection)
        projects = connection.execute(
            f"SELECT {', '.join(PROJECT_FIELDS)} FROM projects WHERE deleted_at IS NULL ORDER BY rank, created_at"
        ).fetchall()
        tasks = connection.execute(f"""
            SELECT {', '.join(TASK_FIELDS)} FROM tasks
            WHERE deleted_at IS NULL
              AND (done_at IS NULL OR done_at >= ? OR project_id IS NOT NULL)
        """, (cutoff,)).fetchall()
        boxes = connection.execute(
            f"SELECT {', '.join(BOX_FIELDS)} FROM boxes WHERE deleted_at IS NULL ORDER BY created_at"
        ).fetchall()
        arrows = connection.execute(f"""
            SELECT {', '.join(f"arrows.{field}" for field in ARROW_FIELDS)} FROM arrows
            JOIN boxes AS source ON source.id = arrows.from_id JOIN boxes AS target ON target.id = arrows.to_id
            WHERE arrows.deleted_at IS NULL AND source.deleted_at IS NULL AND target.deleted_at IS NULL
            ORDER BY arrows.created_at
        """).fetchall()
        times = dict(connection.execute("SELECT day, minutes FROM day_times").fetchall())
        return {
            "tag": _state_tag(connection),
            "today": _today(),
            "projects": [dict(row) for row in projects],
            "tasks": [dict(row) for row in tasks],
            "boxes": [dict(row) for row in boxes],
            "arrows": [dict(row) for row in arrows],
            "time": {
                "weekdays": {code: times.get(code, minutes) for code, minutes in DEFAULT_DAY_MINUTES.items()},
                "days": {day: minutes for day, minutes in times.items() if day not in DEFAULT_DAY_MINUTES},
            },
        }


def _state_tag_now() -> str:
    with _database() as connection:
        _catch_up(connection)
        return _state_tag(connection)


def _valid_id(value) -> str:
    if not isinstance(value, str) or not ID_RE.match(value):
        raise ValueError("Invalid id.")
    return value


def _valid_title(value) -> str:
    title = " ".join(value.split()) if isinstance(value, str) else ""
    if not title:
        raise ValueError("A title is required.")
    return title


def _valid_day(value) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not DAY_RE.match(value):
        raise ValueError("Days are written YYYY-MM-DD.")
    date.fromisoformat(value)
    return value


def _valid_reminder(value) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not REMINDER_RE.match(value):
        raise ValueError("Reminders are written YYYY-MM-DDTHH:MM.")
    datetime.fromisoformat(value)
    return value


def _valid_rule(value) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 200:
        raise ValueError("That is not a repeat Ergon understands.")
    _parse_rule(value)
    return value


def _valid_minutes(value, least: int = 1) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not least <= value <= MAX_MINUTES:
        raise ValueError(f"A time is a whole number of minutes, from {least} to {MAX_MINUTES}.")
    return value


def _valid_project(connection: sqlite3.Connection, value) -> str | None:
    if value is None:
        return None
    project = connection.execute(
        "SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL", (_valid_id(value),)
    ).fetchone()
    if project is None:
        raise ValueError("That project does not exist.")
    return project["id"]


def _parse_list(connection: sqlite3.Connection, value) -> tuple[str | None, str | None]:
    """Returns the (day, project_id) a list name refers to: inbox, day:…, or project:…."""
    if value == "inbox":
        return None, None
    kind, _, name = value.partition(":") if isinstance(value, str) else ("", "", "")
    if kind == "day":
        return _valid_day(name), None
    if kind == "project":
        return None, _valid_project(connection, name)
    raise ValueError("Unknown list.")


def _create_task(payload: dict) -> None:
    task_id = _valid_id(payload.get("id"))
    title = _valid_title(payload.get("title"))
    minutes = None if payload.get("minutes") is None else _valid_minutes(payload["minutes"])
    with _database() as connection:
        day, project_id = _parse_list(connection, payload.get("list"))
        connection.execute("""
            INSERT INTO tasks (id, title, project_id, day, day_rank, list_rank, minutes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (task_id, title, project_id, day,
              _next_day_rank(connection, day) if day else 0,
              0 if day else _next_list_rank(connection, project_id),
              minutes, _now()))
        # A habit starts as a task with a repeat.
        if "repeat" in payload:
            _change_task(connection, task_id, {"repeat": payload["repeat"]})
        _touch(connection)


def _update_task(task_id: str, payload: dict) -> None:
    with _database() as connection:
        _change_task(connection, task_id, payload)
    reminders_changed.set()


def _change_task(connection: sqlite3.Connection, task_id: str, payload: dict) -> None:
    # Finishing or skipping counts from where a missed habit is now, not from the day it was missed.
    _catch_up(connection)
    task = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if task is None:
        raise LookupError("That task does not exist.")
    changes: dict = {}
    if "title" in payload:
        changes["title"] = _valid_title(payload["title"])
    if "day" in payload:
        changes["day"] = _valid_day(payload["day"])
    if "project_id" in payload:
        changes["project_id"] = _valid_project(connection, payload["project_id"])
    if "remind_at" in payload:
        changes["remind_at"] = _valid_reminder(payload["remind_at"])
        changes["reminded_at"] = None
    if "minutes" in payload:
        changes["minutes"] = None if payload["minutes"] is None else _valid_minutes(payload["minutes"])
    if payload.get("skip") and task["repeat"] and not task["done_at"]:
        advanced = _advance(connection, task, finishing=False)
        if advanced is None:
            raise ValueError("This task does not repeat again.")
        changes.update(advanced)
    if "repeat" in payload:
        changes["repeat"] = _valid_rule(payload["repeat"])
        if changes["repeat"]:
            # A repeating task is on its first date, counted from its day, or from today if it has none.
            # A habit done any days of the week starts no earlier than today.
            rule = _parse_rule(changes["repeat"])
            start = date.fromisoformat(changes.get("day", task["day"]) or _today())
            if rule["times"]:
                start = max(start, date.today())
            first = _first_occurrence(rule, start, start)
            if first is None:
                raise ValueError("That repeat has no dates left.")
            changes["day"] = first.isoformat()
            changes["series_id"] = task["series_id"] or task_id
            if task["habit_rank"] is None:
                changes["habit_rank"] = _next_habit_rank(connection)
    if "done" in payload:
        changes["done_at"] = _now() if payload["done"] else None
        current = {**dict(task), **changes}
        if payload["done"] and not task["done_at"] and current["repeat"] and current["day"]:
            next_id = _valid_id(payload["next_id"]) if "next_id" in payload else str(uuid.uuid4())
            if not current["series_id"]:
                changes["series_id"] = current["series_id"] = task_id
            # The repeat moves on to the next date, so only one open task carries it.
            if _repeat_task(connection, current, next_id):
                changes.update(repeat=None, next_id=next_id)
        elif not payload["done"] and task["done_at"] and task["next_id"]:
            # Reopening takes back the next date, unless that has been finished too.
            following = connection.execute("SELECT repeat, done_at, deleted_at FROM tasks WHERE id = ?",
                                           (task["next_id"],)).fetchone()
            if following and not following["done_at"] and not following["deleted_at"]:
                connection.execute("DELETE FROM tasks WHERE id = ?", (task["next_id"],))
                changes["repeat"] = following["repeat"]
            changes["next_id"] = None
    if "deleted" in payload:
        changes["deleted_at"] = _now() if payload["deleted"] else None

    day = changes.get("day", task["day"])
    project_id = changes.get("project_id", task["project_id"])
    # A repeat counts from a day, so a task taken off its day stops repeating, and leaves Habits.
    if not day and changes.get("repeat", task["repeat"]):
        changes["repeat"] = None
    if ("repeat" in payload or not day) and not changes.get("repeat", task["repeat"]):
        changes["habit_rank"] = None
    if day and day != task["day"]:
        changes["day_rank"] = _next_day_rank(connection, day)
    # A task given another day leaves Overdue, so its place there goes too.
    if day != task["day"]:
        changes["overdue_rank"] = None
    entered_inbox = not project_id and not day and (task["project_id"] or task["day"])
    if project_id != task["project_id"] or entered_inbox:
        changes["list_rank"] = _next_list_rank(connection, project_id)

    if changes:
        assignments = ", ".join(f"{column} = ?" for column in changes)
        connection.execute(f"UPDATE tasks SET {assignments} WHERE id = ?", (*changes.values(), task_id))
        _touch(connection)


def _create_project(payload: dict) -> None:
    project_id = _valid_id(payload.get("id"))
    title = _valid_title(payload.get("title"))
    with _database() as connection:
        rank = connection.execute(
            "SELECT COALESCE(MAX(rank), -1) + 1 AS rank FROM projects WHERE deleted_at IS NULL"
        ).fetchone()["rank"]
        connection.execute("INSERT INTO projects (id, title, rank, created_at) VALUES (?, ?, ?, ?)",
                           (project_id, title, rank, _now()))
        _touch(connection)


def _update_project(project_id: str, payload: dict) -> None:
    with _database() as connection:
        project = connection.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if project is None:
            raise LookupError("That project does not exist.")
        if "title" in payload:
            connection.execute("UPDATE projects SET title = ? WHERE id = ?",
                               (_valid_title(payload["title"]), project_id))
        if "description" in payload:
            if not isinstance(payload["description"], str):
                raise ValueError("A description must be text.")
            connection.execute("UPDATE projects SET description = ? WHERE id = ?",
                               (payload["description"].strip(), project_id))
        if "completed" in payload:
            connection.execute("UPDATE projects SET completed_at = ? WHERE id = ?",
                               (_now() if payload["completed"] else None, project_id))
        if payload.get("deleted") is True:
            # Tasks share the project's timestamp so restoring brings back exactly these.
            now = _now()
            connection.execute("UPDATE projects SET deleted_at = ? WHERE id = ?", (now, project_id))
            connection.execute("UPDATE tasks SET deleted_at = ? WHERE project_id = ? AND deleted_at IS NULL",
                               (now, project_id))
        elif payload.get("deleted") is False and project["deleted_at"]:
            connection.execute("UPDATE projects SET deleted_at = NULL WHERE id = ?", (project_id,))
            connection.execute("UPDATE tasks SET deleted_at = NULL WHERE project_id = ? AND deleted_at = ?",
                               (project_id, project["deleted_at"]))
        _touch(connection)
    reminders_changed.set()


def _set_order(payload: dict) -> None:
    """Makes `ids` the contents of a list, in order; ids from other lists move into it."""
    ids = payload.get("ids")
    if not isinstance(ids, list):
        raise ValueError("Expected a list of ids.")
    ids = [_valid_id(value) for value in ids]
    with _database() as connection:
        if payload.get("list") == "projects":
            for rank, project_id in enumerate(ids):
                connection.execute("UPDATE projects SET rank = ? WHERE id = ?", (rank, project_id))
        elif payload.get("list") in ("habits", "overdue"):
            # These lists hold tasks from many days, so each keeps its own order.
            column = {"habits": "habit_rank", "overdue": "overdue_rank"}[payload["list"]]
            for rank, task_id in enumerate(ids):
                connection.execute(f"UPDATE tasks SET {column} = ? WHERE id = ?", (rank, task_id))
        else:
            day, project_id = _parse_list(connection, payload.get("list"))
            for rank, task_id in enumerate(ids):
                if day:
                    connection.execute("""
                        UPDATE tasks SET overdue_rank = CASE WHEN day = ? THEN overdue_rank END, day = ?, day_rank = ?
                        WHERE id = ?""", (day, day, rank, task_id))
                elif project_id:
                    connection.execute("UPDATE tasks SET project_id = ?, list_rank = ? WHERE id = ?",
                                       (project_id, rank, task_id))
                else:
                    connection.execute(
                        "UPDATE tasks SET project_id = NULL, day = NULL, repeat = NULL, habit_rank = NULL, overdue_rank = NULL, "
                        "list_rank = ? WHERE id = ?",
                        (rank, task_id))
        _touch(connection)


def _set_day_time(payload: dict) -> None:
    """Sets the time there is for tasks on every such weekday (MO … SU), or on one day; for a day,
    None goes back to its weekday's time."""
    day, minutes = payload.get("day"), payload.get("minutes")
    if day not in DEFAULT_DAY_MINUTES:
        day = _valid_day(day)
        if day is None:
            raise ValueError("Say which day, or which weekday.")
    with _database() as connection:
        if minutes is None and day not in DEFAULT_DAY_MINUTES:
            connection.execute("DELETE FROM day_times WHERE day = ?", (day,))
        else:
            connection.execute("INSERT OR REPLACE INTO day_times (day, minutes) VALUES (?, ?)",
                               (day, _valid_minutes(minutes, least=0)))
        _touch(connection)


def _valid_text(value) -> str:
    """A box's text, which unlike a title can run over several lines."""
    lines = [line.strip() for line in value.strip().splitlines()] if isinstance(value, str) else []
    text = "\n".join(lines)
    if not text:
        raise ValueError("A box needs some text.")
    if len(text) > MAX_BOX_TEXT:
        raise ValueError(f"A box holds at most {MAX_BOX_TEXT} characters.")
    return text


def _valid_place(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not abs(value) <= MAX_MAP_DISTANCE:
        raise ValueError("That is not a place on the map.")
    return float(value)


def _create_box(payload: dict) -> None:
    box_id = _valid_id(payload.get("id"))
    text = _valid_text(payload.get("text"))
    x, y = _valid_place(payload.get("x")), _valid_place(payload.get("y"))
    with _database() as connection:
        connection.execute("INSERT INTO boxes (id, text, x, y, created_at) VALUES (?, ?, ?, ?, ?)",
                           (box_id, text, x, y, _now()))
        _touch(connection)


def _update_box(box_id: str, payload: dict) -> None:
    with _database() as connection:
        box = connection.execute("SELECT * FROM boxes WHERE id = ?", (box_id,)).fetchone()
        if box is None:
            raise LookupError("That box does not exist.")
        if "text" in payload:
            connection.execute("UPDATE boxes SET text = ? WHERE id = ?", (_valid_text(payload["text"]), box_id))
        if "x" in payload or "y" in payload:
            connection.execute("UPDATE boxes SET x = ?, y = ? WHERE id = ?", (
                _valid_place(payload.get("x", box["x"])), _valid_place(payload.get("y", box["y"])), box_id))
        if payload.get("deleted") is True:
            # Its arrows share its timestamp, so restoring it brings back exactly these. It's to the
            # microsecond, so an arrow deleted on its own a moment before stays deleted.
            now = datetime.now().isoformat(timespec="microseconds")
            connection.execute("UPDATE boxes SET deleted_at = ? WHERE id = ?", (now, box_id))
            connection.execute("""
                UPDATE arrows SET deleted_at = ? WHERE (from_id = ? OR to_id = ?) AND deleted_at IS NULL
            """, (now, box_id, box_id))
        elif payload.get("deleted") is False and box["deleted_at"]:
            connection.execute("UPDATE boxes SET deleted_at = NULL WHERE id = ?", (box_id,))
            connection.execute("UPDATE arrows SET deleted_at = NULL WHERE (from_id = ? OR to_id = ?) AND deleted_at = ?",
                               (box_id, box_id, box["deleted_at"]))
        _touch(connection)


def _create_arrow(payload: dict) -> None:
    arrow_id = _valid_id(payload.get("id"))
    start, end = _valid_id(payload.get("from_id")), _valid_id(payload.get("to_id"))
    if start == end:
        raise ValueError("An arrow joins two different boxes.")
    with _database() as connection:
        found = connection.execute("SELECT COUNT(*) FROM boxes WHERE id IN (?, ?) AND deleted_at IS NULL",
                                   (start, end)).fetchone()[0]
        if found != 2:
            raise LookupError("That box does not exist.")
        # Two boxes are joined once, whichever way the arrow points.
        if connection.execute("""
            SELECT 1 FROM arrows WHERE deleted_at IS NULL
              AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
        """, (start, end, end, start)).fetchone():
            raise ValueError("Those boxes are already joined.")
        connection.execute("INSERT INTO arrows (id, from_id, to_id, created_at) VALUES (?, ?, ?, ?)",
                           (arrow_id, start, end, _now()))
        _touch(connection)


def _update_arrow(arrow_id: str, payload: dict) -> None:
    with _database() as connection:
        if connection.execute("SELECT 1 FROM arrows WHERE id = ?", (arrow_id,)).fetchone() is None:
            raise LookupError("That arrow does not exist.")
        if "deleted" in payload:
            connection.execute("UPDATE arrows SET deleted_at = ? WHERE id = ?",
                               (_now() if payload["deleted"] else None, arrow_id))
        _touch(connection)


def _send_with_notifier(title: str, body: str, timeout: float = NOTIFIER_TIMEOUT_SECONDS) -> bool:
    global awaiting_permission
    if not NOTIFIER_BINARY.exists():
        return False
    if awaiting_permission is not None:
        if awaiting_permission.poll() is None:
            return False
        awaiting_permission = None
    try:
        process = subprocess.Popen([str(NOTIFIER_BINARY), title, body], stderr=subprocess.PIPE, text=True)
    except OSError as error:
        print(f"{_now()} Could not start Ergon.app: {error}", flush=True)
        return False
    try:
        _, errors = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        # Never kill it here: that withdraws the prompt, and macOS then refuses
        # this app without asking again. It finishes when the prompt is answered.
        awaiting_permission = process
        print(f"{_now()} Ergon.app is waiting for notifications to be allowed", flush=True)
        return False
    if process.returncode != 0:
        print(f"{_now()} Ergon.app exited with {process.returncode}: {errors.strip()}", flush=True)
    return process.returncode == 0


def _send_with_osascript(title: str, body: str) -> bool:
    # Arguments, not string interpolation: task titles can contain quotes.
    script = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv) sound name "default"\nend run'
    try:
        result = subprocess.run(["osascript", "-e", script, title, body], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"{_now()} osascript failed: {error}", flush=True)
        return False
    return result.returncode == 0


def send_notification(title: str, body: str) -> bool:
    return _send_with_notifier(title, body) or _send_with_osascript(title, body)


def _reminder_body(project: str | None, remind_at: str, now: datetime) -> str:
    scheduled = datetime.fromisoformat(remind_at)
    parts = [project] if project else []
    if now - scheduled >= timedelta(minutes=5):
        # The Mac was probably asleep; say when this was meant to arrive.
        parts.append(f"Set for {scheduled:%a %-d %b, %H:%M}")
    return " · ".join(parts)


def _plain_text(title: str) -> str:
    """A title as a notification shows it: links by their label, not their markup."""
    return LINK_RE.sub(lambda match: match.group(2) or match.group(1), title)


def send_due_reminders() -> None:
    now = datetime.now()
    with _database() as connection:
        # A missed habit moves on even with no window open, so today's reminder for it goes off.
        _catch_up(connection)
        due = connection.execute("""
            SELECT tasks.id, tasks.title, tasks.remind_at, projects.title AS project
            FROM tasks LEFT JOIN projects ON projects.id = tasks.project_id
            WHERE tasks.remind_at <= ? AND tasks.reminded_at IS NULL
              AND tasks.done_at IS NULL AND tasks.deleted_at IS NULL
            ORDER BY tasks.remind_at
        """, (now.strftime("%Y-%m-%dT%H:%M"),)).fetchall()
    for reminder in due:
        # A reminder that could not be delivered stays due and is retried next minute.
        if not send_notification(_plain_text(reminder["title"]), _reminder_body(reminder["project"], reminder["remind_at"], now)):
            print(f"{_now()} Could not deliver the reminder for task {reminder['id']}", flush=True)
            continue
        with _database() as connection:
            connection.execute("UPDATE tasks SET reminded_at = ? WHERE id = ? AND remind_at = ?",
                               (_now(), reminder["id"], reminder["remind_at"]))
            _touch(connection)


def _watch_reminders() -> None:
    while True:
        try:
            send_due_reminders()
        except Exception as error:  # The watcher must outlive any one bad pass.
            print(f"{_now()} Reminder check failed: {error}", flush=True)
        # Reminders are set to the minute, so check as each minute starts.
        reminders_changed.wait(60 - datetime.now().second)
        reminders_changed.clear()


def _read_json_body(handler: BaseHTTPRequestHandler) -> dict:
    raw_length = handler.headers.get("Content-Length", "0")
    try:
        length = int(raw_length)
    except ValueError as error:
        raise ValueError("Invalid request length.") from error
    if length < 0 or length > 1024 * 1024:
        raise OverflowError("Request is too large (maximum 1 MB).")
    try:
        payload = json.loads(handler.rfile.read(length).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Request body must be valid JSON.") from error
    if not isinstance(payload, dict):
        raise ValueError("Request body must be a JSON object.")
    return payload


class ErgonHandler(BaseHTTPRequestHandler):
    server_version = "Ergon/1.0"

    def log_message(self, format: str, *args) -> None:
        if getattr(self.server, "verbose", False):
            super().log_message(format, *args)

    def _send_bytes(self, body: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _send_json(self, value, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self._send_bytes(body, "application/json; charset=utf-8", status)

    def _error(self, message: str, status: int = 400) -> None:
        self._send_json({"error": message}, status)

    def _is_local_request(self) -> bool:
        # The server has no login, so web pages must not be able to reach it:
        # the Host check stops DNS rebinding, the Origin check stops cross-site writes.
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        name = host.rsplit(":", 1)[0]
        return name in {"127.0.0.1", "localhost"} and origin in {None, f"http://{host}"}

    def _serve_static(self, relative: str) -> None:
        path = (STATIC / relative).resolve()
        if not path.is_relative_to(STATIC) or not path.is_file():
            self._error("Not found", 404)
            return
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix == ".webmanifest":
            content_type = "application/manifest+json"
        elif content_type.startswith("text/") or content_type == "application/javascript":
            content_type += "; charset=utf-8"
        self._send_bytes(path.read_bytes(), content_type)

    def do_GET(self) -> None:  # noqa: N802
        if not self._is_local_request():
            self._error("Forbidden", 403)
            return
        parsed = urlsplit(self.path)
        if parsed.path in {"/", "/index.html"}:
            self._serve_static("index.html")
        elif parsed.path == "/favicon.ico":
            self._serve_static("favicon.svg")
        elif parsed.path.startswith("/static/"):
            self._serve_static(unquote(parsed.path.removeprefix("/static/")))
        elif parsed.path == "/api/state":
            known = parse_qs(parsed.query).get("tag", [""])[0]
            if known and known == _state_tag_now():
                self._send_bytes(b"", "text/plain", 204)
            else:
                self._send_json(_state())
        else:
            self._error("Not found", 404)

    def _write(self, action) -> None:
        if not self._is_local_request():
            self._error("Forbidden", 403)
            return
        try:
            action(_read_json_body(self))
        except OverflowError as error:
            self._error(str(error), 413)
        except LookupError as error:
            self._error(str(error), 404)
        except (ValueError, sqlite3.IntegrityError) as error:
            self._error(str(error), 400)
        else:
            self._send_json({"ok": True})

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path == "/api/tasks":
            self._write(_create_task)
        elif path == "/api/projects":
            self._write(_create_project)
        elif path == "/api/order":
            self._write(_set_order)
        elif path == "/api/boxes":
            self._write(_create_box)
        elif path == "/api/arrows":
            self._write(_create_arrow)
        else:
            self._error("Not found", 404)

    def do_PATCH(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path.startswith("/api/tasks/"):
            task_id = path.removeprefix("/api/tasks/")
            self._write(lambda payload: _update_task(task_id, payload))
        elif path.startswith("/api/projects/"):
            project_id = path.removeprefix("/api/projects/")
            self._write(lambda payload: _update_project(project_id, payload))
        elif path.startswith("/api/boxes/"):
            box_id = path.removeprefix("/api/boxes/")
            self._write(lambda payload: _update_box(box_id, payload))
        elif path.startswith("/api/arrows/"):
            arrow_id = path.removeprefix("/api/arrows/")
            self._write(lambda payload: _update_arrow(arrow_id, payload))
        elif path == "/api/time":
            self._write(_set_day_time)
        else:
            self._error("Not found", 404)


def _build_notifier(host: str, port: int) -> bool:
    """Compiles the small app macOS needs to show notifications under Ergon's name."""
    if shutil.which("swiftc") is None:
        print("swiftc was not found, so reminders will appear as Script Editor notifications. "
              "Run `xcode-select --install` and install again to use Ergon's own.")
        return False
    contents = NOTIFIER_APP / "Contents"
    resources = contents / "Resources"
    shutil.rmtree(NOTIFIER_APP, ignore_errors=True)
    (contents / "MacOS").mkdir(parents=True)
    resources.mkdir()
    compiled = subprocess.run(["swiftc", "-O", str(NOTIFIER_SOURCE), "-o", str(NOTIFIER_BINARY)],
                              capture_output=True, text=True)
    if compiled.returncode != 0:
        print(f"Could not compile the notifier:\n{compiled.stderr.strip()}")
        shutil.rmtree(NOTIFIER_APP, ignore_errors=True)
        return False
    _make_icon(resources)
    (contents / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleIdentifier": "local.ergon.reminders",
        "CFBundleName": "Ergon",
        "CFBundleDisplayName": "Ergon",
        "CFBundleExecutable": NOTIFIER_BINARY.name,
        "CFBundleIconFile": "Ergon",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "1.0",
        "CFBundleVersion": "1",
        "LSUIElement": True,
        "ErgonURL": f"http://{host}:{port}/",
    }))
    signed = subprocess.run(["codesign", "--force", "--sign", "-", str(NOTIFIER_APP)], capture_output=True, text=True)
    if signed.returncode != 0:
        print(f"Could not sign the notifier: {signed.stderr.strip()}")
        return False
    subprocess.run([LSREGISTER, "-f", str(NOTIFIER_APP)], capture_output=True)
    return True


def _make_icon(resources: Path) -> None:
    """Draws Ergon.icns from the web app's icon, with tools macOS comes with."""
    with tempfile.TemporaryDirectory(prefix="ergon-icon-") as directory:
        iconset = Path(directory) / "Ergon.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            for scale, suffix in ((1, ""), (2, "@2x")):
                subprocess.run(["sips", "-z", str(size * scale), str(size * scale), str(STATIC / "icon-512.png"),
                                "--out", str(iconset / f"icon_{size}x{size}{suffix}.png")], capture_output=True)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(resources / "Ergon.icns")],
                       capture_output=True)


def _install_mac_app(host: str, port: int) -> int:
    """Builds Ergon's own Mac app into ~/Applications: Ergon's page in a window, with Ergon's menus."""
    if sys.platform != "darwin":
        print("Ergon's app is for macOS; this is not a Mac.")
        return 1
    if shutil.which("swiftc") is None:
        print("Building Ergon's app needs Apple's command line tools. Run `xcode-select --install` and try again.")
        return 1
    # Built aside, so a failed build leaves an installed app as it was.
    with tempfile.TemporaryDirectory(prefix="ergon-app-") as directory:
        app = Path(directory) / "Ergon.app"
        contents = app / "Contents"
        (contents / "MacOS").mkdir(parents=True)
        (contents / "Resources").mkdir()
        compiled = subprocess.run(["swiftc", "-O", str(MAC_APP_SOURCE), "-o", str(contents / "MacOS" / "Ergon")],
                                  capture_output=True, text=True)
        if compiled.returncode != 0:
            print(f"Could not compile Ergon's app:\n{compiled.stderr.strip()}")
            return 1
        _make_icon(contents / "Resources")
        (contents / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": MAC_APP_ID,
            "CFBundleName": "Ergon",
            "CFBundleDisplayName": "Ergon",
            "CFBundleExecutable": "Ergon",
            "CFBundleIconFile": "Ergon",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "1.0",
            "CFBundleVersion": "1",
            "LSMinimumSystemVersion": "14.0",
            "LSApplicationCategoryType": "public.app-category.productivity",
            "NSHighResolutionCapable": True,
            # Ergon's server speaks plain http, on this Mac or the local network.
            "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
            "ErgonURL": f"http://{host}:{port}/",
        }))
        signed = subprocess.run(["codesign", "--force", "--sign", "-", str(app)], capture_output=True, text=True)
        if signed.returncode != 0:
            print(f"Could not sign Ergon's app: {signed.stderr.strip()}")
            return 1
        shutil.rmtree(MAC_APP, ignore_errors=True)
        MAC_APP.parent.mkdir(exist_ok=True)
        shutil.move(app, MAC_APP)
    subprocess.run([LSREGISTER, "-f", str(MAC_APP)], capture_output=True)
    # Clicking a reminder opens the app once the notifier knows to look for it.
    if NOTIFIER_APP.exists():
        _build_notifier(host, port)
    print(f"Ergon's app is in {MAC_APP}. Open it from Spotlight or Launchpad, and keep it in the Dock; if it was "
          "open, quit it and open it again.\nRun this again when mac/main.swift changes; undo with --uninstall-mac-app.")
    return 0


def _uninstall_mac_app() -> int:
    app = MAC_APP / "Contents" / "MacOS" / "Ergon"
    if app.exists():
        subprocess.run([str(app), "--leave-login-items"], capture_output=True, timeout=30)
    subprocess.run([LSREGISTER, "-u", str(MAC_APP)], capture_output=True)
    shutil.rmtree(MAC_APP, ignore_errors=True)
    print(f"Removed {MAC_APP}. Ergon still runs, and opens in the browser.")
    return 0


def _launchctl(*arguments: str) -> subprocess.CompletedProcess:
    return subprocess.run(["launchctl", *arguments], capture_output=True, text=True)


def _install_launch_agent(host: str, port: int, database: Path | None) -> int:
    if sys.platform != "darwin":
        print("Running Ergon in the background uses macOS launchd; this is not a Mac.")
        return 1
    domain = f"gui/{os.getuid()}"
    _launchctl("bootout", f"{domain}/{LAUNCH_AGENT_LABEL}")
    try:
        with socket.create_connection((host, port), timeout=1):
            print(f"Something is already running at http://{host}:{port}. Stop it (Ctrl+C in its "
                  "terminal) and run this again.")
            return 1
    except OSError:
        pass
    built = _build_notifier(host, port)
    arguments = [sys.executable, str(APP_DIR / "server.py"), "--host", host, "--port", str(port)]
    if database:
        arguments += ["--database", str(database.resolve())]
    LAUNCH_AGENT_LOG.parent.mkdir(parents=True, exist_ok=True)
    LAUNCH_AGENT_PLIST.parent.mkdir(parents=True, exist_ok=True)
    LAUNCH_AGENT_PLIST.write_bytes(plistlib.dumps({
        "Label": LAUNCH_AGENT_LABEL,
        "ProgramArguments": arguments,
        "WorkingDirectory": str(APP_DIR),
        # Unlike Zetesis, Ergon stays up: reminders have to fire with no window open.
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": str(LAUNCH_AGENT_LOG),
        "StandardErrorPath": str(LAUNCH_AGENT_LOG),
    }))
    result = _launchctl("bootstrap", domain, str(LAUNCH_AGENT_PLIST))
    if result.returncode != 0:
        print(f"launchctl could not load {LAUNCH_AGENT_PLIST}: {result.stderr.strip() or result.returncode}")
        return 1
    print(f"Ergon is running at http://{host}:{port}/ and starts when you log in.\nLog: {LAUNCH_AGENT_LOG}\n"
          "Run this again after moving Ergon or upgrading Python; undo with --uninstall-launch-agent.")
    if built:
        print("Click Allow when macOS asks about notifications from Ergon. Waiting for your answer...")
        if _send_with_notifier("Ergon reminders are on", "They will appear here.", INSTALL_PROMPT_TIMEOUT_SECONDS):
            print("Notifications are on.")
        else:
            print("Ergon could not send a notification yet. Reminders will appear as Script Editor notifications "
                  "until you turn on System Settings > Notifications > Ergon.")
    return 0


def _uninstall_launch_agent() -> int:
    _launchctl("bootout", f"gui/{os.getuid()}/{LAUNCH_AGENT_LABEL}")
    LAUNCH_AGENT_PLIST.unlink(missing_ok=True)
    print("Ergon no longer runs in the background, so reminders will not fire. "
          "Run `python3 ergon/server.py` to start it by hand.")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Ergon (ἔργον) — local day planner.")
    parser.add_argument("--host", default="127.0.0.1", help="interface to listen on (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port to listen on (default: {DEFAULT_PORT})")
    parser.add_argument("--verbose", action="store_true", help="enable verbose request logging")
    parser.add_argument("--database", type=Path, help="use this SQLite file instead of ergon/ergon.sqlite3")
    parser.add_argument("--install-launch-agent", action="store_true",
                        help="macOS: keep Ergon running in the background (uses --host/--port)")
    parser.add_argument("--uninstall-launch-agent", action="store_true",
                        help="macOS: stop running Ergon in the background")
    parser.add_argument("--install-mac-app", action="store_true",
                        help="macOS: build Ergon's own app into ~/Applications (uses --host/--port)")
    parser.add_argument("--uninstall-mac-app", action="store_true", help="macOS: remove Ergon's own app")
    args = parser.parse_args()

    if args.install_launch_agent:
        sys.exit(_install_launch_agent(args.host, args.port, args.database))
    if args.uninstall_launch_agent:
        sys.exit(_uninstall_launch_agent())
    if args.install_mac_app:
        sys.exit(_install_mac_app(args.host, args.port))
    if args.uninstall_mac_app:
        sys.exit(_uninstall_mac_app())

    global DB_PATH
    if args.database:
        DB_PATH = args.database.resolve()
    initialize_database()
    threading.Thread(target=_watch_reminders, daemon=True).start()
    server = ThreadingHTTPServer((args.host, args.port), ErgonHandler)
    server.verbose = args.verbose
    print(f"{_now()} Ergon is ready at http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nErgon stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
