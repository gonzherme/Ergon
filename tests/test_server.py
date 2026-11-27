"""Exercises the server over real HTTP against a throwaway database."""

import json
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

TODAY = date.today().isoformat()
TOMORROW = (date.today() + timedelta(days=1)).isoformat()
YESTERDAY = (date.today() - timedelta(days=1)).isoformat()


def minutes_from_now(minutes: int) -> str:
    return (datetime.now() + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M")


class ServerTestCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        patcher = mock.patch.object(server, "DB_PATH", Path(self.directory.name) / "test.sqlite3")
        patcher.start()
        self.addCleanup(patcher.stop)
        server.initialize_database()
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), server.ErgonHandler)
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.http.server_address[1]}"

    def call(self, method, path, body=None, headers=None):
        request = urllib.request.Request(
            self.base + path, method=method, headers=headers or {},
            data=None if body is None else json.dumps(body).encode(),
        )
        try:
            with urllib.request.urlopen(request) as response:
                raw = response.read()
                return response.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read())

    def add_task(self, title, list_name):
        task_id = str(uuid4())
        status, _ = self.call("POST", "/api/tasks", {"id": task_id, "title": title, "list": list_name})
        self.assertEqual(status, 200)
        return task_id

    def add_project(self, title):
        project_id = str(uuid4())
        self.assertEqual(self.call("POST", "/api/projects", {"id": project_id, "title": title})[0], 200)
        return project_id

    def state(self):
        return self.call("GET", "/api/state")[1]

    def task(self, task_id):
        return next((task for task in self.state()["tasks"] if task["id"] == task_id), None)

    def repeat(self, task, rule):
        self.assertEqual(self.call("PATCH", f"/api/tasks/{task}", {"repeat": rule})[0], 200)

    def finish(self, task, **fields):
        self.assertEqual(self.call("PATCH", f"/api/tasks/{task}", {"done": True, **fields})[0], 200)
        return self.task(task)

    def open_with_title(self, title):
        return [task for task in self.state()["tasks"] if task["title"] == title and not task["done_at"]]

    def titles(self, day):
        tasks = [task for task in self.state()["tasks"] if task["day"] == day and not task["done_at"]]
        return [task["title"] for task in sorted(tasks, key=lambda task: task["day_rank"])]


class ListTests(ServerTestCase):
    def test_new_tasks_go_to_the_bottom_of_their_list(self):
        self.add_task("first", f"day:{TODAY}")
        self.add_task("second", f"day:{TODAY}")
        self.assertEqual(self.titles(TODAY), ["first", "second"])

    def test_a_long_title_is_kept_whole(self):
        title = " ".join(["word"] * 400)
        task = self.add_task(title, "inbox")
        self.assertEqual(self.task(task)["title"], title)

    def test_a_project_keeps_its_description(self):
        project = self.add_project("Thesis")
        self.call("PATCH", f"/api/projects/{project}", {"description": "  Notes\n[[https://a.b][Link]]\n"})
        saved = next(item for item in server._state()["projects"] if item["id"] == project)
        self.assertEqual(saved["description"], "Notes\n[[https://a.b][Link]]")

    def test_an_older_database_gains_the_new_columns(self):
        project = self.add_project("Old")
        task = self.add_task("Old task", f"day:{TODAY}")
        with sqlite3.connect(server.DB_PATH) as connection:
            connection.execute("ALTER TABLE projects DROP COLUMN description")
            connection.execute("ALTER TABLE tasks DROP COLUMN repeat")
            connection.execute("ALTER TABLE tasks DROP COLUMN next_id")
        server.initialize_database()
        saved = next(item for item in server._state()["projects"] if item["id"] == project)
        self.assertEqual((saved["description"], self.task(task)["repeat"], self.task(task)["next_id"]), ("", None, None))

    def test_scheduling_a_project_task_keeps_it_in_the_project(self):
        project = self.add_project("Thesis")
        task = self.add_task("Outline", f"project:{project}")
        self.call("PATCH", f"/api/tasks/{task}", {"day": TOMORROW})
        saved = self.task(task)
        self.assertEqual((saved["project_id"], saved["day"]), (project, TOMORROW))

    def test_clearing_the_day_of_a_loose_task_returns_it_to_the_bottom_of_the_inbox(self):
        self.add_task("old idea", "inbox")
        task = self.add_task("Call", f"day:{TODAY}")
        self.call("PATCH", f"/api/tasks/{task}", {"day": None})
        saved = self.task(task)
        self.assertIsNone(saved["day"])
        self.assertEqual(saved["list_rank"], 1)

    def test_order_sets_ranks_and_moves_tasks_between_days(self):
        first = self.add_task("first", f"day:{TODAY}")
        second = self.add_task("second", f"day:{TODAY}")
        moved = self.add_task("moved", f"day:{TOMORROW}")
        self.call("POST", "/api/order", {"list": f"day:{TODAY}", "ids": [second, moved, first]})
        self.assertEqual(self.titles(TODAY), ["second", "moved", "first"])
        self.assertEqual(self.titles(TOMORROW), [])

    def test_projects_can_be_reordered(self):
        first, second = self.add_project("One"), self.add_project("Two")
        self.call("POST", "/api/order", {"list": "projects", "ids": [second, first]})
        self.assertEqual([project["title"] for project in self.state()["projects"]], ["Two", "One"])

    def test_deleting_a_project_can_be_undone_without_reviving_older_deletions(self):
        project = self.add_project("Thesis")
        kept = self.add_task("Keep", f"project:{project}")
        deleted_earlier = self.add_task("Gone", f"project:{project}")
        with mock.patch.object(server, "_now", return_value="2026-01-01T10:00:00"):
            self.call("PATCH", f"/api/tasks/{deleted_earlier}", {"deleted": True})
        self.call("PATCH", f"/api/projects/{project}", {"deleted": True})
        self.assertIsNone(self.task(kept))
        self.call("PATCH", f"/api/projects/{project}", {"deleted": False})
        self.assertIsNotNone(self.task(kept))
        self.assertIsNone(self.task(deleted_earlier))

    def test_invalid_input_is_rejected(self):
        task = self.add_task("Valid", "inbox")
        self.assertEqual(self.call("POST", "/api/tasks", {"id": str(uuid4()), "title": "  ", "list": "inbox"})[0], 400)
        self.assertEqual(self.call("POST", "/api/tasks", {"id": str(uuid4()), "title": "x", "list": "nope"})[0], 400)
        self.assertEqual(self.call("PATCH", f"/api/tasks/{task}", {"day": "2026-13-40"})[0], 400)
        self.assertEqual(self.call("PATCH", f"/api/tasks/{task}", {"remind_at": "tomorrow"})[0], 400)
        self.assertEqual(self.call("PATCH", f"/api/tasks/{task}", {"project_id": str(uuid4())})[0], 400)
        self.assertEqual(self.call("PATCH", f"/api/tasks/{uuid4()}", {"title": "x"})[0], 404)


class OverdueTests(ServerTestCase):
    def test_unfinished_tasks_keep_their_day(self):
        older = (date.today() - timedelta(days=3)).isoformat()
        self.add_task("planned today", f"day:{TODAY}")
        late = self.add_task("from days ago", f"day:{older}")
        self.assertEqual(self.titles(TODAY), ["planned today"])
        self.assertEqual(self.task(late)["day"], older)

    def test_tasks_carried_to_today_go_back_to_their_day(self):
        carried = self.add_task("carried", f"day:{TODAY}")
        planned = self.add_task("planned", f"day:{TODAY}")
        finished = self.add_task("finished", f"day:{TODAY}")
        self.call("PATCH", f"/api/tasks/{finished}", {"done": True})
        with sqlite3.connect(server.DB_PATH) as connection:
            connection.execute("ALTER TABLE tasks ADD COLUMN carried_from TEXT")
            connection.execute("UPDATE tasks SET carried_from = ? WHERE id IN (?, ?)", (YESTERDAY, carried, finished))
        server.initialize_database()
        self.assertEqual([self.task(task)["day"] for task in (carried, planned, finished)], [YESTERDAY, TODAY, TODAY])
        with sqlite3.connect(server.DB_PATH) as connection:
            columns = [info[1] for info in connection.execute("PRAGMA table_info(tasks)")]
        self.assertNotIn("carried_from", columns)

    def test_reopening_keeps_the_day(self):
        task = self.add_task("Finished", f"day:{YESTERDAY}")
        self.call("PATCH", f"/api/tasks/{task}", {"done": True})
        self.assertEqual(self.task(task)["day"], YESTERDAY)
        self.call("PATCH", f"/api/tasks/{task}", {"done": False})
        self.assertEqual(self.task(task)["day"], YESTERDAY)

    def test_dragging_an_overdue_task_into_today_plans_it_for_today(self):
        planned = self.add_task("planned", f"day:{TODAY}")
        late = self.add_task("late", f"day:{YESTERDAY}")
        self.call("POST", "/api/order", {"list": f"day:{TODAY}", "ids": [late, planned]})
        self.assertEqual(self.titles(TODAY), ["late", "planned"])


def day(text: str) -> date:
    return date.fromisoformat(text)


class RepeatRuleTests(unittest.TestCase):
    def dates(self, rule, anchor, count=4):
        """The first `count` dates of a rule, starting with its anchor."""
        parsed = server._parse_rule(rule)
        found = [day(anchor)]
        while len(found) < count:
            following = server._first_occurrence(parsed, found[-1], found[-1] + timedelta(days=1))
            if following is None:
                break
            found.append(following)
        return [value.isoformat() for value in found]

    def test_days_and_weeks(self):
        self.assertEqual(self.dates("FREQ=DAILY;INTERVAL=3", "2026-11-11"),
                         ["2026-11-11", "2026-11-14", "2026-11-17", "2026-11-20"])
        self.assertEqual(self.dates("FREQ=WEEKLY", "2026-11-11", 3), ["2026-11-11", "2026-11-18", "2026-11-25"])
        self.assertEqual(self.dates("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "2026-11-13", 3),
                         ["2026-11-13", "2026-11-16", "2026-11-17"])

    def test_every_other_week_on_several_days_keeps_its_weeks(self):
        self.assertEqual(self.dates("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", "2026-11-09", 5),
                         ["2026-11-09", "2026-11-11", "2026-11-23", "2026-11-25", "2026-12-07"])
        # Weeks starting on Sunday put a Sunday with the Monday after it.
        self.assertEqual(self.dates("FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=SU", "2026-11-15", 4),
                         ["2026-11-15", "2026-11-16", "2026-11-29", "2026-11-30"])

    def test_months_skip_those_without_the_day(self):
        self.assertEqual(self.dates("FREQ=MONTHLY", "2026-01-31", 3), ["2026-01-31", "2026-03-31", "2026-05-31"])
        self.assertEqual(self.dates("FREQ=MONTHLY;BYMONTHDAY=1,15", "2026-11-15", 3),
                         ["2026-11-15", "2026-12-01", "2026-12-15"])

    def test_positions_in_a_month(self):
        self.assertEqual(self.dates("FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2", "2026-11-10", 3),
                         ["2026-11-10", "2026-12-08", "2027-01-12"])
        self.assertEqual(self.dates("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "2026-10-30", 3),
                         ["2026-10-30", "2026-11-30", "2026-12-31"])
        self.assertEqual(self.dates("FREQ=MONTHLY;INTERVAL=3;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYSETPOS=-1", "2026-01-31", 3),
                         ["2026-01-31", "2026-04-30", "2026-07-31"])

    def test_years_and_leap_days(self):
        self.assertEqual(self.dates("FREQ=YEARLY", "2028-02-29", 2), ["2028-02-29", "2032-02-29"])
        self.assertEqual(self.dates("FREQ=YEARLY;INTERVAL=2", "2026-11-11", 2), ["2026-11-11", "2028-11-11"])

    def test_a_rule_ends_on_its_until_day(self):
        self.assertEqual(self.dates("FREQ=WEEKLY;UNTIL=20261125", "2026-11-11", 9), ["2026-11-11", "2026-11-18", "2026-11-25"])

    def test_rules_ergon_does_not_write_are_refused(self):
        for rule in ("", "FREQ=HOURLY", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;INTERVAL=100", "FREQ=WEEKLY;BYDAY=XX",
                     "FREQ=DAILY;BYMONTHDAY=3", "FREQ=MONTHLY;BYDAY=MO", "FREQ=MONTHLY;BYDAY=2MO",
                     "FREQ=MONTHLY;BYMONTHDAY=32", "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=6", "FREQ=WEEKLY;COUNT=3",
                     "FREQ=DAILY;UNTIL=20261340", "INTERVAL=2", "FREQ=DAILY;TIMES=2", "FREQ=YEARLY;TIMES=2",
                     "FREQ=WEEKLY;TIMES=8", "FREQ=WEEKLY;TIMES=0", "FREQ=MONTHLY;TIMES=32", "FREQ=WEEKLY;INTERVAL=2;TIMES=3",
                     "FREQ=WEEKLY;BYDAY=MO;TIMES=2", "FREQ=WEEKLY;TIMES=x"):
            with self.subTest(rule=rule), self.assertRaises(ValueError):
                server._parse_rule(rule)


class RepeatTests(ServerTestCase):
    def test_finishing_a_repeating_task_adds_its_next_date(self):
        project = self.add_project("Home")
        task = self.add_task("Water plants", f"project:{project}")
        self.call("PATCH", f"/api/tasks/{task}", {"day": TODAY, "remind_at": f"{TODAY}T23:59"})
        self.repeat(task, "FREQ=DAILY;INTERVAL=2")
        next_id = str(uuid4())
        finished = self.finish(task, next_id=next_id)
        following = self.task(next_id)
        in_two_days = (date.today() + timedelta(days=2)).isoformat()
        self.assertEqual((finished["repeat"], finished["next_id"]), (None, next_id))
        self.assertEqual((following["title"], following["project_id"], following["day"], following["repeat"]),
                         ("Water plants", project, in_two_days, "FREQ=DAILY;INTERVAL=2"))
        self.assertEqual((following["remind_at"], following["reminded_at"]), (f"{in_two_days}T23:59", None))
        self.assertEqual(following["list_rank"], finished["list_rank"])

    def test_a_missed_habit_moves_on_to_today_so_finishing_it_counts_for_today(self):
        task = self.add_task("Stretch", f"day:{(date.today() - timedelta(days=3)).isoformat()}")
        self.repeat(task, "FREQ=DAILY")
        self.assertEqual(self.finish(task)["day"], TODAY)
        self.assertEqual([found["day"] for found in self.open_with_title("Stretch")], [TOMORROW])

    def test_finishing_early_moves_past_the_date_it_was_for(self):
        in_a_week = (date.today() + timedelta(days=7)).isoformat()
        task = self.add_task("Rent", f"day:{in_a_week}")
        self.repeat(task, "FREQ=WEEKLY")
        self.finish(task)
        self.assertEqual([found["day"] for found in self.open_with_title("Rent")],
                         [(date.today() + timedelta(days=14)).isoformat()])

    def test_a_reminder_already_past_does_not_go_off(self):
        task = self.add_task("Pills", f"day:{YESTERDAY}")
        self.call("PATCH", f"/api/tasks/{task}", {"remind_at": f"{YESTERDAY}T00:00"})
        self.repeat(task, "FREQ=DAILY")
        [moved] = self.open_with_title("Pills")
        self.assertEqual((moved["day"], moved["remind_at"]), (TODAY, f"{TODAY}T00:00"))
        self.assertIsNotNone(moved["reminded_at"])

    def test_a_finished_rule_adds_nothing(self):
        task = self.add_task("Course", f"day:{TODAY}")
        self.repeat(task, f"FREQ=DAILY;UNTIL={TODAY.replace('-', '')}")
        finished = self.finish(task)
        self.assertEqual((self.open_with_title("Course"), finished["next_id"]), ([], None))

    def test_reopening_takes_back_the_next_date(self):
        task = self.add_task("Journal", f"day:{TODAY}")
        self.repeat(task, "FREQ=DAILY")
        following = self.finish(task)["next_id"]
        self.call("PATCH", f"/api/tasks/{following}", {"repeat": "FREQ=DAILY;INTERVAL=2"})
        self.call("PATCH", f"/api/tasks/{task}", {"done": False})
        reopened = self.task(task)
        self.assertIsNone(self.task(following))
        self.assertEqual((reopened["repeat"], reopened["next_id"], reopened["done_at"]), ("FREQ=DAILY;INTERVAL=2", None, None))

    def test_reopening_after_the_next_date_is_finished_leaves_the_series_alone(self):
        task = self.add_task("Journal", f"day:{TODAY}")
        self.repeat(task, "FREQ=DAILY")
        following = self.finish(task)["next_id"]
        self.finish(following)
        self.call("PATCH", f"/api/tasks/{task}", {"done": False})
        self.assertEqual((self.task(task)["repeat"], self.task(task)["next_id"]), (None, None))
        self.assertEqual(len(self.open_with_title("Journal")), 2)

    def test_a_repeat_moves_the_task_to_its_first_date(self):
        task = self.add_task("Gym", "inbox")
        self.repeat(task, "FREQ=DAILY")
        self.assertEqual(self.task(task)["day"], TODAY)
        weekday = (date.today().weekday() + 1) % 7
        self.repeat(task, f"FREQ=WEEKLY;BYDAY={server.WEEKDAY_CODES[weekday]}")
        self.assertEqual(self.task(task)["day"], TOMORROW)

    def test_taking_the_day_away_stops_the_repeat(self):
        first = self.add_task("One", f"day:{TODAY}")
        second = self.add_task("Two", f"day:{TODAY}")
        for task in (first, second):
            self.repeat(task, "FREQ=DAILY")
        self.call("PATCH", f"/api/tasks/{first}", {"day": None})
        self.call("POST", "/api/order", {"list": "inbox", "ids": [second]})
        self.call("PATCH", f"/api/tasks/{first}", {"day": TOMORROW})
        self.assertEqual([self.task(task)["repeat"] for task in (first, second)], [None, None])

    def test_moving_a_repeating_task_keeps_its_repeat(self):
        task = self.add_task("Review", f"day:{TODAY}")
        self.repeat(task, "FREQ=WEEKLY")
        self.call("POST", "/api/order", {"list": f"day:{TOMORROW}", "ids": [task]})
        self.assertEqual((self.task(task)["day"], self.task(task)["repeat"]), (TOMORROW, "FREQ=WEEKLY"))

    def test_skipping_moves_the_day_and_reminder_on(self):
        task = self.add_task("Call home", f"day:{TODAY}")
        self.call("PATCH", f"/api/tasks/{task}", {"remind_at": f"{TODAY}T23:59"})
        self.repeat(task, "FREQ=DAILY")
        self.assertEqual(self.call("PATCH", f"/api/tasks/{task}", {"skip": True})[0], 200)
        skipped = self.task(task)
        self.assertEqual((skipped["day"], skipped["remind_at"], skipped["done_at"]), (TOMORROW, f"{TOMORROW}T23:59", None))
        self.assertEqual(len(self.open_with_title("Call home")), 1)

    def test_invalid_repeats_are_rejected(self):
        task = self.add_task("Valid", f"day:{TODAY}")
        self.assertEqual(self.call("PATCH", f"/api/tasks/{task}", {"repeat": "FREQ=SOMETIMES"})[0], 400)
        self.assertEqual(self.call("PATCH", f"/api/tasks/{task}", {"repeat": 7})[0], 400)
        self.assertEqual(self.call("PATCH", f"/api/tasks/{task}", {"repeat": "FREQ=DAILY;UNTIL=20200101"})[0], 400)
        self.repeat(task, "FREQ=DAILY")
        self.assertEqual(self.call("PATCH", f"/api/tasks/{task}", {"done": True, "next_id": "not an id"})[0], 400)
        self.assertEqual(self.task(task)["done_at"], None)


class HabitTests(ServerTestCase):
    def add_habit(self, title, rule, day=TODAY):
        task_id = str(uuid4())
        status, _ = self.call("POST", "/api/tasks", {"id": task_id, "title": title, "list": f"day:{day}", "repeat": rule})
        self.assertEqual(status, 200)
        return task_id

    def week_from_today(self, times):
        """A rule whose weeks start today, so this week is today and the six days after it."""
        return f"FREQ=WEEKLY;TIMES={times};WKST={server.WEEKDAY_CODES[date.today().weekday()]}"

    def test_a_habit_is_created_with_its_repeat(self):
        task = self.add_habit("Gym", "FREQ=WEEKLY;TIMES=6")
        saved = self.task(task)
        self.assertEqual((saved["day"], saved["repeat"], saved["series_id"]), (TODAY, "FREQ=WEEKLY;TIMES=6", task))
        refused = str(uuid4())
        self.assertEqual(self.call("POST", "/api/tasks", {"id": refused, "title": "Bad", "list": "inbox", "repeat": "FREQ=NEVER"})[0], 400)
        self.assertIsNone(self.task(refused))

    def test_some_times_a_week_comes_back_each_day_until_done_that_many_times(self):
        task = self.add_habit("Gym", self.week_from_today(2))
        second = self.finish(task)["next_id"]
        self.assertEqual(self.task(second)["day"], TOMORROW)
        third = self.finish(second)["next_id"]
        self.assertEqual(self.task(third)["day"], (date.today() + timedelta(days=7)).isoformat())
        self.assertEqual({self.task(found)["series_id"] for found in (task, second, third)}, {task})

    def test_reopening_a_day_lets_the_week_count_it_again(self):
        task = self.add_habit("Gym", self.week_from_today(1))
        following = self.finish(task)["next_id"]
        self.assertEqual(self.task(following)["day"], (date.today() + timedelta(days=7)).isoformat())
        self.call("PATCH", f"/api/tasks/{task}", {"done": False})
        self.assertEqual([found["day"] for found in self.open_with_title("Gym")], [TODAY])

    def test_skipping_a_day_does_not_count_it(self):
        task = self.add_habit("Gym", self.week_from_today(1))
        self.call("PATCH", f"/api/tasks/{task}", {"skip": True})
        self.assertEqual(self.task(task)["day"], TOMORROW)

    def test_missed_habits_move_on_when_their_next_date_comes(self):
        three_days_ago = date.today() - timedelta(days=3)
        daily = self.add_task("Vitamins", f"day:{three_days_ago.isoformat()}")
        self.call("PATCH", f"/api/tasks/{daily}", {"remind_at": f"{three_days_ago.isoformat()}T23:59"})
        self.repeat(daily, "FREQ=DAILY")
        weekly = self.add_habit("Laundry", "FREQ=WEEKLY", three_days_ago.isoformat())
        any_days = self.add_habit("Gym", "FREQ=WEEKLY;TIMES=3", three_days_ago.isoformat())
        moved = self.task(daily)
        self.assertEqual((moved["day"], moved["remind_at"], moved["reminded_at"]), (TODAY, f"{TODAY}T23:59", None))
        self.assertEqual(self.task(weekly)["day"], three_days_ago.isoformat(), "its next date is still to come")
        self.assertEqual(self.task(any_days)["day"], TODAY)

    def test_waiting_habits_do_not_change_the_state_tag(self):
        self.add_habit("Laundry", "FREQ=WEEKLY", (date.today() - timedelta(days=3)).isoformat())
        tag = self.state()["tag"]
        self.assertEqual(self.call("GET", f"/api/state?tag={tag}")[0], 204)

    def rank(self, task, column="habit_rank"):
        return self.task(task)[column]

    def test_habits_keep_the_order_they_are_put_in(self):
        gym, laundry, reading = (self.add_habit(title, "FREQ=DAILY") for title in ("Gym", "Laundry", "Reading"))
        self.assertEqual([self.rank(task) for task in (gym, laundry, reading)], [0, 1, 2])
        self.assertEqual(self.call("POST", "/api/order", {"list": "habits", "ids": [reading, gym, laundry]})[0], 200)
        self.assertEqual([self.rank(task) for task in (reading, gym, laundry)], [0, 1, 2])
        following = self.finish(gym)["next_id"]
        self.assertEqual(self.rank(following), 1, "the next date keeps the habit's place")
        self.call("PATCH", f"/api/tasks/{reading}", {"repeat": None})
        self.call("POST", "/api/order", {"list": "inbox", "ids": [laundry]})
        self.assertEqual((self.rank(reading), self.rank(laundry)), (None, None))
        self.assertEqual(self.rank(self.add_habit("Stretch", "FREQ=DAILY")), 2)

    def test_overdue_keeps_the_order_it_is_put_in_until_a_task_gets_a_new_day(self):
        older = self.add_task("Older", f"day:{(date.today() - timedelta(days=3)).isoformat()}")
        newer = self.add_task("Newer", f"day:{YESTERDAY}")
        self.assertEqual((self.rank(older, "overdue_rank"), self.rank(newer, "overdue_rank")), (None, None))
        self.call("POST", "/api/order", {"list": "overdue", "ids": [newer, older]})
        self.assertEqual((self.rank(newer, "overdue_rank"), self.rank(older, "overdue_rank")), (0, 1))
        self.call("PATCH", f"/api/tasks/{older}", {"day": TODAY})
        self.call("POST", "/api/order", {"list": f"day:{TODAY}", "ids": [newer]})
        self.assertEqual((self.rank(older, "overdue_rank"), self.rank(newer, "overdue_rank")), (None, None))

    def test_habits_from_before_ranks_are_put_in_order_by_day(self):
        later = self.add_habit("Later", "FREQ=WEEKLY", TOMORROW)
        sooner = self.add_habit("Sooner", "FREQ=DAILY")
        with sqlite3.connect(server.DB_PATH) as connection:
            connection.execute("ALTER TABLE tasks DROP COLUMN habit_rank")
            connection.execute("ALTER TABLE tasks DROP COLUMN overdue_rank")
        server.initialize_database()
        self.assertEqual((self.rank(sooner), self.rank(later)), (0, 1))

    def test_the_reminder_watcher_moves_missed_habits_on(self):
        task = self.add_habit("Vitamins", "FREQ=DAILY", YESTERDAY)
        with mock.patch.object(server, "send_notification", return_value=True):
            server.send_due_reminders()
        with sqlite3.connect(server.DB_PATH) as connection:
            self.assertEqual(connection.execute("SELECT day FROM tasks WHERE id = ?", (task,)).fetchone()[0], TODAY)


class ReminderTests(ServerTestCase):
    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(server, "send_notification", return_value=True)
        self.notify = patcher.start()
        self.addCleanup(patcher.stop)

    def remind(self, task, when):
        self.assertEqual(self.call("PATCH", f"/api/tasks/{task}", {"remind_at": when})[0], 200)

    def test_due_reminder_fires_exactly_once(self):
        task = self.add_task("Call dentist", f"day:{TODAY}")
        self.remind(task, minutes_from_now(-1))
        server.send_due_reminders()
        server.send_due_reminders()
        self.notify.assert_called_once_with("Call dentist", "")
        self.assertIsNotNone(self.task(task)["reminded_at"])

    def test_a_reminder_shows_a_link_by_its_label(self):
        task = self.add_task("Read [[https://example.com/a][the article]] tonight", "inbox")
        self.remind(task, minutes_from_now(-1))
        server.send_due_reminders()
        self.notify.assert_called_once_with("Read the article tonight", "")

    def test_future_done_and_deleted_reminders_do_not_fire(self):
        future = self.add_task("Later", "inbox")
        done = self.add_task("Done", "inbox")
        deleted = self.add_task("Deleted", "inbox")
        self.remind(future, minutes_from_now(5))
        self.remind(done, minutes_from_now(-1))
        self.remind(deleted, minutes_from_now(-1))
        self.call("PATCH", f"/api/tasks/{done}", {"done": True})
        self.call("PATCH", f"/api/tasks/{deleted}", {"deleted": True})
        server.send_due_reminders()
        self.notify.assert_not_called()

    def test_changing_a_reminder_rearms_it(self):
        task = self.add_task("Again", "inbox")
        self.remind(task, minutes_from_now(-2))
        server.send_due_reminders()
        self.remind(task, minutes_from_now(-1))
        self.assertIsNone(self.task(task)["reminded_at"])
        server.send_due_reminders()
        self.assertEqual(self.notify.call_count, 2)

    def test_undelivered_reminder_is_retried(self):
        task = self.add_task("Retry", "inbox")
        self.remind(task, minutes_from_now(-1))
        self.notify.return_value = False
        server.send_due_reminders()
        self.assertIsNone(self.task(task)["reminded_at"])
        self.notify.return_value = True
        server.send_due_reminders()
        self.assertIsNotNone(self.task(task)["reminded_at"])

    def test_late_reminder_names_its_project_and_original_time(self):
        project = self.add_project("Thesis")
        task = self.add_task("Send draft", f"project:{project}")
        self.remind(task, minutes_from_now(-90))
        server.send_due_reminders()
        title, body = self.notify.call_args.args
        self.assertEqual(title, "Send draft")
        self.assertTrue(body.startswith("Thesis · Set for "), body)

    def test_quotes_reach_osascript_as_arguments(self):
        with mock.patch.object(server.subprocess, "run") as run:
            run.return_value.returncode = 0
            server._send_with_osascript('Say "hi" \\ now', "body")
        arguments = run.call_args.args[0]
        self.assertIn('Say "hi" \\ now', arguments)
        self.assertNotIn('Say "hi"', arguments[2])


class NotifierTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.binary = Path(directory.name) / "notifier"
        patcher = mock.patch.object(server, "NOTIFIER_BINARY", self.binary)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.stop_waiting_notifier)

    def stop_waiting_notifier(self):
        if server.awaiting_permission is not None:
            server.awaiting_permission.kill()
            server.awaiting_permission.communicate()
            server.awaiting_permission = None

    def fake_notifier(self, script):
        self.binary.write_text(f"#!/bin/sh\n{script}\n")
        self.binary.chmod(0o755)

    def test_success_and_refusal_are_reported(self):
        self.fake_notifier("exit 0")
        self.assertTrue(server._send_with_notifier("Title", "Body"))
        self.fake_notifier("echo not allowed >&2; exit 3")
        self.assertFalse(server._send_with_notifier("Title", "Body"))

    def test_a_notifier_waiting_on_the_prompt_is_left_running(self):
        self.fake_notifier("exec sleep 30")
        self.assertFalse(server._send_with_notifier("Title", "Body", timeout=0.2))
        self.assertIsNone(server.awaiting_permission.poll(), "killing it would withdraw the prompt")

    def test_reminders_skip_the_notifier_until_the_prompt_is_answered(self):
        self.fake_notifier("exec sleep 30")
        server._send_with_notifier("Title", "Body", timeout=0.2)
        waiting = server.awaiting_permission
        with mock.patch.object(server.subprocess, "Popen") as popen:
            self.assertFalse(server._send_with_notifier("Next", "Body"))
        popen.assert_not_called()
        waiting.kill()
        waiting.communicate()
        self.fake_notifier("exit 0")
        self.assertTrue(server._send_with_notifier("Next", "Body"))
        self.assertIsNone(server.awaiting_permission)


class LaunchAgentTests(unittest.TestCase):
    def test_install_writes_an_agent_that_stays_running(self):
        with tempfile.TemporaryDirectory() as directory:
            plist = Path(directory) / "agent.plist"
            with mock.patch.multiple(server, LAUNCH_AGENT_PLIST=plist, LAUNCH_AGENT_LOG=Path(directory) / "log" / "server.log"), \
                    mock.patch.object(server, "_build_notifier", return_value=False), \
                    mock.patch.object(server, "_launchctl") as launchctl, \
                    mock.patch.object(server.socket, "create_connection", side_effect=OSError):
                launchctl.return_value.returncode = 0
                self.assertEqual(server._install_launch_agent("127.0.0.1", 8001, None), 0)
            agent = server.plistlib.loads(plist.read_bytes())
        self.assertTrue(agent["RunAtLoad"])
        self.assertTrue(agent["KeepAlive"])
        self.assertEqual(agent["ProgramArguments"][1:], [str(server.APP_DIR / "server.py"), "--host", "127.0.0.1", "--port", "8001"])
        self.assertEqual(launchctl.call_args.args[0], "bootstrap")

    def test_install_refuses_when_the_port_is_taken(self):
        with mock.patch.object(server, "_launchctl"), mock.patch.object(server.socket, "create_connection"), \
                mock.patch.object(server, "_build_notifier") as build:
            self.assertEqual(server._install_launch_agent("127.0.0.1", 8001, None), 1)
        build.assert_not_called()


class PlanningTests(ServerTestCase):
    def test_a_task_says_how_long_it_takes(self):
        task_id = str(uuid4())
        body = {"id": task_id, "title": "Fix the bike", "list": "inbox", "minutes": 60}
        self.assertEqual(self.call("POST", "/api/tasks", body)[0], 200)
        self.assertEqual(self.task(task_id)["minutes"], 60)
        self.assertEqual(self.call("PATCH", f"/api/tasks/{task_id}", {"minutes": 90})[0], 200)
        self.assertEqual(self.task(task_id)["minutes"], 90)
        self.assertEqual(self.call("PATCH", f"/api/tasks/{task_id}", {"minutes": None})[0], 200)
        self.assertIsNone(self.task(task_id)["minutes"])
        for wrong in (0, 24 * 60 + 1, "1h", 1.5, True):
            self.assertEqual(self.call("PATCH", f"/api/tasks/{task_id}", {"minutes": wrong})[0], 400, wrong)
        self.assertIsNone(self.task(self.add_task("Untimed", "inbox"))["minutes"])

    def test_a_habits_next_date_takes_as_long(self):
        task = self.add_task("Push", f"day:{TODAY}")
        self.call("PATCH", f"/api/tasks/{task}", {"minutes": 60})
        self.repeat(task, "FREQ=DAILY")
        self.finish(task)
        self.assertEqual([found["minutes"] for found in self.open_with_title("Push")], [60])

    def test_days_have_time_by_weekday_until_one_day_says_otherwise(self):
        time = self.state()["time"]
        self.assertEqual(time["weekdays"], {"MO": 120, "TU": 120, "WE": 120, "TH": 120, "FR": 120, "SA": 300, "SU": 300})
        self.assertEqual(time["days"], {})
        self.assertEqual(self.call("PATCH", "/api/time", {"day": "SA", "minutes": 240})[0], 200)
        self.assertEqual(self.call("PATCH", "/api/time", {"day": TOMORROW, "minutes": 0})[0], 200)
        time = self.state()["time"]
        self.assertEqual((time["weekdays"]["SA"], time["weekdays"]["SU"], time["days"]), (240, 300, {TOMORROW: 0}))
        # A day goes back to its weekday's time.
        self.assertEqual(self.call("PATCH", "/api/time", {"day": TOMORROW, "minutes": None})[0], 200)
        self.assertEqual(self.state()["time"]["days"], {})
        for wrong in ({"day": "XX", "minutes": 60}, {"day": "SA", "minutes": None}, {"day": "SA", "minutes": -5},
                      {"day": TOMORROW, "minutes": 24 * 60 + 1}, {"minutes": 60}):
            self.assertEqual(self.call("PATCH", "/api/time", wrong)[0], 400, wrong)


class FolderTests(ServerTestCase):
    def add_folder(self, title):
        folder_id = str(uuid4())
        self.assertEqual(self.call("POST", "/api/folders", {"id": folder_id, "title": title})[0], 200)
        return folder_id

    def test_folders_hold_repeating_tasks_in_their_order(self):
        sport, birthdays = self.add_folder("Deporte"), self.add_folder("Birthdays")
        self.assertEqual([(f["title"], f["rank"]) for f in self.state()["folders"]], [("Deporte", 0), ("Birthdays", 1)])
        task_id = str(uuid4())
        body = {"id": task_id, "title": "Ana", "list": f"day:{TOMORROW}", "repeat": "FREQ=YEARLY", "folder_id": birthdays}
        self.assertEqual(self.call("POST", "/api/tasks", body)[0], 200)
        self.assertEqual(self.task(task_id)["folder_id"], birthdays)
        gym = self.add_task("Push", f"day:{TODAY}")
        self.repeat(gym, "FREQ=DAILY")
        self.assertIsNone(self.task(gym)["folder_id"])
        self.assertEqual(self.call("PATCH", f"/api/tasks/{gym}", {"folder_id": sport})[0], 200)
        self.assertEqual(self.task(gym)["folder_id"], sport)
        self.assertEqual(self.call("PATCH", f"/api/folders/{sport}", {"title": "Sport"})[0], 200)
        self.assertEqual([f["title"] for f in self.state()["folders"]], ["Sport", "Birthdays"])
        for wrong in ({"title": " "}, {"id": "not an id", "title": "X"}):
            self.assertEqual(self.call("POST", "/api/folders", wrong)[0], 400, wrong)
        self.assertEqual(self.call("PATCH", f"/api/tasks/{gym}", {"folder_id": str(uuid4())})[0], 400)
        self.assertEqual(self.call("PATCH", f"/api/folders/{uuid4()}", {"title": "Nowhere"})[0], 404)

    def test_a_repeating_tasks_next_date_stays_in_its_folder(self):
        sport = self.add_folder("Deporte")
        gym = self.add_task("Push", f"day:{TODAY}")
        self.repeat(gym, "FREQ=DAILY")
        self.call("PATCH", f"/api/tasks/{gym}", {"folder_id": sport})
        self.finish(gym)
        self.assertEqual([found["folder_id"] for found in self.open_with_title("Push")], [sport])

    def test_a_deleted_folder_keeps_its_tasks_for_undo(self):
        sport = self.add_folder("Deporte")
        gym = self.add_task("Push", f"day:{TODAY}")
        self.repeat(gym, "FREQ=DAILY")
        self.call("PATCH", f"/api/tasks/{gym}", {"folder_id": sport})
        self.assertEqual(self.call("PATCH", f"/api/folders/{sport}", {"deleted": True})[0], 200)
        self.assertEqual(self.state()["folders"], [])
        self.assertEqual(self.task(gym)["folder_id"], sport)
        # Nothing new goes into a deleted folder, until Undo brings it back.
        self.assertEqual(self.call("PATCH", f"/api/tasks/{gym}", {"folder_id": sport})[0], 400)
        self.assertEqual(self.call("PATCH", f"/api/folders/{sport}", {"deleted": False})[0], 200)
        self.assertEqual([f["id"] for f in self.state()["folders"]], [sport])


class GoalTests(ServerTestCase):
    def add_box(self, text, x=0, y=0):
        box_id = str(uuid4())
        self.assertEqual(self.call("POST", "/api/boxes", {"id": box_id, "text": text, "x": x, "y": y})[0], 200)
        return box_id

    def join(self, start, end):
        arrow_id = str(uuid4())
        status, body = self.call("POST", "/api/arrows", {"id": arrow_id, "from_id": start, "to_id": end})
        return arrow_id if status == 200 else (status, body["error"])

    def map(self):
        state = self.state()
        return {box["id"]: box for box in state["boxes"]}, [(arrow["from_id"], arrow["to_id"]) for arrow in state["arrows"]]

    def test_boxes_keep_their_text_and_place(self):
        box = self.add_box("  Run a marathon \n\n  by spring  ", 120.5, -40)
        self.assertEqual(self.map()[0][box], {"id": box, "text": "Run a marathon\n\nby spring", "x": 120.5, "y": -40})
        self.assertEqual(self.call("PATCH", f"/api/boxes/{box}", {"x": 10, "y": 20, "text": "Run a half"})[0], 200)
        self.assertEqual(self.map()[0][box], {"id": box, "text": "Run a half", "x": 10, "y": 20})
        self.assertEqual(self.call("PATCH", f"/api/boxes/{box}", {"y": 5})[0], 200)
        self.assertEqual((self.map()[0][box]["x"], self.map()[0][box]["y"]), (10, 5))

    def test_arrows_join_two_boxes_once(self):
        goal, step = self.add_box("Health"), self.add_box("Sleep by 11")
        self.assertIsInstance(self.join(goal, step), str)
        self.assertEqual(self.map()[1], [(goal, step)])
        self.assertEqual(self.join(step, goal), (400, "Those boxes are already joined."))
        self.assertEqual(self.join(goal, goal), (400, "An arrow joins two different boxes."))
        self.assertEqual(self.join(goal, str(uuid4()))[0], 404)

    def test_deleting_a_box_takes_its_arrows_and_undoing_brings_back_only_those(self):
        goal, step, other = self.add_box("Health"), self.add_box("Sleep"), self.add_box("Eat well")
        self.join(goal, step)
        earlier = self.join(goal, other)
        self.assertEqual(self.call("PATCH", f"/api/arrows/{earlier}", {"deleted": True})[0], 200)
        self.assertEqual(self.call("PATCH", f"/api/boxes/{goal}", {"deleted": True})[0], 200)
        boxes, arrows = self.map()
        self.assertEqual((set(boxes), arrows), ({step, other}, []))
        self.assertEqual(self.call("PATCH", f"/api/boxes/{goal}", {"deleted": False})[0], 200)
        boxes, arrows = self.map()
        self.assertEqual((set(boxes), arrows), ({goal, step, other}, [(goal, step)]))

    def test_an_arrow_can_be_deleted_and_brought_back(self):
        goal, step = self.add_box("Health"), self.add_box("Sleep")
        arrow = self.join(goal, step)
        self.assertEqual(self.call("PATCH", f"/api/arrows/{arrow}", {"deleted": True})[0], 200)
        self.assertEqual(self.map()[1], [])
        self.assertEqual(self.call("PATCH", f"/api/arrows/{arrow}", {"deleted": False})[0], 200)
        self.assertEqual(self.map()[1], [(goal, step)])

    def test_invalid_boxes_are_rejected(self):
        for payload in ({"text": "  \n ", "x": 0, "y": 0}, {"text": "x" * 2001, "x": 0, "y": 0},
                        {"text": "Far", "x": 2e6, "y": 0}, {"text": "Odd", "x": True, "y": 0}, {"text": "No place"}):
            self.assertEqual(self.call("POST", "/api/boxes", {"id": str(uuid4()), **payload})[0], 400, payload)
        self.assertEqual(self.call("PATCH", f"/api/boxes/{uuid4()}", {"text": "Gone"})[0], 404)

    def test_deleted_boxes_and_their_arrows_are_purged_after_a_month(self):
        goal, step = self.add_box("Health"), self.add_box("Sleep")
        self.join(goal, step)
        self.call("PATCH", f"/api/boxes/{goal}", {"deleted": True})
        long_ago = (datetime.now() - timedelta(days=server.DELETED_RETENTION_DAYS + 1)).isoformat(timespec="seconds")
        with sqlite3.connect(server.DB_PATH) as connection:
            connection.execute("UPDATE boxes SET deleted_at = ? WHERE deleted_at IS NOT NULL", (long_ago,))
            connection.execute("UPDATE arrows SET deleted_at = ? WHERE deleted_at IS NOT NULL", (long_ago,))
        server.initialize_database()
        with sqlite3.connect(server.DB_PATH) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM boxes").fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM arrows").fetchone()[0], 0)


class AccessTests(ServerTestCase):
    def test_other_sites_cannot_write_or_read(self):
        body = {"id": str(uuid4()), "title": "x", "list": "inbox"}
        self.assertEqual(self.call("POST", "/api/tasks", body, {"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.call("GET", "/api/state", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.state()["tasks"], [])

    def test_the_app_itself_can_write(self):
        body = {"id": str(uuid4()), "title": "x", "list": "inbox"}
        self.assertEqual(self.call("POST", "/api/tasks", body, {"Origin": self.base})[0], 200)

    def test_static_files_do_not_escape_the_folder(self):
        self.assertEqual(self.call("GET", "/static/../server.py")[0], 404)
        self.assertEqual(self.call("GET", "/static/%2e%2e/server.py")[0], 404)


if __name__ == "__main__":
    unittest.main()
