# Ergon (ἔργον)

A local, minimal day planner: an ordered list for today, projects for longer work, an inbox for ideas, repeating tasks, reminders, and a map of your goals.

In Greek, **ergon** (ἔργον) means work, deed, or task. Like [Zetesis](../zetesis/README.md), Ergon runs locally and needs only Python's standard library and SQLite; there is no account, no build step, and no internet connection.

## How It Works

Every task lives in one place, and its day and project decide where it shows up:

| | No project | In a project |
|---|---|---|
| **No day** | Inbox | The project |
| **Has a day** | That day | That day *and* the project |

- **Today** is the list you work through from top to bottom. The back and forward buttons on the side of a mouse step to the day before or after, titled with its weekday, such as Monday, which you can plan the same way (a past day only shows what it held); **Today** in the sidebar, or `⌘ T`, comes back to today. In other views the side buttons do nothing.
- **Week** shows a week's days side by side, starting on the first day of the week where you live (in the Mac app, the one set in System Settings). Each day says how much of its time its tasks take, and **Sprint Plan** sets the week up; see [Planning the Week](#planning-the-week). Add a task to a day from the `+` that appears as you hover over it, and drag a task from one day to another to reschedule it (or select it and press `⌥ ←` / `⌥ →`). The arrows at the top, `←` and `→`, or the mouse's side buttons move between weeks, and **Today** comes back to this one. Earlier days show what was done, and tasks still open from them in red. In a narrow window the days sit one under another.
- **Inbox** is for ideas you have not placed yet. Giving a task a day or a project moves it out. Tasks whose day has passed wait at its top, under **Overdue**.
- **Repeating** holds the tasks that come back, such as the gym 6 times a week; see [Repeating Tasks](#repeating-tasks).
- **Goals** is a map of boxes of text joined by arrows, for thinking through what you're aiming at; see [Goals](#goals).
- **Projects** hold longer-term work. Give a task in a project a day and it also appears on that day's list, labeled with its project, while staying in the project.

Every list keeps the order you put it in: drag a task, or select it and press `⌥ ↑` / `⌥ ↓`. Only Done lists are in the order things were finished.

Unfinished tasks are never lost: once their day has passed they leave Today and wait at the top of the Inbox under **Overdue**, labeled with the day they were for. They come oldest first, and newly overdue ones join the bottom, until you drag them into another order. Give one a new day to plan it again (right-click it, press `t` for today or `d` for a day, or drag it onto a day in Sprint Plan), or drag it down into the Inbox's own list to take its day away (not a project's task, which stays in its project). Missed repeating tasks stay in Today, under **Repeating**.

Finishing a task crosses it out where it is, and nothing else moves; uncheck it to take that back. It stays there for the rest of the day. A day keeps everything planned for it, so Week shows what each day held, done or not; the Inbox, projects and Search put away tasks finished on earlier days under **Done**, at the bottom.

## Using It

Your cursor starts in the add box, so you can type a task and press Enter right away. Press `⌘ J` from anywhere to jot something into the Inbox without leaving what you are looking at. `⌘ T`, `⌘ U` and `⌘ I` open Today, Week and the Inbox (in the Ergon app; a normal browser tab keeps `⌘ T` for itself), and `⌘ L` and `⌘ F` [search](#search).

Click anywhere on a task and type to edit it; clearing it deletes the task. To link some of its text, select the text and paste a URL (this works in the add box too); a URL pasted on its own also becomes a link. Click a link to open it. Right-click a task (or Control-click it) for its actions, each with its key:

- **Do Today** (`t`): do it today, or take it off today (repeating tasks come and go by their schedule instead)
- **Pick a Day…** (`d`): pick a day, or make the task repeat with **Repeat**
- **Remind Me…** (`r`): set a reminder
- **Move to Project…** (`p`): move it to a project, or type a new name to create one
- **Move to Folder…** (`f`): for a repeating task, put it in one of Repeating's folders, or type a new name to create one
- **Delete** (`⌫`): delete it (with undo)

Drag a task onto **Today**, **Inbox**, or a project in the sidebar to assign it there. Drag projects in the sidebar to reorder them, and drag Today, Week, Inbox, Repeating, Goals and Search to put them in the order you like. A project's `⋯` menu adds a description, which appears under its name and can hold links written `[[https://example.com][label]]`; click it to edit. The same menu completes or deletes the project; completed projects stay under *completed* in the sidebar and can be reopened.

Everything also works from the keyboard: `⌃N` and `⌃P` move through tasks, `Enter` finishes the selected one, and `Delete` removes it. While editing, `Enter` saves your change (or finishes the task if you changed nothing), and `Esc` cancels. Menus work the same way: the arrow keys or `⌃N` and `⌃P` move, `Tab` reaches the calendar and time, and `Enter` picks. Press `Esc` to leave the add box, then `?` to see all the shortcuts.

## Planning the Week

Plan once a week, then spend the week doing. Each task can say how long it takes, and each day has some time for tasks; Week adds them up.

- **How long a task takes**: type it in hours and minutes in the box at the end of each task (or press `m` to get there): `4h`, `15m`, `1h30m` (or `1h 30`, `1.5h`, `90m`). A number on its own is hours, so `0.5` is half an hour. Enter keeps it, `Esc` takes it back, and an empty box counts as no time. You can also end a task with it as you add it, such as `Fix the bike ~1h`, `~45m` or `~1.5h`; this works in the Jot box too.
- **Time for each day**: 2 hours on weekdays and 5 on weekends to begin with. Click the line under a day in Week to change it, for that day only (out on Wednesday evening: None) or for every such weekday.
- **What each day takes**: under each day, its tasks' time out of the day's, such as *1h 30m of 2h*, with a bar that turns red once the day holds more than it has. Finished tasks still count, since they were part of the plan, and so do repeating tasks that take time: give the gym 1h and it shows, faded, on every day it will come back, not just its next one. The week's total is at the top, and Today's beside its date.
- **Sprint Plan** (the button at the top of Week, or `⇧ ⌘ U`) shows the week holding tomorrow, which on a Sunday is the week to come, with the Inbox beside it in place of the sidebar. The Inbox there is the same as in its own view: **Overdue** first, then the Inbox's own tasks, in the same order. Drag tasks onto days until the bars fill up; drag one back onto the list to take it off its day. The list's name is a menu: switch it to a project, for its tasks with no day yet. **Done**, or `Esc`, goes back to Week. A **Sprint planning** task comes back every Sunday as a reminder to do it.

## Search

`⌘ L` searches all your tasks, in **Search** (also in the sidebar). `⌘ F` searches just the list on screen, such as Today, the week shown, or a project, keeping the tasks that match where they are. Both find a task by the words in its title or its project's name, ignoring case and accents, so "cafe" finds "Café".

As you type, the best match is selected; `↓` `↑` (or `⌃N` `⌃P`) move through what was found, and `Enter` goes to the selected task: from Search, to the list it lives in, and from `⌘ F`, back to the whole list. Either way it stays selected, so the keys work on it from there (`Enter` finishes it, `d` picks a day, and so on). You can also check off, edit, or drag a task found, straight from the results.

- **Search** puts the best matches first, saying where each task is, with tasks finished on earlier days under Done. It covers every open task, everything in your projects, and whatever else was finished in the last month. `⌘ L` comes back to your last search, and after `⌘ F` searches every task for the same words.
- **`⌘ F`** keeps the list's own order, and you can still put it in order by dragging or `⌥ ↑` / `⌥ ↓`; the tasks it hides keep their places.

`Esc` clears the box, and again puts it away (or leaves Search for where you were).

## Repeating Tasks

A repeating task comes back, such as the gym 6 times a week or the laundry every other Sunday. Add one in **Repeating** in the sidebar: type its name and press Enter, and its schedule menu opens (it comes back every day until you choose otherwise). Any task can repeat the same way, from **Repeat** in its calendar menu.

- **Every day, every weekday, every week, every 2 weeks, every month, every year**, counted from the task's day.
- **Custom…** works like Apple's apps: every few days, weeks, months or years; on chosen weekdays; on chosen days of the month, or on a day such as "the second Tuesday" or "the last weekday"; and optionally until an end date.
- **Times a week…** is for tasks done some number of times a week or month on any days, like the gym 6 times a week. Such a task is due every day until it has been done that many times, then not again until the next week or month; it shows how far along it is, such as ↻ 4/6.

**Repeating** lists every repeating task in the order you put them in (a new one goes to the bottom), with how often it comes back and when it is next due. Those due today also have their own section in Today, **Repeating**, below today's own tasks, in the same order, and each appears on its day in Week. Hover over ↻ to see how a task repeats.

**Folders** keep Repeating in order, such as one for birthdays and one for sport. **New Folder**, at the top of Repeating, makes one. Drag a repeating task into a folder, or choose **Move to Folder…** (`f`); a folder's own add box adds a repeating task straight into it. Click a folder's name to close or open it (each device remembers which are closed), and right-click it to rename or delete it. Deleting a folder keeps its tasks, which go back to Repeating outside any folder, and Undo puts them back. Folders are only in Repeating: Today and Week show the tasks as before, and a task's next date stays in its folder.

As in Reminders, one task stands for each series. Finishing it adds its next date as a new task, with its reminder at the same time. The finished one stays crossed out in its place for the rest of the day, and then the next date takes over there; Week shows the next date on its day straight away. Uncheck it to take the next date back. **Skip to next**, in the Repeat menu, moves a repeating task on without finishing it. A missed one does not pile up: it waits, in red, until its next date comes, and then moves on to that date, so the gym missed yesterday is simply today's gym. Taking a repeating task off its day (Back to Inbox, No date) stops it repeating.

Months without the chosen day are skipped, so a task on the 31st skips 30-day months; choose "the last day" instead to land on every month's end.

## Goals

**Goals** is a space you can move around in, where you write boxes of text and join them with arrows, like a mind map.

- **Add a box** by double-clicking anywhere, or pressing `n`. Type, then press `Enter`; `⇧ Enter` starts a new line. `Esc` throws a new box away.
- **Join boxes** by dragging from the dot on a box's right edge onto another box. Let go on empty space instead, and a new box starts there, already joined. With a box selected, `Tab` adds a box joined to it, to its right; `Tab` while writing does the same, so a chain of ideas can be typed out in one go. Two boxes are joined once, whichever way the arrow points.
- **Edit** by double-clicking a box, clicking the selected box, or pressing `Enter`. Clicking away saves; `Esc` puts the text back. Emptying a box deletes it.
- **Move** a box by dragging it; its arrows follow.
- **Delete** a box or an arrow by clicking it and pressing `Delete`, with undo from the toast. Deleting a box takes its arrows with it, and Undo brings them back.
- **Move around** by dragging empty space, or scrolling with two fingers; pinch to zoom, or use `−` and `+` at the top. **Show All** fits every box on screen. Each browser, and the Mac app, remembers where you were.

`⌘ F` dims the boxes that don't match what you type.

## Reminders

A reminder sends a macOS notification at its date and time, whether or not Ergon is open. Reminders do not fire for finished or deleted tasks. Setting a reminder on a task without a day also puts it on that day's list.

If the Mac is asleep, the reminder arrives within a minute of waking and says when it was set for. Clicking a notification opens Ergon. Notifications follow your Focus and notification settings, and appear on this Mac only.

## Start the App

Run this once from the workspace root:

```sh
python3 ergon/server.py --install-launch-agent
```

It keeps Ergon running at <http://127.0.0.1:8001>, including after you log in, and builds a small `notifier/Ergon.app` so notifications appear under Ergon's name and icon (this needs Apple's command line tools; without them they appear as Script Editor notifications). Click **Allow** when macOS asks, or turn it on later in **System Settings → Notifications → Ergon**. Until then, reminders still arrive as Script Editor notifications.

Unlike Zetesis, which stops when its last window closes, Ergon stays running, because reminders have to fire with no window open. The log is in `~/Library/Logs/Ergon/server.log`. Run the command again after moving Ergon or upgrading Python. To stop running it in the background:

```sh
python3 ergon/server.py --uninstall-launch-agent
```

To give Ergon an app of its own, run once:

```sh
python3 ergon/server.py --install-mac-app
```

It builds `Ergon.app` into `~/Applications`, again with Apple's command line tools: Ergon in a window of its own, with Ergon's menus instead of a browser's, and the File, Edit, View and Window menus a Mac app has. Clicking a notification opens it. Closing its window leaves it in the Dock, as Notes does, and **View › Reload** (`⌘ R`) picks up changes to Ergon. Its text starts a little larger than in a browser; **View › Zoom In** and **Zoom Out** (`⌘ +`, `⌘ −`) change it, and it stays as you leave it. It also does four things a browser can't:

- **Weeks start on the Mac's first day of the week**, from System Settings › General › Language & Region, as Calendar's do.
- **Jot from any app** with `⌃ ⌥ Space`. A Jot box opens over whatever you're doing, Enter puts what you typed in the Inbox, and you're back where you were.
- **Today's count on the Dock icon**, the same number as beside Today in the sidebar.
- **It opens at login**, so the shortcut and the count are always there. **Ergon › Open at Login** turns that off.

Run the command again only if `mac/main.swift` changes; `--uninstall-mac-app` removes the app, and takes it out of the login items. You can instead install Ergon from Brave or Chrome, with **Install Ergon** from the address bar or the menu.

To run it by hand instead (reminders fire only while it runs):

```sh
python3 ergon/server.py              # or --port 8080
```

## Data and Backup

Everything is in `ergon/ergon.sqlite3`, which git ignores. To back it up, copy that file with Ergon stopped (or use `sqlite3 ergon.sqlite3 ".backup copy.sqlite3"` while it runs). Deleted tasks and projects can be undone from the toast that appears (Undo covers everything deleted while it shows), and are permanently removed after 30 days.

## Development

```sh
python3 -m unittest discover -s ergon/tests
```

The app is `server.py` (API, repeating tasks, and reminders), `static/app.js` (the interface), `static/goals.js` (the Goals map), `notifier/main.swift` (the notification helper), and `mac/main.swift` (the Mac app, which shows the interface in WebKit and gives it its menus). The server only listens on `127.0.0.1` and rejects requests from other sites, since it has no login.
