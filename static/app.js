"use strict";

const ICONS = {
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 5 2 6.5 2 6.5h-15s2-1.5 2-6.5ZM10 19.5a2.2 2.2 0 0 0 4 0"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M4.5 11.5V10A3.5 3.5 0 0 1 8 6.5h11.5M16.5 3.5l3 3-3 3M19.5 12.5V14a3.5 3.5 0 0 1-3.5 3.5H4.5M7.5 20.5l-3-3 3-3"/></svg>',
};

const TOAST_MS = 6000;
const SYNC_MS = 15000;
const DRAG_START_PX = 5;
const EDGE_SCROLL_PX = 56;
const VIEW_KEYS = { t: "#today", u: "#week", i: "#inbox" };
// A link in a description: [[url][label]], or a plain url.
const LINK_RE = /\[\[(https?:[^\]]+)\](?:\[([^\]]*)\])?\]|https?:\/\/[^\s<>)\]]*[^\s<>)\].,;:!?'"]/g;
// A pasted url, on its own.
const URL_RE = /^https?:\/\/[^\s\]]+$/;
// How long a task takes, at the end of its title: "~45m", "~1h", "~1h30" or "~1.5h".
const ESTIMATE_RE = /\s*~(?:(\d+(?:[.,]\d+)?)\s*h(?:\s*(\d+)\s*m?)?|(\d+)\s*m(?:in)?)$/i;
const MAX_MINUTES = 24 * 60;
// The usual choices for the time a day has.
const DAY_TIMES = [0, 30, 60, 90, 120, 150, 180, 240, 300, 360, 480, 600];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const main = document.getElementById("main");
const groupsEl = document.getElementById("groups");
const pageTitle = document.getElementById("page-title");
const pageSubtitle = document.getElementById("page-subtitle");
const projectDescription = document.getElementById("project-description");
const projectMenuButton = document.getElementById("project-menu");
const projectList = document.getElementById("project-list");
const viewsNav = document.getElementById("views");
const weekNav = document.getElementById("week-nav");
const planButton = document.getElementById("week-plan");
const searchBar = document.getElementById("search-bar");
const searchInput = document.getElementById("search-input");
const clearSearch = document.getElementById("clear-search");
const noMatches = document.getElementById("no-matches");
const completedToggle = document.getElementById("completed-toggle");
const completedProjects = document.getElementById("completed-projects");
const newProjectForm = document.getElementById("new-project");
const newProjectInput = document.getElementById("new-project-input");
const popover = document.getElementById("popover");
const capture = document.getElementById("capture");
const captureInput = document.getElementById("capture-input");
const help = document.getElementById("help");
const toastEl = document.getElementById("toast");

const state = { tag: "", today: "", projects: [], tasks: [], boxes: [], arrows: [], time: { weekdays: {}, days: {} } };
let view = parseHash();
let renderedView = "";
let selectedId = null;
let drag = null;
let popoverRow = null;
// Run once the open popover closes, unless another popover takes its place.
let afterPopover = null;
let toastTimer = 0;
// The first day of the week shown in Week; null follows today.
let shownWeek = null;
// The list Planning shows beside the week: "inbox", "overdue" or "project:<id>".
let planFrom = "inbox";
// The day shown in Today, which the mouse's side buttons step through; null follows today.
let shownDay = null;
// Search: ⌘F searches the view on screen, ⌘L every task, in the Search view. `query` is what the
// box holds; `searchOpen` shows the box in a view other than Search, which always has it.
let query = "";
let searchOpen = false;
// Search keeps what it last searched for, and the view to go back to.
let searchedFor = "";
let viewBeforeSearch = "#today";
// The test a task passes to be shown while searching, or null when nothing is searched for.
let matching = null;
// A task to select once its view is on screen, after going to it from Search.
let reveal = null;
// Undo brings back every task deleted while its message is showing.
let recentlyDeleted = [];
let rendering = false;
let pendingWrites = 0;
let writeCount = 0;
let writeQueue = Promise.resolve();
// Text typed into a list's add box but not added yet, kept while you look at other views.
const drafts = new Map();

// Dates: days are local YYYY-MM-DD strings, reminders local YYYY-MM-DDTHH:MM.

const pad = (value) => String(value).padStart(2, "0");
const toDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const toMinute = (date) => `${toDay(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
// The server's local timestamps, so a task finished today is finished on state.today.
const stamp = () => { const now = new Date(); return `${toMinute(now)}:${pad(now.getSeconds())}`; };

function toDate(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

function addDays(day, count) {
  const date = toDate(day);
  date.setDate(date.getDate() + count);
  return toDay(date);
}

const daysBetween = (from, to) => Math.round((toDate(to) - toDate(from)) / 864e5);
const formatDay = (day, options) => toDate(day).toLocaleDateString(undefined, options);
const formatTime = (minute) => new Date(minute).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function dayLabel(day) {
  if (day === state.today) return "Today";
  if (day === addDays(state.today, 1)) return "Tomorrow";
  if (day === addDays(state.today, -1)) return "Yesterday";
  if (day > state.today && day < addDays(state.today, 7)) return formatDay(day, { weekday: "long" });
  return formatDay(day, { month: "short", day: "numeric" });
}

// On today, or on the task's own day, the time says enough.
function reminderLabel(remindAt, taskDay) {
  const day = remindAt.slice(0, 10);
  return day === state.today || day === taskDay ? formatTime(remindAt) : `${dayLabel(day)} ${formatTime(remindAt)}`;
}

// Lists: "inbox", "day:YYYY-MM-DD", "project:<id>", "overdue" for tasks whose day has passed, "habits",
// "habits:today" for habits due today or missed, and "search" for every task. Every list but Search keeps
// the order its tasks are dragged into: a task's place on its day, in its project or the Inbox, in Habits,
// and in Overdue are kept apart. Search puts the best matches first.
// A finished task stays where it is, crossed out, for the rest of the day; a day's list keeps all its tasks.
// Lists holding many days put away tasks finished on earlier days, under Done or out of sight.

const isOverdue = (task) => Boolean(task.day && task.day < state.today);
const finishedToday = (task) => Boolean(task.done_at?.startsWith(state.today));
// An open task is a habit while it repeats; a finished one stays a day of its habit.
const isHabit = (task) => Boolean(task.done_at ? task.series_id : task.repeat);
// Habit lists show the habits finished today, so a tap by mistake can be undone there.
const habitShown = (task) => isHabit(task) && (!task.done_at || finishedToday(task));
// Lists that hold tasks from many days, so a task new to one has no place there yet and goes after the rest, by day.
const MANY_DAYS = ["overdue", "habits", "habits:today"];

function inList(task, list) {
  if (list === "search") return true;
  if (list === "inbox") return !task.project_id && !task.day;
  if (list === "overdue") return isOverdue(task) && !isHabit(task) && (!task.done_at || finishedToday(task));
  if (list === "habits") return habitShown(task);
  if (list === "habits:today") return habitShown(task) && task.day <= state.today;
  if (list.startsWith("day:")) return task.day === list.slice(4);
  return task.project_id === list.slice(8);
}

function rankKey(list) {
  if (list === "overdue") return "overdue_rank";
  if (list.startsWith("habits")) return "habit_rank";
  return list.startsWith("day:") ? "day_rank" : "list_rank";
}

// Whether a list shows a task in its place: a finished one, until the day ends. A repeating task finished
// today stands in for its next date, which stays out of sight till then wherever both would show.
function inPlace(task, list) {
  if (list.startsWith("day:")) return true;
  if (task.done_at) return finishedToday(task);
  return !task.series_id || !state.tasks.some((other) => other.next_id === task.id && finishedToday(other));
}

// The tasks a list shows, in its order: open ones, and finished ones still in their places.
function listTasks(list) {
  const key = rankKey(list);
  const rank = (task) => task[key] ?? Infinity;
  const byDay = MANY_DAYS.includes(list) ? (a, b) => a.day.localeCompare(b.day) || a.day_rank - b.day_rank : () => 0;
  // Two tasks with no place yet compare as NaN, which falls through to their days.
  const tasks = state.tasks.filter((task) => inList(task, list) && inPlace(task, list));
  return tasks.sort(list === "search" ? bySearch : (a, b) => rank(a) - rank(b) || byDay(a, b));
}

// Tasks finished on earlier days, which the Inbox, projects and Search keep under Done, latest first.
function doneTasks(list) {
  return state.tasks
    .filter((task) => task.done_at && inList(task, list) && !inPlace(task, list))
    .sort((a, b) => b.done_at.localeCompare(a.done_at));
}

function nextRank(list) {
  const key = rankKey(list);
  return listTasks(list).reduce((rank, task) => Math.max(rank, (task[key] ?? -1) + 1), 0);
}

const findTask = (id) => state.tasks.find((task) => task.id === id);
const findProject = (id) => state.projects.find((project) => project.id === id);

function viewKey() {
  if (view.plan) return "plan";
  return view.kind === "project" ? `project:${view.id}` : view.kind;
}

function parseHash() {
  const [kind, id] = location.hash.slice(1).split("/");
  if (kind === "project" && id) return { kind, id };
  // Planning is Week with what has no day yet beside it.
  if (kind === "plan") return { kind: "week", plan: true };
  // Week took the place of Upcoming and Calendar.
  if (["week", "upcoming", "calendar"].includes(kind)) return { kind: "week" };
  return { kind: ["inbox", "habits", "goals", "search"].includes(kind) ? kind : "today" };
}

function groupsForView() {
  if (view.kind === "today" && dayShown() !== state.today) {
    // Another day is laid out like today, in the order it has in Week.
    const day = dayShown();
    const list = `day:${day}`;
    const past = day < state.today;
    return [
      { list, takes: (task) => !isHabit(task), placeholder: "Add a task", emptyText: "Nothing planned.", past },
      ...(listTasks(list).some(isHabit) ? [{ list, key: `habits:${day}`, takes: isHabit, part: "habits", title: "Repeating", past }] : []),
    ];
  }
  if (view.kind === "today") {
    // Today's own tasks come first, then the habits due today. Overdue tasks wait in the Inbox.
    const list = `day:${state.today}`;
    return [
      { list, takes: (task) => !isHabit(task), placeholder: "Add to today", emptyText: "Nothing planned." },
      ...(listTasks("habits:today").length ? [{ list: "habits:today", takes: isHabit, part: "habits", title: "Repeating" }] : []),
    ];
  }
  if (view.kind === "inbox") {
    // Tasks whose day has passed come first, oldest first, to be planned again. Only they can be put in
    // order there: anything else would have to move into the past. One dragged down into the Inbox loses
    // its day, but a project's stays in its project.
    const overdue = listTasks("overdue").length > 0;
    return [
      ...(overdue ? [{ list: "overdue", takes: (task) => inList(task, "overdue"), part: "overdue", title: "Overdue" }] : []),
      { list: "inbox", takes: (task) => !task.project_id, title: overdue ? "Inbox" : "", placeholder: "Jot something down",
        emptyText: overdue ? "" : "Nothing waiting to be sorted." },
    ];
  }
  if (view.kind === "habits") {
    return [{ list: "habits", takes: isHabit, placeholder: "Add a repeating task", emptyText: "Nothing repeats yet. Add a task, then choose how often it comes back." }];
  }
  if (view.kind === "project") return [{ list: `project:${view.id}`, placeholder: "Add a task", emptyText: "" }];
  if (view.kind === "search") return [{ list: "search", part: "results" }];
  // Goals is a map, in goals.js.
  if (view.kind === "goals") return [];
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = addDays(weekShown(), index);
    const placeholder = day === state.today ? "Add to today" : "Add a task";
    // A past day's tasks can be put in order, but nothing can be moved into the past.
    const takes = day < state.today ? (task) => task.day === day : null;
    return { list: `day:${day}`, day, week: true, compact: true, past: day < state.today, takes, placeholder };
  });
  return view.plan ? [backlogGroup(), ...days] : days;
}

// Planning puts what has no day yet beside the week: the Inbox, tasks left open on past days, or a project's.
const inBacklog = (task, list) => (list.startsWith("project:") ? task.project_id === list.slice(8) && !task.day : inList(task, list));

function backlogGroup() {
  if (planFrom.startsWith("project:") && !findProject(planFrom.slice(8))) planFrom = "inbox";
  const list = planFrom;
  const project = list.startsWith("project:") ? findProject(list.slice(8)) : null;
  const group = { list, key: `backlog:${list}`, backlog: true, takes: (task) => inBacklog(task, list) };
  if (list === "overdue") return { ...group, title: "Overdue", part: "overdue", emptyText: "Nothing left over." };
  if (project) return { ...group, title: project.title, placeholder: "Add a task", emptyText: "Everything here has a day." };
  return { ...group, title: "Inbox", placeholder: "Jot something down", emptyText: "Nothing waiting to be sorted." };
}

// Sync: changes apply locally first, then reach the server one at a time.

function send(method, path, body) {
  pendingWrites += 1;
  writeCount += 1;
  writeQueue = writeQueue
    .then(async () => {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error((await response.json()).error);
    })
    .catch((error) => {
      showToast(error instanceof TypeError ? "Not saved: Ergon isn't running" : `Not saved: ${error.message}`);
      state.tag = "";
    })
    .finally(() => {
      pendingWrites -= 1;
      if (!state.tag) refresh();
    });
}

// Updates in place, so an open menu or an Undo still changes the task on screen after a sync.
function adopt(known, fresh) {
  const byId = new Map(known.map((item) => [item.id, item]));
  return fresh.map((item) => Object.assign(byId.get(item.id) ?? item, item));
}

async function refresh() {
  if (drag || pendingWrites) return;
  const startedAt = writeCount;
  try {
    const response = await fetch(`/api/state?tag=${encodeURIComponent(state.tag)}`);
    if (response.status === 204) return;
    const fresh = await response.json();
    if (drag || pendingWrites || startedAt !== writeCount) return;
    Object.assign(state, fresh, {
      tasks: adopt(state.tasks, fresh.tasks),
      projects: adopt(state.projects, fresh.projects),
    });
    render();
  } catch {
    // The server is restarting or asleep; the next tick catches up.
  }
}

// Changing tasks

function patchTask(task, fields, serverFields = fields) {
  Object.assign(task, fields);
  send("PATCH", `/api/tasks/${task.id}`, serverFields);
  animated(render);
}

// Task boxes wrap like the tasks they become, but a task is still one line of text.
function submitOnEnter(event) {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  event.target.form.requestSubmit();
}

function pasteOneLine(event) {
  event.preventDefault();
  const text = event.clipboardData.getData("text/plain");
  const box = event.target.closest("textarea");
  const selected = box ? box.value.slice(box.selectionStart, box.selectionEnd) : getSelection().toString();
  // A url pasted over selected text links that text.
  if (URL_RE.test(text.trim()) && selected.trim()) {
    if (box) document.execCommand("insertText", false, linkMarkup(selected, text.trim()));
    else document.execCommand("createLink", false, text.trim());
    return;
  }
  document.execCommand("insertText", false, text.replace(/\s+/g, " "));
}

// Spaces at either end of the selection stay outside the link.
function linkMarkup(selected, url) {
  const [, before, label, after] = selected.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return `${before}[[${url}][${label}]]${after}`;
}

// A title ending in "~1h" says how long the task takes, and leaves that off the title.
function splitEstimate(text) {
  const match = text.match(ESTIMATE_RE);
  const title = match ? text.slice(0, match.index).trim() : "";
  if (!title) return { title: text, minutes: null };
  const [, hours, extra, alone] = match;
  const minutes = alone ? Number(alone) : Math.round(Number(hours.replace(",", ".")) * 60) + Number(extra ?? 0);
  return minutes > 0 && minutes <= MAX_MINUTES ? { title, minutes } : { title: text, minutes: null };
}

function createTask(title, list, repeat = null) {
  const { title: clean, minutes } = splitEstimate(title.replace(/\s+/g, " ").trim());
  if (!clean) return null;
  const id = crypto.randomUUID();
  const task = {
    id, title: clean, project_id: list.startsWith("project:") ? list.slice(8) : null,
    day: list.startsWith("day:") ? list.slice(4) : null, day_rank: 0, list_rank: 0,
    remind_at: null, reminded_at: null, done_at: null, repeat, next_id: null, series_id: repeat ? id : null,
    habit_rank: repeat ? nextRank("habits") : null, overdue_rank: null, minutes,
  };
  task[rankKey(list)] = nextRank(list);
  state.tasks.push(task);
  send("POST", "/api/tasks", { id, title: clean, list, ...(repeat ? { repeat } : {}), ...(minutes ? { minutes } : {}) });
  render();
  return task;
}

// A new habit comes back every day until you choose otherwise, in its schedule menu, which opens straight away.
function createHabit(title) {
  const task = createTask(title, `day:${state.today}`, "FREQ=DAILY");
  const anchor = task && groupsEl.querySelector(`.row[data-id="${task.id}"]`);
  if (!anchor) return;
  openRepeatMenu(task, anchor);
  afterPopover = focusAddRow;
}

// Finishing a repeating task adds its next date as a task of its own, which takes the repeat with
// it; reopening the finished one takes that back. The server does the same, so this only shows it sooner.
function setDone(task, done) {
  const fields = { done_at: done ? stamp() : null };
  const serverFields = { done };
  if (done && !task.done_at && task.repeat && task.day) {
    const next = nextDate(task);
    if (next) {
      const series = task.series_id ?? task.id;
      const following = { ...task, ...next, id: crypto.randomUUID(), done_at: null, next_id: null, series_id: series,
        day_rank: nextRank(`day:${next.day}`) };
      state.tasks.push(following);
      Object.assign(fields, { repeat: null, next_id: following.id, series_id: series });
      serverFields.next_id = following.id;
    }
  } else if (!done && task.done_at && task.next_id) {
    const following = findTask(task.next_id);
    if (following && !following.done_at) {
      state.tasks = state.tasks.filter((other) => other !== following);
      fields.repeat = following.repeat;
    }
    fields.next_id = null;
  }
  patchTask(task, fields, serverFields);
}

function setDay(task, day) {
  if (day === task.day) return;
  // A task given another day leaves Overdue, so its place there goes too.
  const fields = { day, overdue_rank: null };
  if (day) fields.day_rank = nextRank(`day:${day}`);
  else if (!task.project_id) fields.list_rank = nextRank("inbox");
  // A repeat counts from a day, so a task taken off its day stops repeating, and leaves Habits.
  if (!day) Object.assign(fields, { repeat: null, habit_rank: null });
  patchTask(task, fields, { day });
}

// Finishing a task selects the next open one, so a list can be worked through by keyboard.
function toggleDone(task) {
  if (task.done_at) {
    setDone(task, false);
    return;
  }
  const next = neighborRow(task.id);
  setDone(task, true);
  if (next) select(next.dataset.id);
  else clearSelection();
}

function toggleToday(task) {
  const previous = task.day;
  if (task.day !== state.today) {
    setDay(task, state.today);
    return;
  }
  const { repeat } = task;
  setDay(task, null);
  showToast(task.project_id ? "Off today" : "Moved to Inbox", () => {
    setDay(task, previous);
    if (repeat) setRepeat(task, repeat);
  });
}

function setProject(task, projectId) {
  const fields = { project_id: projectId };
  if (projectId) fields.list_rank = nextRank(`project:${projectId}`);
  patchTask(task, fields, { project_id: projectId });
}

function setReminder(task, remindAt) {
  const fields = { remind_at: remindAt, reminded_at: null };
  const serverFields = { remind_at: remindAt };
  // A reminder on an unscheduled task also puts it on that day's list.
  if (remindAt && !task.day) {
    const day = remindAt.slice(0, 10);
    fields.day = serverFields.day = day;
    fields.day_rank = nextRank(`day:${day}`);
  }
  patchTask(task, fields, serverFields);
}

function setRepeat(task, repeat) {
  const fields = { repeat };
  if (repeat) fields.series_id = task.series_id ?? task.id;
  // A new habit goes to the bottom of Habits; one that stops repeating leaves it.
  if (repeat && task.habit_rank == null) fields.habit_rank = nextRank("habits");
  if (!repeat) fields.habit_rank = null;
  const day = repeat ? firstDayOf(parseRule(repeat), task.day) : task.day;
  if (!day && repeat) return;
  if (day !== task.day) Object.assign(fields, { day, day_rank: nextRank(`day:${day}`) });
  patchTask(task, fields, { repeat });
}

function setMinutes(task, minutes) {
  if (minutes !== task.minutes) patchTask(task, { minutes });
}

// `day` is a day, or a weekday's code for every such day; a day set to null goes back to its weekday's time.
function setDayTime(day, minutes) {
  if (day in state.time.weekdays) state.time.weekdays[day] = minutes;
  else if (minutes === null) delete state.time.days[day];
  else state.time.days[day] = minutes;
  send("PATCH", "/api/time", { day, minutes });
  render();
}

function skipDate(task) {
  const next = nextDate(task, false);
  if (next) patchTask(task, { ...next, day_rank: nextRank(`day:${next.day}`) }, { skip: true });
}

function deleteTask(task) {
  const batch = [...recentlyDeleted, task];
  state.tasks = state.tasks.filter((other) => other !== task);
  send("PATCH", `/api/tasks/${task.id}`, { deleted: true });
  animated(render);
  showToast(batch.length > 1 ? `Deleted ${batch.length} tasks` : "Deleted", () => {
    state.tasks.push(...batch);
    batch.forEach((each) => send("PATCH", `/api/tasks/${each.id}`, { deleted: false }));
    animated(render);
  });
  recentlyDeleted = batch;
}

// The same for every list: `ids` are the tasks a list shows, in their new order.
function applyOrder(list, ids) {
  // Today's habits are some of Habits, in the same order.
  const whole = list === "habits:today" ? "habits" : list;
  const key = rankKey(whole);
  // A repeating task finished today stands in for its next date, which goes wherever it is put.
  const order = withHidden(whole, ids).flatMap((id) => {
    const next = findTask(findTask(id).next_id);
    return next && inList(next, whole) && !inPlace(next, whole) ? [id, next.id] : [id];
  });
  order.forEach((id, rank) => {
    const task = findTask(id);
    task[key] = rank;
    if (whole.startsWith("day:") && task.day !== whole.slice(4)) Object.assign(task, { day: whole.slice(4), overdue_rank: null });
    else if (whole.startsWith("project:")) task.project_id = whole.slice(8);
    else if (whole === "inbox") Object.assign(task, { project_id: null, day: null, repeat: null, habit_rank: null, overdue_rank: null });
  });
  send("POST", "/api/order", { list: whole, ids: order });
  render();
}

// Some lists are shown in part, such as today's own tasks without its habits, or Today's habits out of
// all of them. Those not shown keep their places, and the shown ones trade places among themselves.
// A task new to the list goes right after the one shown before it.
function withHidden(list, shown) {
  const before = listTasks(list).map((task) => task.id);
  const showing = new Set(shown);
  const already = shown.filter((id) => before.includes(id));
  let next = 0;
  const order = before.map((id) => (showing.has(id) ? already[next++] : id));
  shown.forEach((id, index) => {
    if (before.includes(id)) return;
    order.splice(index ? order.indexOf(shown[index - 1]) + 1 : 0, 0, id);
  });
  return order;
}

function createProject(title) {
  const project = { id: crypto.randomUUID(), title: title.trim(), description: "", rank: state.projects.length, completed_at: null };
  state.projects.push(project);
  send("POST", "/api/projects", { id: project.id, title: project.title });
  return project;
}

function setProjectCompleted(project, completed) {
  project.completed_at = completed ? new Date().toISOString() : null;
  send("PATCH", `/api/projects/${project.id}`, { completed });
  render();
  if (completed) {
    location.hash = "#today";
    showToast(`Completed ${project.title}`, () => setProjectCompleted(project, false));
  }
}

function deleteProject(project) {
  const tasks = state.tasks.filter((task) => task.project_id === project.id);
  state.projects = state.projects.filter((other) => other !== project);
  state.tasks = state.tasks.filter((task) => task.project_id !== project.id);
  send("PATCH", `/api/projects/${project.id}`, { deleted: true });
  location.hash = "#today";
  render();
  showToast(`Deleted ${project.title}`, () => {
    state.projects.push(project);
    state.tasks.push(...tasks);
    send("PATCH", `/api/projects/${project.id}`, { deleted: false });
    location.hash = `#project/${project.id}`;
    render();
  });
}

// Repeats: RFC 5545 rules, as Apple's apps use, such as FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE.
// Weekdays are numbered as getDay() numbers them, Sunday first. server.py reads them the same way.

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WORKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];
const UNITS = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" };
const POSITIONS = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", [-1]: "last" };

function parseRule(text) {
  const rule = { freq: "DAILY", interval: 1, byDay: [], byMonthDay: [], setPos: 0, weekStart: 1, until: null, times: 0 };
  for (const part of text.split(";")) {
    const [key, value] = part.split("=");
    if (key === "FREQ") rule.freq = value;
    else if (key === "INTERVAL") rule.interval = Number(value);
    else if (key === "BYDAY") rule.byDay = value.split(",").map((code) => WEEKDAY_CODES.indexOf(code));
    else if (key === "BYMONTHDAY") rule.byMonthDay = value.split(",").map(Number);
    else if (key === "BYSETPOS") rule.setPos = Number(value);
    else if (key === "WKST") rule.weekStart = WEEKDAY_CODES.indexOf(value);
    else if (key === "TIMES") rule.times = Number(value);
    else if (key === "UNTIL") rule.until = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  return rule;
}

// Monday first, as the rules list them.
const weekOrder = (days) => [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));

function formatRule(rule) {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay.length) parts.push(`BYDAY=${weekOrder(rule.byDay).map((day) => WEEKDAY_CODES[day]).join(",")}`);
  if (rule.byMonthDay.length) parts.push(`BYMONTHDAY=${[...rule.byMonthDay].sort((a, b) => a - b).join(",")}`);
  if (rule.setPos) parts.push(`BYSETPOS=${rule.setPos}`);
  if (rule.times) parts.push(`TIMES=${rule.times}`);
  // Where a week starts only matters for counting a week's times, or for several days every few weeks.
  if (rule.weekStart !== 1 && rule.freq === "WEEKLY" && (rule.times || (rule.interval > 1 && rule.byDay.length > 1))) {
    parts.push(`WKST=${WEEKDAY_CODES[rule.weekStart]}`);
  }
  if (rule.until) parts.push(`UNTIL=${rule.until.replaceAll("-", "")}`);
  return parts.join(";");
}

// Whether a rule, counted from `anchor` (one of its dates), falls on `day`.
function occursOn(rule, anchor, day) {
  const date = toDate(day);
  const start = toDate(anchor);
  const { interval } = rule;
  // A habit done some times a week or month can be done on any day.
  if (rule.times) return true;
  if (rule.freq === "DAILY") return daysBetween(anchor, day) % interval === 0;
  if (rule.freq === "WEEKLY") {
    const weekOf = (value) => addDays(value, -((toDate(value).getDay() - rule.weekStart + 7) % 7));
    const weekdays = rule.byDay.length ? rule.byDay : [start.getDay()];
    return (daysBetween(weekOf(anchor), weekOf(day)) / 7) % interval === 0 && weekdays.includes(date.getDay());
  }
  const [year, month] = [date.getFullYear(), date.getMonth()];
  if (rule.freq === "YEARLY") {
    return (year - start.getFullYear()) % interval === 0 && month === start.getMonth() && date.getDate() === start.getDate();
  }
  if (((year - start.getFullYear()) * 12 + month - start.getMonth()) % interval !== 0) return false;
  const length = new Date(year, month + 1, 0).getDate();
  if (rule.setPos) {
    const matching = Array.from({ length }, (_, index) => index + 1)
      .filter((number) => rule.byDay.includes(new Date(year, month, number).getDay()));
    return matching.at(rule.setPos > 0 ? rule.setPos - 1 : rule.setPos) === date.getDate();
  }
  // As in Apple's apps, a month without the day (the 31st, say) is skipped.
  const monthDays = rule.byMonthDay.length ? rule.byMonthDay : [start.getDate()];
  return monthDays.some((number) => (number > 0 ? number : length + 1 + number) === date.getDate());
}

// The rule's first date on or after `from`, or null once it has ended.
function firstDate(rule, anchor, from) {
  for (let offset = 0; offset < 366 * (8 + rule.interval); offset += 1) {
    const day = addDays(from, offset);
    if (rule.until && day > rule.until) return null;
    if (occursOn(rule, anchor, day)) return day;
  }
  return null;
}

// The day and reminder of a repeating task's next date. That is never in the past, so a task
// missed for a while comes back once, not once per missed date.
// A habit done some times a week or month comes back the next day until it has been done that many
// times, then on the first day of the next week or month. Skipping a day does not count it.
function nextDate(task, finishing = true) {
  const rule = parseRule(task.repeat);
  const after = addDays(task.day, 1);
  let day;
  if (rule.times) {
    const [, end] = period(rule, task.day);
    day = timesDone(task, rule, task.day) + (finishing ? 1 : 0) < rule.times ? after : addDays(end, 1);
    if (day < state.today) day = state.today;
    if (rule.until && day > rule.until) return null;
  } else {
    day = firstDate(rule, task.day, after > state.today ? after : state.today);
  }
  if (!day) return null;
  if (!task.remind_at) return { day };
  const remind = new Date(task.remind_at);
  remind.setDate(remind.getDate() + daysBetween(task.day, day));
  const remindAt = toMinute(remind);
  // A reminder whose time has already passed counts as sent, rather than going off late.
  return { day, remind_at: remindAt, reminded_at: remindAt <= toMinute(new Date()) ? stamp() : null };
}

// A repeating task is on its first date, counted from its day, or from today if it has none.
// A habit done any days of the week starts no earlier than today.
function firstDayOf(rule, day) {
  const from = day ?? state.today;
  const start = rule.times && from < state.today ? state.today : from;
  return firstDate(rule, start, start);
}

// The first and last day of the week or month holding `day`, for counting a habit's times.
function period(rule, day) {
  if (rule.freq === "WEEKLY") {
    const start = addDays(day, -((toDate(day).getDay() - rule.weekStart + 7) % 7));
    return [start, addDays(start, 6)];
  }
  const date = toDate(day);
  return [`${day.slice(0, 8)}01`, toDay(new Date(date.getFullYear(), date.getMonth() + 1, 0))];
}

// How many times a habit has been done in the week or month holding `day`, not counting `task` itself.
function timesDone(task, rule, day) {
  const [start, end] = period(rule, day);
  const series = task.series_id ?? task.id;
  return state.tasks.filter((other) => other.series_id === series && other.id !== task.id && other.done_at
    && other.day >= start && other.day <= end).length;
}

const weekdayName = (day, style = "long") => new Date(2023, 0, 1 + day).toLocaleDateString(undefined, { weekday: style });
const sameDays = (days, wanted) => days.length === wanted.length && wanted.every((day) => days.includes(day));
const listWords = (words) => new Intl.ListFormat("en", { type: "conjunction" }).format(words);

function ordinal(number) {
  const suffix = { one: "st", two: "nd", few: "rd" }[new Intl.PluralRules("en", { type: "ordinal" }).select(number)];
  return `${number}${suffix ?? "th"}`;
}

function dayKind(days) {
  if (sameDays(days, ALL_DAYS)) return "day";
  if (sameDays(days, WORKDAYS)) return "weekday";
  if (sameDays(days, WEEKEND)) return "weekend day";
  return listWords(weekOrder(days).map((day) => weekdayName(day)));
}

// "Every 2 weeks on Mon and Wed, until Dec 31"; with `short`, only how often.
function describeRule(text, short = false) {
  const rule = parseRule(text);
  const end = rule.until && !short ? `, until ${formatDay(rule.until, { month: "short", day: "numeric", year: "numeric" })}` : "";
  if (rule.times) return `${{ 1: "Once", 2: "Twice" }[rule.times] ?? `${rule.times} times`} a ${UNITS[rule.freq]}${end}`;
  const weekly = rule.freq === "WEEKLY" && rule.interval === 1;
  if (weekly && sameDays(rule.byDay, WORKDAYS)) return `Every weekday${end}`;
  if (weekly && sameDays(rule.byDay, WEEKEND)) return `Every weekend${end}`;
  let words = rule.interval > 1 ? `Every ${rule.interval} ${UNITS[rule.freq]}s` : `Every ${UNITS[rule.freq]}`;
  if (short) return words;
  if (rule.freq === "WEEKLY" && rule.byDay.length) {
    words += ` on ${listWords(weekOrder(rule.byDay).map((day) => weekdayName(day, "short")))}`;
  } else if (rule.setPos) {
    words += ` on the ${POSITIONS[rule.setPos]} ${dayKind(rule.byDay)}`;
  } else if (rule.byMonthDay.length) {
    const numbers = [...rule.byMonthDay].sort((a, b) => a - b);
    words += ` on the ${listWords(numbers.map((number) => (number === -1 ? "last day" : ordinal(number))))}`;
  }
  return words + end;
}

// The usual choices, counted from `day`, as [label, rule, detail].
function repeatPresets(day) {
  const date = toDate(day);
  const weekday = weekdayName(date.getDay(), "short");
  return [
    ["Every day", "FREQ=DAILY", ""],
    ["Every weekday", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", `${weekdayName(1, "short")}–${weekdayName(5, "short")}`],
    ["Every week", "FREQ=WEEKLY", weekday],
    ["Every 2 weeks", "FREQ=WEEKLY;INTERVAL=2", weekday],
    ["Every month", "FREQ=MONTHLY", ordinal(date.getDate())],
    ["Every year", "FREQ=YEARLY", formatDay(day, { month: "short", day: "numeric" })],
  ];
}

// Rendering

function syncChildren(parent, items, keyOf, create, update) {
  const existing = new Map([...parent.children].map((element) => [element.dataset.key, element]));
  let cursor = parent.firstElementChild;
  for (const item of items) {
    const key = keyOf(item);
    const element = existing.get(key) ?? create(item);
    element.dataset.key = key;
    existing.delete(key);
    update(element, item);
    if (element === cursor) cursor = cursor.nextElementSibling;
    else parent.insertBefore(element, cursor);
  }
  existing.forEach((element) => element.remove());
}

function rowOffsets() {
  return new Map([...document.querySelectorAll(".row")].map((row) => [row.dataset.key, row.getBoundingClientRect().top]));
}

function slideRows(before, rows) {
  if (reducedMotion.matches) return;
  for (const row of rows) {
    const previous = before.get(row.dataset.key);
    if (previous === undefined) continue;
    const delta = previous - row.getBoundingClientRect().top;
    if (!delta) continue;
    row.getAnimations().forEach((animation) => animation.cancel());
    row.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }],
      { duration: 170, easing: "cubic-bezier(.2, .7, .2, 1)" });
  }
}

function animated(change) {
  const before = rowOffsets();
  const neighbor = selectedId && neighborRow(selectedId);
  change();
  // When the selected task leaves the list, the one beside it takes over.
  if (!selectedId && neighbor?.isConnected) {
    selectedId = neighbor.dataset.id;
    updateSelection();
  }
  slideRows(before, document.querySelectorAll(".row"));
}

function render() {
  // Removing a row being edited ends the edit, which asks for a render of its own.
  if (!state.today || rendering) return;
  rendering = true;
  try {
    renderSidebar();
    renderMain();
  } finally {
    rendering = false;
  }
}

function renderSidebar() {
  const active = viewKey();
  document.querySelectorAll(".nav-row[data-view]").forEach((link) => {
    link.classList.toggle("active", link.dataset.view === active);
    if (link.dataset.view === active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  const open = state.tasks.filter((task) => !task.done_at);
  const countText = (count) => (count ? String(count) : "");
  const todayCount = open.filter((task) => task.day === state.today || (task.repeat && task.day < state.today)).length;
  document.getElementById("count-today").textContent = countText(todayCount);
  // Ergon's Mac app shows it on its Dock icon too.
  window.webkit?.messageHandlers?.todayCount?.postMessage(todayCount);
  const thisWeek = startOfWeek(state.today);
  document.getElementById("count-week").textContent = countText(open.filter((task) => task.day >= thisWeek && task.day <= addDays(thisWeek, 6)).length);
  document.getElementById("count-inbox").textContent = countText(open.filter((task) => inList(task, "inbox") || inList(task, "overdue")).length);
  document.getElementById("count-habits").textContent = countText(open.filter((task) => task.repeat && task.day <= state.today).length);

  const projects = [...state.projects].sort((a, b) => a.rank - b.rank);
  const projectLink = () => {
    const link = document.createElement("a");
    link.className = "nav-row";
    link.draggable = false;
    link.innerHTML = '<span class="nav-name"></span><span class="nav-count"></span>';
    return link;
  };
  const updateLink = (link, project) => {
    link.href = `#project/${project.id}`;
    link.dataset.view = `project:${project.id}`;
    link.dataset.drop = `project:${project.id}`;
    link.classList.toggle("active", link.dataset.view === active);
    link.querySelector(".nav-name").textContent = project.title;
    const list = `project:${project.id}`;
    link.querySelector(".nav-count").textContent = countText(open.filter((task) => inList(task, list) && inPlace(task, list)).length);
  };
  syncChildren(projectList, projects.filter((project) => !project.completed_at), (project) => project.id, projectLink, updateLink);
  const completed = projects.filter((project) => project.completed_at);
  syncChildren(completedProjects, completed, (project) => project.id, projectLink, (link, project) => {
    updateLink(link, project);
    delete link.dataset.drop;
  });
  completedToggle.hidden = !completed.length;
  completedToggle.textContent = `${completed.length} completed`;
}

function renderMain() {
  const key = viewKey();
  const changedView = key !== renderedView;
  const planned = renderedView === "plan";
  renderedView = key;
  if (changedView) {
    groupsEl.replaceChildren();
    main.scrollTop = 0;
    selectedId = null;
    // Planning is for the week to come, which on a week's last day is the next one. Done goes back to
    // Week still showing the week just planned.
    if (key === "plan") showWeek(startOfWeek(addDays(state.today, 1)), false);
    else if (!(planned && key === "week")) shownWeek = null;
    shownDay = null;
    // Searching a view ends on leaving it; Search keeps what it last searched for.
    searchOpen = false;
    query = view.kind === "search" ? searchedFor : "";
  }
  // A task gone to from Search brings its week along.
  const revealed = reveal && view.kind !== "search" ? findTask(reveal) : null;
  if (view.kind !== "search") reveal = null;
  if (revealed?.day && view.kind === "week") showWeek(startOfWeek(revealed.day), false);
  document.body.dataset.view = view.kind;
  document.body.classList.toggle("planning", key === "plan");

  const project = view.kind === "project" ? findProject(view.id) : null;
  if (view.kind === "project" && !project) {
    location.hash = "#today";
    return;
  }
  const otherDay = view.kind === "today" && dayShown() !== state.today;
  if (document.activeElement !== pageTitle) {
    pageTitle.textContent = project ? project.title : otherDay ? dayTitle(dayShown()) : view.plan ? "Plan"
      : { today: "Today", week: "Week", inbox: "Inbox", habits: "Repeating", goals: "Goals", search: "Search" }[view.kind];
  }
  pageTitle.toggleAttribute("data-editable", Boolean(project));
  projectMenuButton.hidden = !project;
  document.title = project ? `${project.title} · Ergon` : `${pageTitle.textContent} · Ergon`;
  pageSubtitle.textContent = otherDay ? fromToday(dayShown())
    : view.kind === "today" ? todayLine()
    : view.kind === "week" ? `${weekRange(weekShown())} · ${weekTime(weekShown())}`
    : project?.completed_at ? "Completed" : "";
  pageSubtitle.hidden = !pageSubtitle.textContent;
  if (document.activeElement !== projectDescription) showDescription(project?.description ?? "");

  weekNav.hidden = view.kind !== "week";
  planButton.textContent = view.plan ? "Done" : "Plan";
  searchBar.hidden = view.kind !== "search" && !searchOpen;
  // A box put away takes the keyboard with it, so keys go to the list again.
  if (searchBar.hidden && document.activeElement === searchInput) searchInput.blur();
  if (searchInput.value !== query) searchInput.value = query;
  clearSearch.hidden = !query;
  searchInput.placeholder = view.kind === "search" ? "Search all tasks" : `Search in ${pageTitle.textContent}`;
  searchInput.setAttribute("aria-label", searchInput.placeholder);
  matching = searchMatcher();
  syncChildren(groupsEl, groupsForView(), (group) => group.key ?? group.list, createGroup, updateGroup);
  // Searching Goals dims the boxes that don't match.
  noMatches.hidden = !searchTerms().length || view.kind === "goals" || Boolean(groupsEl.querySelector(".row, .done-toggle:not([hidden])"));
  goalsEl.hidden = goalsNav.hidden = view.kind !== "goals";
  if (view.kind === "goals") renderGoals();

  if (revealed) select(revealed.id, "center");
  else if (changedView) focusStart();
  updateSelection();
}

function createGroup(group) {
  const section = document.createElement("section");
  section.className = "group";
  section.classList.toggle("compact", Boolean(group.compact));
  section.classList.toggle("week-day", Boolean(group.week));
  section.dataset.list = group.list;
  section.innerHTML = `
    <h2 class="group-title" hidden></h2>
    <ul class="rows list"></ul>
    <ul class="rows coming" hidden></ul>
    <p class="empty-line" hidden></p>
    <form class="add-row">
      <span class="add-mark" aria-hidden="true">+</span>
      <textarea rows="1" autocomplete="off" spellcheck="false"></textarea>
    </form>
    <button class="done-toggle" type="button" hidden></button>
    <ul class="rows done" hidden></ul>`;
  section.querySelector(".add-row").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = event.currentTarget.elements[0];
    if (group.list === "habits") createHabit(input.value);
    else createTask(input.value, group.list);
    input.value = "";
    drafts.delete(group.list);
    section.querySelector(".rows.list").lastElementChild?.scrollIntoView({ block: "nearest" });
    input.scrollIntoView({ block: "nearest" });
  });
  const box = section.querySelector(".add-row textarea");
  box.value = drafts.get(group.list) ?? "";
  box.addEventListener("input", () => drafts.set(group.list, box.value));
  box.addEventListener("keydown", submitOnEnter);
  section.querySelector(".done-toggle").addEventListener("click", () => {
    setDoneOpen(group, !isDoneOpen(group));
    animated(render);
  });
  if (group.week) {
    const time = document.createElement("button");
    time.className = "day-time";
    time.type = "button";
    time.innerHTML = '<span class="day-time-text"></span><span class="day-time-bar"><span></span></span>';
    time.addEventListener("click", () => openDayTimePopover(group.day, time));
    section.querySelector(".group-title").after(time);
  }
  if (group.backlog) {
    section.classList.add("backlog");
    // A task dragged here from a day goes back to where it came from, to be planned another time.
    section.dataset.drop = "unschedule";
    const title = section.querySelector(".group-title");
    title.innerHTML = '<button class="backlog-source" type="button" aria-haspopup="menu"><span></span></button><span></span>';
    title.querySelector("button").addEventListener("click", (event) => openBacklogMenu(event.currentTarget));
  }
  return section;
}

function updateGroup(section, group) {
  const title = section.querySelector(".group-title");
  section.classList.toggle("past", Boolean(group.past));
  section.classList.toggle("today", group.day === state.today);
  if (group.part) section.dataset.part = group.part;
  else delete section.dataset.part;
  title.hidden = !group.title && !group.day;
  if (group.backlog) {
    title.querySelector(".backlog-source span").textContent = group.title;
  } else if (group.title) {
    title.textContent = group.title;
  } else if (group.day) {
    title.textContent = formatDay(group.day, { weekday: "short" });
    const date = document.createElement("span");
    date.textContent = Number(group.day.slice(8));
    title.append(date);
  }
  const input = section.querySelector(".add-row textarea");
  input.placeholder = group.placeholder ?? "";
  input.setAttribute("aria-label", group.placeholder ?? "");

  section.takes = group.takes ?? null;
  const shown = (tasks) => (matching ? tasks.filter(matching) : tasks);
  const tasks = shown(listTasks(group.list).filter(group.takes ?? (() => true)));
  syncChildren(section.querySelector(".rows.list"), tasks, (task) => task.id, createRow,
    (row, task) => updateRow(row, task, group.list));
  if (group.backlog) title.lastElementChild.textContent = tasks.filter((task) => !task.done_at).length || "";
  if (group.week) updateDayTime(section.querySelector(".day-time"), group.day);
  const coming = section.querySelector(".rows.coming");
  const habits = group.week && !matching ? comingHabits(group.day) : [];
  coming.hidden = !habits.length;
  syncChildren(coming, habits, (task) => task.id, createComingRow, updateComingRow);

  // Planning only shows what is still to plan.
  const done = group.backlog ? [] : shown(doneTasks(group.list));
  // While searching, a list shows only what matches, and steps aside with nothing to show; Week keeps its days.
  section.classList.toggle("searching", Boolean(matching));
  section.hidden = Boolean(matching && !group.week && !tasks.length && !done.length);
  const empty = section.querySelector(".empty-line");
  empty.hidden = Boolean(tasks.length || !group.emptyText || matching);
  empty.textContent = group.emptyText;

  const toggle = section.querySelector(".done-toggle");
  const doneList = section.querySelector(".rows.done");
  const showDone = isDoneOpen(group);
  toggle.hidden = !done.length;
  toggle.textContent = `${done.length} done`;
  toggle.setAttribute("aria-expanded", String(showDone));
  doneList.hidden = !done.length || !showDone;
  syncChildren(doneList, showDone ? done : [], (task) => task.id, createRow,
    (row, task) => updateRow(row, task, group.list));
}

// Every project's Done list is one setting.
const doneKey = (group) => `ergon.done.${group.list.split(":")[0]}`;

// Views that are mostly for looking, so the cursor does not jump into an add box. Search starts in its box.
function focusStart() {
  if (view.kind === "search") focusSearch();
  else if (view.kind !== "week" && view.kind !== "goals") focusAddRow();
}

// Week

// The first day of the week holding `day`, counting weeks from the locale's first weekday.
const startOfWeek = (day) => addDays(day, -((toDate(day).getDay() - firstWeekday() + 7) % 7));
const weekShown = () => shownWeek ?? startOfWeek(state.today);

function weekRange(start) {
  const end = addDays(start, 6);
  const options = { month: "long", day: "numeric" };
  if (start.slice(0, 4) !== state.today.slice(0, 4) || end.slice(0, 4) !== state.today.slice(0, 4)) options.year = "numeric";
  return new Intl.DateTimeFormat(undefined, options).formatRange(toDate(start), toDate(end));
}

// "November 23 – 29 · 9h 30m planned of 18h"
function weekTime(start) {
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  const planned = days.reduce((sum, day) => sum + dayLoad(day).minutes, 0);
  const time = days.reduce((sum, day) => sum + timeOn(day), 0);
  return planned ? `${formatMinutes(planned)} planned of ${formatMinutes(time)}` : `${formatMinutes(time)} free`;
}

function showWeek(start, draw = true) {
  shownWeek = start === startOfWeek(state.today) ? null : start;
  if (draw) render();
}

// A task moved past either end of the week takes the week along, so it stays in view.
function moveByDay(task, step) {
  const day = addDays(task.day ?? state.today, step);
  if (day < state.today) return;
  setDay(task, day);
  if (startOfWeek(day) !== weekShown()) showWeek(startOfWeek(day));
  select(task.id);
}

// Planning by time: a task can say how long it takes, and each day has some time for tasks, set for every
// such weekday or for that day alone. Week adds up each day against its time.

// 45m, 2h, 1h 30m
function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

// A task's time is typed in hours and minutes, at its end: 4h, 15m or 1h30m. Empty, or 0, is no time.
const timeText = (minutes) => (minutes ? formatMinutes(minutes).replace(" ", "") : "");

// The box fits up to 9h45m; a longer time, such as 10h30m, widens it.
function showTime(box, minutes) {
  box.value = timeText(minutes);
  box.classList.toggle("long", box.value.length > 5);
}

// "4h", "1.5h", "15m", "15min", "1h30m" or "1h 30"; a number alone is hours, so "0.5" is half an hour.
const TIME_RE = /^(?:(\d+(?:\.\d*)?|\.\d+)\s*(?:h\s*(?:(\d+)\s*(?:m|min)?)?)?|(\d+)\s*(?:m|min))$/i;

// Minutes from what was typed in a task's time box; null for none, and undefined for anything else.
function parseTime(text) {
  const clean = text.trim().replace(",", ".");
  if (!clean) return null;
  const match = clean.match(TIME_RE);
  if (!match) return undefined;
  const [, hours, extra, alone] = match;
  const minutes = alone ? Number(alone) : Math.round(Number(hours) * 60) + Number(extra ?? 0);
  return minutes > MAX_MINUTES ? undefined : minutes || null;
}

function saveTime(box) {
  const task = findTask(box.closest(".row")?.dataset.id);
  if (!task) return;
  const minutes = parseTime(box.value);
  showTime(box, minutes === undefined ? task.minutes : minutes);
  if (minutes !== undefined) setMinutes(task, minutes);
}

groupsEl.addEventListener("focusin", (event) => {
  if (!event.target.matches(".task-time")) return;
  event.target.select();
  // Letting go of the click would put the caret where it landed, so typing replaces the time.
  event.target.addEventListener("mouseup", (up) => up.preventDefault(), { once: true });
});

groupsEl.addEventListener("focusout", (event) => {
  if (event.target.matches(".task-time")) saveTime(event.target);
});

// Enter keeps the time, and Esc puts back the one before.
groupsEl.addEventListener("keydown", (event) => {
  const box = event.target.closest(".task-time");
  if (!box || (event.key !== "Enter" && event.key !== "Escape")) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") showTime(box, findTask(box.closest(".row").dataset.id)?.minutes);
  box.blur();
});

const timeOn = (day) => state.time.days[day] ?? state.time.weekdays[WEEKDAY_CODES[toDate(day).getDay()]] ?? 0;

// One task stands for each habit, on its next date. A habit that takes time also shows on the dates after
// that, so a week shows where its time goes. Habits done some times a week have no set days.
function comingHabits(day) {
  return state.tasks
    .filter((task) => {
      if (!task.repeat || task.done_at || !task.minutes || task.day >= day || day < state.today) return false;
      const rule = parseRule(task.repeat);
      return !rule.times && !(rule.until && day > rule.until) && occursOn(rule, task.day, day);
    })
    .sort((a, b) => a.habit_rank - b.habit_rank);
}

// How long a day's tasks take, finished or not, with its habits. A task with no time counts as none.
function dayLoad(day) {
  const tasks = state.tasks.filter((task) => task.day === day);
  return { minutes: [...tasks, ...comingHabits(day)].reduce((sum, task) => sum + (task.minutes ?? 0), 0) };
}

// "2h free", "1h 30m of 2h", or more than the day has.
function dayTime(day) {
  const { minutes } = dayLoad(day);
  const time = timeOn(day);
  const text = !minutes ? (time ? `${formatMinutes(time)} free` : "No time")
    : time ? `${formatMinutes(minutes)} of ${formatMinutes(time)}` : `${formatMinutes(minutes)}, no time`;
  return { text, minutes, time };
}

function updateDayTime(button, day) {
  const { text, minutes, time } = dayTime(day);
  button.classList.toggle("over", minutes > time);
  button.classList.toggle("empty", !minutes);
  button.querySelector(".day-time-text").textContent = text;
  button.querySelector(".day-time-bar span").style.width = `${time ? Math.min(minutes / time, 1) * 100 : minutes ? 100 : 0}%`;
  button.title = `Time for tasks on ${formatDay(day, { weekday: "long", month: "long", day: "numeric" })}`;
}

function todayLine() {
  const date = formatDay(state.today, { weekday: "long", day: "numeric", month: "long" });
  const { text, minutes, time } = dayTime(state.today);
  return minutes || time ? `${date} · ${text}` : date;
}

function createComingRow() {
  const row = document.createElement("li");
  row.className = "coming-row";
  row.innerHTML = `${ICONS.repeat}<span class="coming-title"></span><span class="coming-time"></span>`;
  return row;
}

function updateComingRow(row, task) {
  showLinks(row.querySelector(".coming-title"), task.title);
  row.querySelector(".coming-time").textContent = timeText(task.minutes);
  row.title = describeRule(task.repeat);
}

// Days in Today

const dayShown = () => shownDay ?? state.today;
// Another day than today is titled with its weekday, and the line under it says how far away it is.
const dayTitle = (day) => formatDay(day, { weekday: "long" });

// How far the day is from today: Tomorrow, In 3 days, Yesterday, 3 days ago.
function fromToday(day) {
  const text = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(daysBetween(state.today, day), "day");
  return text[0].toUpperCase() + text.slice(1);
}

function showDay(day) {
  shownDay = day === state.today ? null : day;
  main.scrollTop = 0;
  render();
}

// The back and forward buttons on a mouse step through time: days in Today, weeks in Week and Plan.
// Elsewhere they do nothing, where a browser would go back or forward a view on letting go of them.
addEventListener("mouseup", (event) => {
  const step = { 3: -1, 4: 1 }[event.button];
  if (!step) return;
  event.preventDefault();
  if (!["today", "week"].includes(view.kind) || drag || !capture.hidden || !help.hidden) return;
  closePopover();
  // Ends any edit while its day is still the one on screen.
  if (document.activeElement !== searchInput) document.activeElement?.blur();
  if (view.kind === "today") showDay(addDays(dayShown(), step));
  else showWeek(addDays(weekShown(), 7 * step));
});

// Today in the sidebar, like ⌘T, comes back to today from another day.
viewsNav.addEventListener("click", (event) => {
  if (event.target.closest('[data-view="today"]') && view.kind === "today" && shownDay) showDay(state.today);
});

document.getElementById("week-prev").addEventListener("click", () => showWeek(addDays(weekShown(), -7)));
document.getElementById("week-next").addEventListener("click", () => showWeek(addDays(weekShown(), 7)));
document.getElementById("week-today").addEventListener("click", () => showWeek(startOfWeek(state.today)));
planButton.addEventListener("click", () => goTo(view.plan ? "#week" : "#plan"));

// Search

// Letters compare without case or accents, so "cafe" finds "Café".
const fold = (text) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const searchTerms = () => fold(query).split(/\s+/).filter(Boolean);

// A task matches when its title, or its project's name, holds every word searched for.
// Search shows nothing until something is typed, and any other view everything.
function searchMatcher() {
  const terms = searchTerms();
  if (!terms.length) return view.kind === "search" ? () => false : null;
  return (task) => {
    const text = fold(`${task.title} ${findProject(task.project_id)?.title ?? ""}`);
    return terms.every((term) => text.includes(term));
  };
}

// Titles starting with what was searched for come first, then those with a word starting with it, then the
// rest; among them, the soonest day first, and tasks with no day last.
function bySearch(a, b) {
  const [first = ""] = searchTerms();
  const whole = searchTerms().join(" ");
  const score = (task) => {
    const title = fold(task.title);
    if (title.startsWith(whole)) return 0;
    return title.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(first)) ? 1 : 2;
  };
  return score(a) - score(b) || !a.day - !b.day || (a.day ?? "").localeCompare(b.day ?? "");
}

function focusSearch() {
  searchInput.focus();
  searchInput.select();
}

// ⌘L opens Search. ⌘F searches the view on screen, which in Search is every task.
function startSearch(everything) {
  closePopover();
  help.hidden = true;
  if (!capture.hidden) closeCapture(true);
  // Ends any edit while its view is still the one on screen.
  if (document.activeElement !== searchInput) document.activeElement?.blur();
  if (everything && view.kind !== "search") {
    // What this view was searched for goes on to every task.
    if (searchTerms().length) searchedFor = query;
    location.hash = "#search";
    return;
  }
  if (view.kind !== "search" && !searchOpen) {
    searchOpen = true;
    render();
  }
  focusSearch();
}

// Searching as you type selects the best match, for Enter to go to.
function search(text) {
  query = text;
  if (view.kind === "search") searchedFor = text;
  render();
  const first = searchTerms().length && groupsEl.querySelector(".row");
  if (first) select(first.dataset.id);
  else clearSelection();
}

// Puts the box away, or leaves Search for the view it was opened from.
function closeSearch() {
  if (view.kind === "search") {
    location.hash = viewBeforeSearch;
  } else if (searchOpen) {
    searchOpen = false;
    query = "";
    render();
  }
}

// From the box, the arrow keys and ⌃N/⌃P move through what was found.
function stepResults(step) {
  const rows = visibleRows();
  if (!rows.length) return;
  const index = rows.findIndex((row) => row.dataset.id === selectedId);
  const next = index === -1 ? (step > 0 ? 0 : rows.length - 1) : Math.min(Math.max(index + step, 0), rows.length - 1);
  select(rows[next].dataset.id);
}

// Where a task lives: Today for anything due today and habits missed, the Inbox for other tasks whose day has
// passed, Habits for a habit due later, then its project, its day in Week, or the Inbox. A task finished on an
// earlier day is under its project's Done, or the Inbox's.
function placeOf(task) {
  const project = task.project_id && `#project/${task.project_id}`;
  if (!task.done_at) {
    if (task.day === state.today || (task.repeat && isOverdue(task))) return { hash: "#today" };
    if (isOverdue(task)) return { hash: "#inbox" };
    if (task.repeat) return { hash: "#habits" };
    return { hash: project || (task.day ? "#week" : "#inbox") };
  }
  if (task.day === state.today) return { hash: "#today" };
  if (isOverdue(task) && finishedToday(task)) return { hash: isHabit(task) ? "#today" : "#inbox" };
  const done = !finishedToday(task) && { list: project ? "project:" : "inbox" };
  if (project) return { hash: project, done };
  return task.day ? { hash: "#week" } : { hash: "#inbox", done };
}

// Enter goes to the selected task: in Search, to where it lives, and in any other view, back to the whole
// list. Either way it stays selected, for the keys that act on it.
function goToSelected() {
  const task = selectedId && findTask(selectedId);
  if (!task) return;
  if (view.kind !== "search") {
    closeSearch();
    select(task.id, "center");
    return;
  }
  const place = placeOf(task);
  if (place.done) setDoneOpen(place.done, true);
  reveal = task.id;
  location.hash = place.hash;
}

searchInput.addEventListener("input", () => search(searchInput.value));

searchInput.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  const arrow = event.metaKey ? 0 : { ArrowDown: 1, ArrowUp: -1 }[event.key] ?? 0;
  const step = stepKey(event) || (event.altKey ? 0 : arrow);
  if (step) {
    event.preventDefault();
    stepResults(step);
  } else if (arrow) {
    // ⌥↑ and ⌥↓ move the selected task, as they do outside the box.
    event.preventDefault();
    moveSelectedTask(arrow);
  } else if (event.key === "Enter") {
    event.preventDefault();
    goToSelected();
  } else if (event.key === "Escape") {
    // Escape clears the box, and with nothing to clear, puts it away.
    event.preventDefault();
    event.stopPropagation();
    if (query) {
      search("");
    } else {
      closeSearch();
      if (view.kind !== "search") focusStart();
    }
  }
});

// Leaving an empty box puts it away, unless that is a switch to another app.
searchInput.addEventListener("blur", () => {
  if (searchOpen && !query.trim() && document.hasFocus()) closeSearch();
});

clearSearch.addEventListener("click", () => {
  search("");
  searchInput.focus();
});

// The order of the views in the sidebar, which you can drag, is kept on this Mac.
function saveViewOrder() {
  try {
    localStorage.setItem("ergon.views", JSON.stringify([...viewsNav.children].map((link) => link.dataset.view)));
  } catch { /* A remembered order is optional. */ }
}

function restoreViewOrder() {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem("ergon.views") ?? "[]");
  } catch { /* Fall back to the default order. */ }
  const links = [...viewsNav.children];
  // Week takes the place of Upcoming, or of Calendar, whichever came first.
  const names = [...new Set(saved.map((name) => (name === "upcoming" || name === "calendar" ? "week" : name)))];
  const placed = names.map((name) => links.find((link) => link.dataset.view === name)).filter(Boolean);
  viewsNav.append(...placed, ...links.filter((link) => !placed.includes(link)));
}

function isDoneOpen(group) {
  try {
    const saved = localStorage.getItem(doneKey(group));
    if (saved !== null) return saved === "1";
  } catch { /* Storage can be unavailable; fall through to the default. */ }
  return false;
}

function setDoneOpen(group, open) {
  try {
    localStorage.setItem(doneKey(group), open ? "1" : "0");
  } catch { /* A remembered preference is optional. */ }
}

function showLinks(element, text) {
  const parts = [];
  let end = 0;
  for (const match of text.matchAll(LINK_RE)) {
    const link = document.createElement("a");
    link.href = match[1] ?? match[0];
    link.textContent = match[2] || match[1] || match[0];
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.draggable = false;
    parts.push(text.slice(end, match.index), link);
    end = match.index + match[0].length;
  }
  element.replaceChildren(...parts, text.slice(end));
}

function showTitle(title, text) {
  title.dataset.raw = text;
  showLinks(title, text);
}

// A title as stored: links written [[url][label]], or as the bare url when that is all they show.
function titleMarkup(element) {
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeName === "BR") return " ";
    const inner = [...node.childNodes].map(walk).join("");
    const href = node.nodeName === "A" && node.getAttribute("href");
    const [, before, label, after] = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!href || !label) return inner;
    return before + (label === href ? href : `[[${href}][${label}]]`) + after;
  };
  return [...element.childNodes].map(walk).join("").replace(/\s+/g, " ").trim();
}

function createRow(task) {
  const row = document.createElement("li");
  row.className = "row";
  row.dataset.id = task.id;
  row.innerHTML = `
    <button class="check" type="button" role="checkbox" aria-label="Mark done">${ICONS.check}</button>
    <span class="title"></span>
    <span class="meta"></span>
    <input class="task-time" autocomplete="off" spellcheck="false" aria-label="Time it takes">`;
  return row;
}

function updateRow(row, task, list) {
  const done = Boolean(task.done_at);
  row.classList.toggle("is-done", done);
  row.classList.toggle("overdue", !done && isOverdue(task));
  const check = row.querySelector(".check");
  check.setAttribute("aria-checked", String(done));
  check.setAttribute("aria-label", done ? "Mark not done" : "Mark done");

  const title = row.querySelector(".title");
  if (!row.classList.contains("editing") && title.dataset.raw !== task.title) showTitle(title, task.title);

  const meta = row.querySelector(".meta");
  meta.replaceChildren();
  const addMeta = (text, className, icon) => {
    const part = document.createElement("span");
    if (className) part.className = className;
    if (icon) part.innerHTML = icon;
    part.append(text);
    meta.append(part);
    return part;
  };
  if (task.project_id && !list.startsWith("project:")) {
    const project = findProject(task.project_id);
    if (project) addMeta(project.title);
  }
  // Search says where each task is, and that is the Inbox for one with no project or day.
  if (list === "search" && !task.project_id && !task.day) addMeta("Inbox");
  // In the habit lists, a habit with no day shown is due today.
  if (task.day && !list.startsWith("day:") && !done && !(list.startsWith("habits") && task.day === state.today)) {
    addMeta(dayLabel(task.day), isOverdue(task) ? "overdue" : "");
  }
  if (task.remind_at && !done) {
    addMeta(reminderLabel(task.remind_at, task.day), task.reminded_at ? "reminder fired" : "reminder", ICONS.bell);
  }
  if (task.repeat && !done) {
    // Habits done some times a week or month show how far along this week or month is.
    const rule = parseRule(task.repeat);
    const progress = rule.times ? `${timesDone(task, rule, state.today)}/${rule.times}` : "";
    // Habits, the list of them all, and Search say how often each comes back.
    const text = list !== "habits" && list !== "search" ? progress : rule.times ? `${progress} this ${UNITS[rule.freq]}` : describeRule(task.repeat);
    const repeat = addMeta(text, "repeat", ICONS.repeat);
    repeat.title = describeRule(task.repeat) + (progress ? `, ${progress} so far this ${UNITS[rule.freq]}` : "");
    repeat.setAttribute("aria-label", repeat.title);
  }
  const time = row.querySelector(".task-time");
  if (time !== document.activeElement) showTime(time, task.minutes);
}

// Selection

const visibleRows = () => [...groupsEl.querySelectorAll(".row")];

// The closest open task, so working through a list never lands on a finished one; in Done, the closest one there.
function neighborRow(id) {
  const rows = visibleRows();
  const index = rows.findIndex((row) => row.dataset.id === id);
  if (index === -1) return null;
  const inDone = (row) => row.parentElement.classList.contains("done");
  const sameKind = inDone(rows[index]) ? inDone : (row) => !row.classList.contains("is-done");
  return rows.slice(index + 1).find(sameKind) ?? rows.slice(0, index).findLast(sameKind) ?? null;
}

function updateSelection() {
  document.querySelectorAll(".row.selected").forEach((row) => row.classList.remove("selected"));
  if (!selectedId) return;
  const row = groupsEl.querySelector(`.row[data-id="${selectedId}"]`);
  if (row) row.classList.add("selected");
  else selectedId = null;
}

function clearSelection() {
  selectedId = null;
  updateSelection();
}

function select(id, block = "nearest") {
  selectedId = id;
  updateSelection();
  document.body.classList.add("keyboard-nav");
  // A link or button keeping the focus would take Enter for itself. The search box keeps it, to go on typing.
  if (document.activeElement !== searchInput) document.activeElement?.blur();
  groupsEl.querySelector(`.row[data-id="${id}"]`)?.scrollIntoView({ block });
}

// A mouse resting on a task should not look like a second selection. A list moving under a still mouse
// sends it moves too, so only a change of place counts.
let pointerAt = "";
addEventListener("pointermove", (event) => {
  const at = `${event.clientX},${event.clientY}`;
  if (at !== pointerAt) document.body.classList.remove("keyboard-nav");
  pointerAt = at;
});

function stepKey(event) {
  if (!event.ctrlKey || event.metaKey || event.altKey) return 0;
  return { n: 1, p: -1 }[event.key.toLowerCase()] ?? 0;
}

function moveSelection(step) {
  const rows = visibleRows();
  if (!rows.length) return;
  const index = rows.findIndex((row) => row.dataset.id === selectedId);
  const lastListed = rows.findLastIndex((row) => !row.parentElement.classList.contains("done"));
  const last = lastListed === -1 ? rows.length - 1 : lastListed;
  const next = index === -1 ? (step > 0 ? 0 : last) : index + step;
  // Past either end of the list is the add box, or the search box while searching, and from there back round.
  if (rows[next]) {
    select(rows[next].dataset.id);
  } else {
    clearSelection();
    if (searchTerms().length) searchInput.focus();
    else focusAddRow();
  }
}

// In Week, that is today's add box, or the first one of a week still to come.
function focusAddRow() {
  const group = groupsEl.querySelector(".group.week-day.today") ?? groupsEl.querySelector(".group:not([data-part]):not(.past)");
  group?.querySelector(".add-row textarea").focus();
}

function moveSelectedTask(step) {
  const row = groupsEl.querySelector(`.row[data-id="${selectedId}"]`);
  if (!row?.parentElement.classList.contains("list") || row.closest(".group").dataset.part === "results") return;
  const list = row.closest(".group").dataset.list;
  const ids = [...row.parentElement.children].map((child) => child.dataset.id);
  const index = ids.indexOf(selectedId);
  const target = index + step;
  if (target < 0 || target >= ids.length) return;
  ids.splice(index, 1);
  ids.splice(target, 0, selectedId);
  animated(() => applyOrder(list, ids));
  select(selectedId);
}

// Editing titles

function beginEdit(row, point) {
  const title = row.querySelector(".title");
  row.classList.add("editing");
  selectedId = row.dataset.id;
  updateSelection();
  // Rich editing keeps links as links; beforeinput below limits it to text and links.
  title.contentEditable = "true";
  editHistory.host = null;
  title.focus();
  const range = point && document.caretRangeFromPoint?.(point.x, point.y);
  const selection = getSelection();
  if (range && title.contains(range.startContainer)) {
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    selection.selectAllChildren(title);
    selection.collapseToEnd();
  }
}

const editedTitle = (row) => titleMarkup(row.querySelector(".title"));

function endEdit(row, save) {
  if (!row.classList.contains("editing")) return;
  const title = row.querySelector(".title");
  const task = findTask(row.dataset.id);
  row.classList.remove("editing");
  title.removeAttribute("contenteditable");
  getSelection().removeAllRanges();
  if (!task) return;
  const { title: text, minutes } = splitEstimate(editedTitle(row));
  if (!save || (text === task.title && !minutes)) {
    showTitle(title, task.title);
  } else if (text) {
    showTitle(title, text);
    patchTask(task, minutes ? { title: text, minutes } : { title: text });
  } else {
    showTitle(title, task.title);
    deleteTask(task);
  }
}

groupsEl.addEventListener("keydown", (event) => {
  const row = event.target.closest(".row.editing");
  const step = stepKey(event);
  if (row && (event.key === "Enter" || event.key === "Escape" || step)) {
    event.preventDefault();
    event.stopPropagation();
    const task = findTask(row.dataset.id);
    const unchanged = editedTitle(row) === task?.title;
    endEdit(row, event.key !== "Escape");
    if (step) moveSelection(step);
    // Enter saves an edit; with nothing to save, it finishes the task.
    else if (event.key === "Enter" && unchanged) toggleDone(task);
    return;
  }
  const input = event.target.closest(".add-row textarea");
  if (!input) return;
  if (event.key === "Escape") {
    event.stopPropagation();
    if (input.value) {
      input.value = "";
      drafts.delete(input.closest(".group").dataset.list);
    } else {
      input.blur();
      moveSelection(1);
    }
  } else if ((event.key === "ArrowUp" || step) && !input.value) {
    event.preventDefault();
    moveSelection(step || -1);
  }
});

groupsEl.addEventListener("focusin", (event) => {
  if (event.target.closest(".add-row textarea")) clearSelection();
});

groupsEl.addEventListener("focusout", (event) => {
  const row = event.target.closest(".row.editing");
  // Switching to another app keeps the edit open, so typing carries on when you come back.
  if (row && document.hasFocus()) endEdit(row, true);
});

// Clicking around the text of the task being edited keeps the caret in it.
groupsEl.addEventListener("mousedown", (event) => {
  if (event.target.closest(".row.editing") && !event.target.closest(".title, button")) event.preventDefault();
});

// The browser types at the end of a link outside it. That suits a caret placed after a link,
// but not retyping a link's words, so text typed over part of a link is put inside it by hand.
let typingIntoLink = null;

function linkAround(node) {
  return (node?.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.closest?.(".title a") ?? null;
}

groupsEl.addEventListener("beforeinput", (event) => {
  if (!event.target.closest?.(".row.editing")) return;
  if (/^(format|insertFromDrop|insertParagraph|insertLineBreak)/.test(event.inputType)) {
    event.preventDefault();
    return;
  }
  const selection = getSelection();
  const range = selection.rangeCount ? selection.getRangeAt(0) : null;
  const link = range && linkAround(range.startContainer);
  const insideLink = link && link === linkAround(range.endContainer);
  const atLinkEnd = range?.collapsed && link && link === typingIntoLink
    && range.startContainer === link.lastChild && range.startOffset === link.lastChild.length;
  if (event.inputType !== "insertText" || !insideLink || (range.collapsed && !atLinkEnd)) {
    typingIntoLink = null;
    return;
  }
  event.preventDefault();
  range.deleteContents();
  const node = link.lastChild?.nodeType === Node.TEXT_NODE && range.startContainer === link.lastChild
    ? link.lastChild : range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    node.insertData(range.startOffset, event.data);
    selection.collapse(node, range.startOffset + event.data.length);
  } else {
    const typed = document.createTextNode(event.data);
    range.insertNode(typed);
    selection.collapse(typed, typed.length);
  }
  typingIntoLink = link;
});

// Undo while editing is Ergon's own. The browser keeps one history for every text box on the
// page, so its undo could leave the task and undo an earlier edit somewhere else.
const editHistory = { host: null, past: [], future: [], at: 0 };

function caretOffset(root) {
  const selection = getSelection();
  if (!selection.rangeCount) return 0;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
  return range.toString().length;
}

function placeCaret(root, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (offset <= node.length) {
      getSelection().collapse(node, offset);
      return;
    }
    offset -= node.length;
  }
  getSelection().selectAllChildren(root);
  getSelection().collapseToEnd();
}

const editState = (host) => ({ html: host.innerHTML, caret: caretOffset(host) });

function restoreEdit(host, state) {
  host.innerHTML = state.html;
  placeCaret(host, state.caret);
}

// Typing within a moment of the last change undoes together, as a word or phrase.
function rememberEdit(host) {
  if (host !== editHistory.host) Object.assign(editHistory, { host, past: [], future: [], at: 0 });
  if (Date.now() - editHistory.at > 700) editHistory.past.push(editState(host));
  editHistory.future = [];
  editHistory.at = Date.now();
}

function stepEdit(host, undo) {
  const [from, to] = undo ? [editHistory.past, editHistory.future] : [editHistory.future, editHistory.past];
  if (host !== editHistory.host || !from.length) return;
  to.push(editState(host));
  restoreEdit(host, from.pop());
  editHistory.at = 0;
  typingIntoLink = null;
}

document.addEventListener("keydown", (event) => {
  const host = document.activeElement;
  if (!host?.isContentEditable || !event.metaKey || event.altKey || event.ctrlKey || event.key.toLowerCase() !== "z") return;
  event.preventDefault();
  stepEdit(host, !event.shiftKey);
}, true);

document.addEventListener("beforeinput", (event) => {
  const host = document.activeElement;
  if (!host?.isContentEditable) return;
  // The Edit menu's Undo and Redo would reach the shared history, so they do nothing here.
  if (event.inputType.startsWith("history")) event.preventDefault();
  else if (event.target === host) rememberEdit(host);
}, true);

document.addEventListener("paste", () => {
  const host = document.activeElement;
  if (!host?.isContentEditable) return;
  rememberEdit(host);
  editHistory.at = 0;
}, true);

groupsEl.addEventListener("keydown", (event) => {
  // Moving the caret, or anything but plain typing, ends a retyping of a link.
  if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) typingIntoLink = null;
}, true);

groupsEl.addEventListener("paste", (event) => {
  if (event.target.closest(".row.editing, .add-row textarea")) pasteOneLine(event);
});

groupsEl.addEventListener("click", (event) => {
  const row = event.target.closest(".row");
  if (!row) return;
  const task = findTask(row.dataset.id);
  if (!task) return;
  if (event.target.closest(".check")) setDone(task, !task.done_at);
});

// A task's actions are in its menu, opened by right-clicking it, as in Reminders. Each shows its key.
groupsEl.addEventListener("contextmenu", (event) => {
  const row = event.target.closest(".row");
  const task = row && findTask(row.dataset.id);
  // While editing, the text keeps the Mac's own menu, with spelling and Look Up.
  if (!task || row.classList.contains("editing")) return;
  event.preventDefault();
  selectedId = task.id;
  updateSelection();
  openTaskMenu(task, { x: event.clientX, y: event.clientY, row });
});

function openTaskMenu(task, at) {
  const item = (label, key, action, className) => menuItem(label, key, () => runAction(action, task, at), className);
  openPopover(at, (box) => {
    // Narrower than other popovers, which it has to be before it is placed.
    box.classList.add("context-menu");
    if (!task.done_at) {
      // A habit comes and goes by its repeat.
      if (!task.repeat) box.append(item(task.day === state.today ? "Remove from Today" : "Do Today", "t", "today"));
      box.append(item("Pick a Day…", "d", "day"), item("Remind Me…", "r", "remind"), item("Move to Project…", "p", "project"),
        document.createElement("hr"));
    }
    box.append(item("Delete", "⌫", "delete", "danger"));
  });
  // As in a Mac's menus, nothing is highlighted until the mouse or an arrow key gets there.
  popover.focus({ preventScroll: true });
}

function runAction(action, task, anchor) {
  if (action === "today") toggleToday(task);
  else if (action === "day") openDayPopover(task, anchor);
  else if (action === "remind") openReminderPopover(task, anchor);
  else if (action === "project") openProjectPopover(task, anchor);
  else if (action === "delete") deleteTask(task);
}

// Popovers

// `anchor` is the element a popover opens from, or the point a menu was opened at, with its row.
function openPopover(anchor, build) {
  closePopover();
  popover.replaceChildren();
  build(popover);
  popover.hidden = false;
  const row = anchor instanceof Element ? anchor.closest(".row") : anchor.row;
  if (row) {
    popoverRow = row;
    row.classList.add("popover-open");
  }
  placePopover(anchor);
  popover.querySelector("input, button:not(:disabled)")?.focus({ preventScroll: true });
}

function placePopover(anchor) {
  const { width, height } = popover.getBoundingClientRect();
  let left, below, above;
  if (anchor instanceof Element) {
    const box = anchor.getBoundingClientRect();
    [left, below, above] = [box.right - width, box.bottom + 6, box.top - height - 6];
  } else {
    // At a point, a menu opens to its right and below, as a Mac's do, or to the left near the window's edge.
    [left, below, above] = [anchor.x + width <= innerWidth - 12 ? anchor.x : anchor.x - width, anchor.y, anchor.y - height];
  }
  left = Math.max(12, Math.min(left, innerWidth - width - 12));
  const top = below + height <= innerHeight - 12 ? below : Math.max(12, above);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function closePopover() {
  if (popover.hidden) return;
  popover.hidden = true;
  popover.classList.remove("context-menu");
  popoverRow?.classList.remove("popover-open");
  popoverRow = null;
  // A menu that opens another in its place, such as Custom…, closes first; wait for the last to close.
  const after = afterPopover;
  afterPopover = null;
  if (after) setTimeout(() => { if (popover.hidden) after(); else afterPopover = after; });
}

// Inside a popover, the keyboard stays on its controls instead of reaching the list behind it.
popover.addEventListener("keydown", (event) => {
  const controls = [...popover.querySelectorAll("input, select, button:not(:disabled):not([tabindex='-1'])")]
    .filter((control) => control.checkVisibility());
  if (event.key === "Tab") {
    const [from, to] = event.shiftKey ? [controls[0], controls.at(-1)] : [controls.at(-1), controls[0]];
    if (event.target === from) {
      event.preventDefault();
      to.focus();
    }
    return;
  }
  const step = event.target.closest("input, select") ? 0 : stepKey(event) || { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const index = controls.indexOf(event.target);
  const next = index === -1 ? (step > 0 ? 0 : controls.length - 1) : (index + step + controls.length) % controls.length;
  controls[next].focus();
});

function menuItem(label, detail, onPick, className = "") {
  const item = document.createElement("button");
  item.type = "button";
  item.className = `menu-item ${className}`;
  const text = document.createElement("span");
  text.textContent = label;
  item.append(text);
  if (detail) {
    const small = document.createElement("small");
    small.textContent = detail;
    item.append(small);
  }
  item.addEventListener("click", () => {
    closePopover();
    onPick();
  });
  return item;
}

function firstWeekday() {
  // Ergon's Mac app passes on the Mac's own setting, which a language such as en-US would overrule.
  if (Number.isInteger(window.systemFirstWeekday)) return window.systemFirstWeekday;
  try {
    const locale = new Intl.Locale(navigator.language);
    const info = locale.getWeekInfo?.() ?? locale.weekInfo;
    return (info?.firstDay ?? 1) % 7;
  } catch {
    return 1;
  }
}

function buildCalendar(selected, onPick) {
  const start = toDate(selected ?? state.today);
  let year = start.getFullYear();
  let month = start.getMonth();
  let picked = selected;
  // The day the Tab key lands on; the arrow keys move it.
  let cursor = selected;
  const calendar = document.createElement("div");
  calendar.className = "calendar";
  const weekStart = firstWeekday();

  const draw = () => {
    const first = new Date(year, month, 1);
    const head = document.createElement("div");
    head.className = "calendar-head";
    const name = document.createElement("span");
    name.textContent = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const buttons = document.createElement("div");
    for (const [text, step, label] of [["‹", -1, "Previous month"], ["›", 1, "Next month"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "calendar-nav";
      button.textContent = text;
      button.setAttribute("aria-label", label);
      button.addEventListener("click", () => {
        const next = new Date(year, month + step, 1);
        year = next.getFullYear();
        month = next.getMonth();
        draw();
        calendar.querySelector(`[aria-label="${label}"]`).focus();
      });
      buttons.append(button);
    }
    head.append(name, buttons);

    const grid = document.createElement("div");
    grid.className = "calendar-grid";
    for (let index = 0; index < 7; index += 1) {
      const weekday = document.createElement("span");
      weekday.textContent = new Date(2023, 0, 1 + ((weekStart + index) % 7))
        .toLocaleDateString(undefined, { weekday: "narrow" });
      grid.append(weekday);
    }
    for (let blank = (first.getDay() - weekStart + 7) % 7; blank > 0; blank -= 1) grid.append(document.createElement("i"));
    const days = new Date(year, month + 1, 0).getDate();
    for (let date = 1; date <= days; date += 1) {
      const day = toDay(new Date(year, month, date));
      const button = document.createElement("button");
      button.type = "button";
      button.className = "calendar-day";
      button.dataset.day = day;
      button.tabIndex = -1;
      button.textContent = date;
      button.disabled = day < state.today;
      button.classList.toggle("today", day === state.today);
      button.classList.toggle("picked", day === picked);
      button.addEventListener("click", () => {
        picked = cursor = day;
        onPick(day);
        draw();
        calendar.querySelector(`[data-day="${day}"]`).focus();
      });
      grid.append(button);
    }
    const stop = grid.querySelector(`[data-day="${cursor}"]:enabled`)
      ?? grid.querySelector(".today") ?? grid.querySelector(".calendar-day:enabled");
    if (stop) stop.tabIndex = 0;
    calendar.replaceChildren(head, grid);
  };
  calendar.addEventListener("keydown", (event) => {
    const { day } = event.target.dataset;
    const step = stepKey(event) * 7 || { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (!day || !step) return;
    event.preventDefault();
    event.stopPropagation();
    const target = addDays(day, step);
    if (target < state.today) return;
    const date = toDate(target);
    year = date.getFullYear();
    month = date.getMonth();
    cursor = target;
    draw();
    calendar.querySelector(`[data-day="${target}"]`).focus();
  });
  draw();
  return calendar;
}

function openDayPopover(task, anchor) {
  const tomorrow = addDays(state.today, 1);
  openPopover(anchor, (box) => {
    box.append(
      menuItem("Today", formatDay(state.today, { weekday: "short" }), () => setDay(task, state.today)),
      menuItem("Tomorrow", formatDay(tomorrow, { weekday: "short" }), () => setDay(task, tomorrow)),
      buildCalendar(task.day, (day) => {
        closePopover();
        setDay(task, day);
      }),
    );
    box.append(document.createElement("hr"),
      menuItem("Repeat", task.repeat ? describeRule(task.repeat, true) : "Never", () => openRepeatMenu(task, anchor)));
    if (task.day) box.append(menuItem(task.project_id ? "No date" : "Back to Inbox", "", () => setDay(task, null)));
  });
}

function openRepeatMenu(task, anchor) {
  const day = task.day ?? state.today;
  openPopover(anchor, (box) => {
    const presets = repeatPresets(day);
    const chosen = (rule) => (rule === task.repeat ? "chosen" : "");
    box.append(menuItem("Never", "", () => setRepeat(task, null), chosen(null)));
    for (const [label, rule, detail] of presets) box.append(menuItem(label, detail, () => setRepeat(task, rule), chosen(rule)));
    if (task.repeat && !presets.some(([, rule]) => rule === task.repeat)) {
      box.append(menuItem(describeRule(task.repeat), "", () => openRepeatEditor(task, anchor), "chosen"));
    }
    box.append(document.createElement("hr"), menuItem("Custom…", "", () => openRepeatEditor(task, anchor)),
      menuItem("Times a week…", "", () => openRepeatEditor(task, anchor, { anyDays: true })));
    const next = task.repeat && !task.done_at && nextDate(task);
    if (next) box.append(document.createElement("hr"), menuItem("Skip to next", dayLabel(next.day), () => skipDate(task)));
  });
  popover.querySelector(".chosen")?.focus({ preventScroll: true });
}

// Like Apple's custom repeat: how often, on which days, and until when. As in habit apps, a week or month
// can also ask for some number of times, on any days.
function openRepeatEditor(task, anchor, { anyDays = false } = {}) {
  const day = task.day ?? state.today;
  const date = toDate(day);
  const current = task.repeat ? parseRule(task.repeat) : null;
  const nth = Math.ceil(date.getDate() / 7);
  const kinds = { day: ALL_DAYS, weekday: WORKDAYS, weekend: WEEKEND };
  const kindOf = (days) => Object.keys(kinds).find((kind) => sameDays(days, kinds[kind])) ?? String(days[0]);
  // The choices start from the current repeat, or else from the task's day.
  const draft = {
    freq: anyDays && !current?.times ? "WEEKLY" : current?.freq ?? "WEEKLY",
    interval: current?.interval ?? 1,
    weekdays: current?.freq === "WEEKLY" && current.byDay.length ? current.byDay : [date.getDay()],
    monthDays: current?.byMonthDay.length ? current.byMonthDay : [date.getDate()],
    onThe: Boolean(current?.setPos),
    position: current?.setPos || (nth === 5 ? -1 : nth),
    kind: current?.setPos ? kindOf(current.byDay) : String(date.getDay()),
    anyDays: anyDays || Boolean(current?.times),
    times: current?.times || 3,
    ends: Boolean(current?.until),
    until: current?.until ?? toDay(new Date(date.getFullYear(), date.getMonth() + 1, date.getDate())),
  };
  const counting = () => draft.anyDays && (draft.freq === "WEEKLY" || draft.freq === "MONTHLY");
  const result = () => formatRule(counting() ? {
    freq: draft.freq, interval: 1, byDay: [], byMonthDay: [], setPos: 0, times: draft.times,
    weekStart: firstWeekday(), until: draft.ends ? draft.until : null,
  } : {
    freq: draft.freq,
    interval: draft.interval,
    byDay: draft.freq === "WEEKLY" ? draft.weekdays : draft.freq === "MONTHLY" && draft.onThe ? kinds[draft.kind] ?? [Number(draft.kind)] : [],
    byMonthDay: draft.freq === "MONTHLY" && !draft.onThe ? draft.monthDays : [],
    setPos: draft.freq === "MONTHLY" && draft.onThe ? draft.position : 0,
    times: 0,
    weekStart: firstWeekday(),
    until: draft.ends ? draft.until : null,
  });

  openPopover(anchor, (box) => {
    const form = document.createElement("form");
    form.className = "repeat-editor";
    // Save checks the choices itself, including those a hidden field holds.
    form.noValidate = true;
    form.innerHTML = `
      <div class="segmented" data-name="freq" role="group" aria-label="Repeat"></div>
      <div class="segmented" data-name="week-mode" role="group" aria-label="In each week"></div>
      <label class="repeat-line" data-name="interval">Every <input type="number" min="1" max="99" aria-label="How often"> <span class="unit"></span></label>
      <label class="repeat-line" data-name="times"><input type="number" min="1" aria-label="How many times"> <span class="unit"></span></label>
      <div class="day-picks" data-name="weekdays" role="group" aria-label="On"></div>
      <div class="segmented" data-name="month-mode" role="group" aria-label="In each month"></div>
      <div class="day-picks" data-name="month-days" role="group" aria-label="On"></div>
      <div class="repeat-line" data-name="on-the"><select aria-label="Which"></select><select aria-label="Day"></select></div>
      <div class="repeat-line"><span>Ends</span><div class="segmented" data-name="ends" role="group" aria-label="Ends"></div></div>
      <input class="until" type="date" aria-label="End date">
      <p class="repeat-summary"></p>
      <button class="primary-button" type="submit">Save</button>`;
    const part = (name) => form.querySelector(`[data-name="${name}"]`);
    const toggle = (label, onPress, aria = label) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-label", aria);
      button.addEventListener("click", () => {
        onPress();
        update();
      });
      return button;
    };
    // Picking days keeps at least one picked.
    const flip = (list, value) => (list.includes(value) ? (list.length > 1 ? list.filter((item) => item !== value) : list) : [...list, value]);

    part("freq").append(...Object.entries(UNITS).map(([freq, unit]) =>
      toggle({ day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" }[unit], () => { draft.freq = freq; })));
    const interval = part("interval").querySelector("input");
    interval.value = draft.interval;
    interval.addEventListener("input", () => {
      draft.interval = Math.min(99, Math.max(1, Math.floor(Number(interval.value)) || 1));
      update();
    });
    const weekStart = firstWeekday();
    const weekdays = Array.from({ length: 7 }, (_, index) => (weekStart + index) % 7);
    part("weekdays").append(...weekdays.map((weekday) =>
      toggle(weekdayName(weekday, "narrow"), () => { draft.weekdays = flip(draft.weekdays, weekday); }, weekdayName(weekday))));
    part("week-mode").append(toggle("On days", () => { draft.anyDays = false; }), toggle("Any days", () => { draft.anyDays = true; }));
    part("month-mode").append(toggle("Each", () => { draft.anyDays = draft.onThe = false; }),
      toggle("On the", () => { draft.anyDays = false; draft.onThe = true; }), toggle("Any days", () => { draft.anyDays = true; }));
    const times = part("times").querySelector("input");
    times.value = draft.times;
    times.addEventListener("input", () => {
      draft.times = Math.min(Number(times.max), Math.max(1, Math.floor(Number(times.value)) || 1));
      update();
    });
    const monthDays = Array.from({ length: 31 }, (_, index) =>
      toggle(String(index + 1), () => { draft.monthDays = flip(draft.monthDays, index + 1); }));
    part("month-days").append(...monthDays);
    const [which, kind] = form.querySelectorAll("select");
    // Number-like keys come out in order, with "last" after them.
    which.append(...Object.entries(POSITIONS).map(([value, label]) => new Option(label, value)));
    kind.append(...weekdays.map((weekday) => new Option(weekdayName(weekday), String(weekday))),
      new Option("day", "day"), new Option("weekday", "weekday"), new Option("weekend day", "weekend"));
    which.value = String(draft.position);
    kind.value = draft.kind;
    which.addEventListener("change", () => { draft.position = Number(which.value); update(); });
    kind.addEventListener("change", () => { draft.kind = kind.value; update(); });
    const until = form.querySelector(".until");
    until.min = day;
    until.value = draft.until;
    until.addEventListener("input", () => { draft.until = until.value; update(); });
    part("ends").append(toggle("Never", () => { draft.ends = false; }), toggle("On a day", () => { draft.ends = true; }));
    const summary = form.querySelector(".repeat-summary");
    const save = form.querySelector(".primary-button");

    function update() {
      const pressed = (buttons, isOn) => [...buttons].forEach((button, index) => button.setAttribute("aria-pressed", String(isOn(index))));
      pressed(part("freq").children, (index) => Object.keys(UNITS)[index] === draft.freq);
      part("interval").querySelector(".unit").textContent = UNITS[draft.freq] + (draft.interval === 1 ? "" : "s");
      part("interval").hidden = counting();
      // A week holds at most 7 days and a month 31.
      times.max = draft.freq === "WEEKLY" ? 7 : 31;
      if (draft.times > Number(times.max)) times.value = draft.times = Number(times.max);
      part("times").hidden = !counting();
      part("times").querySelector(".unit").textContent = `${draft.times === 1 ? "time" : "times"} a ${UNITS[draft.freq]}`;
      part("week-mode").hidden = draft.freq !== "WEEKLY";
      pressed(part("week-mode").children, (index) => (index === 1) === draft.anyDays);
      part("weekdays").hidden = draft.freq !== "WEEKLY" || draft.anyDays;
      pressed(part("weekdays").children, (index) => draft.weekdays.includes(weekdays[index]));
      part("month-mode").hidden = draft.freq !== "MONTHLY";
      pressed(part("month-mode").children, (index) => (draft.anyDays ? index === 2 : index === Number(draft.onThe)));
      part("month-days").hidden = draft.freq !== "MONTHLY" || draft.anyDays || draft.onThe;
      pressed(monthDays, (index) => draft.monthDays.includes(index + 1));
      part("on-the").hidden = draft.freq !== "MONTHLY" || draft.anyDays || !draft.onThe;
      pressed(part("ends").children, (index) => (index === 1) === draft.ends);
      until.hidden = !draft.ends;
      const rule = result();
      const first = draft.ends && !draft.until ? null : firstDayOf(parseRule(rule), task.day);
      const label = first && dayLabel(first);
      const starting = ["Today", "Tomorrow", "Yesterday"].includes(label) ? label.toLowerCase() : label;
      save.disabled = !first;
      summary.textContent = !first ? "This repeat ends before it starts."
        : first === task.day ? `${describeRule(rule)}.` : `${describeRule(rule)}, starting ${starting}.`;
      // Choices that make the box taller could push it off the screen.
      if (!popover.hidden) placePopover(anchor);
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (save.disabled) return;
      closePopover();
      setRepeat(task, result());
    });
    update();
    rovingFocus(monthDays, 7);
    box.append(form);
  });
}

// Arrow keys move through a grid of buttons, so Tab passes it in one step.
function rovingFocus(buttons, columns) {
  const start = buttons.find((button) => button.getAttribute("aria-pressed") === "true") ?? buttons[0];
  buttons.forEach((button) => { button.tabIndex = button === start ? 0 : -1; });
  buttons[0].parentElement.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
    const target = buttons[buttons.indexOf(event.target) + step];
    if (!step || !target) return;
    event.preventDefault();
    event.stopPropagation();
    event.target.tabIndex = -1;
    target.tabIndex = 0;
    target.focus();
  });
}

function reminderPresets() {
  const now = new Date();
  const presets = [["In 1 hour", toMinute(new Date(now.getTime() + 3600e3))]];
  if (now.getHours() < 18) presets.push(["This evening", `${state.today}T18:00`]);
  presets.push(["Tomorrow morning", `${addDays(state.today, 1)}T09:00`]);
  return presets;
}

function openReminderPopover(task, anchor) {
  const now = new Date();
  let day = task.remind_at?.slice(0, 10) ?? task.day ?? state.today;
  if (day < state.today) day = state.today;
  if (day === state.today && now.getHours() === 23) day = addDays(state.today, 1);
  const defaultTime = day === state.today ? `${pad(now.getHours() + 1)}:00` : "09:00";

  openPopover(anchor, (box) => {
    for (const [label, when] of reminderPresets()) {
      box.append(menuItem(label, formatTime(when), () => setReminder(task, when)));
    }
    const line = document.createElement("form");
    line.className = "time-line";
    line.innerHTML = '<input type="time" required aria-label="Time"><button class="primary-button" type="submit">Remind me</button>';
    const time = line.querySelector("input");
    const submit = line.querySelector("button");
    time.value = task.remind_at?.slice(11) ?? defaultTime;
    const check = () => { submit.disabled = !time.value || `${day}T${time.value}` <= toMinute(new Date()); };
    time.addEventListener("input", check);
    line.addEventListener("submit", (event) => {
      event.preventDefault();
      check();
      if (submit.disabled) return;
      closePopover();
      setReminder(task, `${day}T${time.value}`);
    });
    check();
    box.append(document.createElement("hr"),
      buildCalendar(day, (picked) => { day = picked; check(); }),
      line);
    if (task.remind_at) {
      box.append(document.createElement("hr"), menuItem("Remove reminder", "", () => setReminder(task, null)));
    }
  });
}

// A grid of times to choose from, with the one chosen pressed.
function timePicks(choices, chosen, onPick) {
  const grid = document.createElement("div");
  grid.className = "time-picks";
  const buttons = choices.map((minutes) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = minutes ? formatMinutes(minutes) : "None";
    button.setAttribute("aria-pressed", String(minutes === chosen));
    button.addEventListener("click", () => {
      closePopover();
      onPick(minutes);
    });
    return button;
  });
  grid.append(...buttons);
  rovingFocus(buttons, 4);
  return grid;
}

// The time a day has for tasks: that day alone, or every such weekday.
function openDayTimePopover(day, anchor) {
  const code = WEEKDAY_CODES[toDate(day).getDay()];
  const weekday = formatDay(day, { weekday: "long" });
  let every = false;
  openPopover(anchor, (box) => {
    const toggle = document.createElement("div");
    toggle.className = "segmented";
    const modes = [`Only ${formatDay(day, { month: "short", day: "numeric" })}`, `Every ${weekday}`].map((label, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        every = Boolean(index);
        show();
      });
      return button;
    });
    toggle.append(...modes);
    const holder = document.createElement("div");
    const reset = menuItem(`Same as every ${weekday}`, formatMinutes(state.time.weekdays[code]), () => setDayTime(day, null));
    const show = () => {
      modes.forEach((button, index) => button.setAttribute("aria-pressed", String(Boolean(index) === every)));
      holder.replaceChildren(timePicks(DAY_TIMES, every ? state.time.weekdays[code] : timeOn(day), (minutes) => {
        // Every Tuesday includes this one.
        if (every && day in state.time.days) setDayTime(day, null);
        setDayTime(every ? code : day, minutes);
      }));
      reset.hidden = every || !(day in state.time.days);
    };
    show();
    box.append(toggle, holder, reset);
  });
}

// Planning's list beside the week can be the Inbox, Overdue, or any project's tasks with no day.
function openBacklogMenu(anchor) {
  const count = (list) => state.tasks.filter((task) => !task.done_at && inBacklog(task, list)).length;
  const choice = (label, list) => menuItem(label, String(count(list) || ""), () => {
    planFrom = list;
    animated(render);
  }, list === planFrom ? "chosen" : "");
  openPopover(anchor, (box) => {
    box.append(choice("Inbox", "inbox"));
    if (count("overdue") || planFrom === "overdue") box.append(choice("Overdue", "overdue"));
    const projects = state.projects.filter((project) => !project.completed_at).sort((a, b) => a.rank - b.rank);
    if (projects.length) box.append(document.createElement("hr"), ...projects.map((project) => choice(project.title, `project:${project.id}`)));
  });
  popover.querySelector(".chosen")?.focus({ preventScroll: true });
}

function openProjectPopover(task, anchor) {
  openPopover(anchor, (box) => {
    const input = document.createElement("input");
    input.className = "popover-input";
    input.placeholder = "Find or create a project";
    input.setAttribute("aria-label", input.placeholder);
    const results = document.createElement("div");
    box.append(input, results);

    const choose = (project) => setProject(task, project.id);
    const draw = () => {
      const query = input.value.trim();
      const lower = query.toLowerCase();
      const matches = state.projects
        .filter((project) => !project.completed_at && project.title.toLowerCase().includes(lower))
        .sort((a, b) => a.rank - b.rank);
      const items = matches.map((project) => menuItem(project.title, project.id === task.project_id ? "✓" : "", () => choose(project)));
      if (query && !matches.some((project) => project.title.toLowerCase() === lower)) {
        items.push(menuItem(`Create “${query}”`, "", () => choose(createProject(query))));
      }
      if (!query && task.project_id) items.push(menuItem("No project", "", () => setProject(task, null)));
      results.replaceChildren(...items);
      items[0]?.classList.add("active");
    };
    input.addEventListener("input", draw);
    input.addEventListener("keydown", (event) => {
      const items = [...results.children];
      const active = items.findIndex((item) => item.classList.contains("active"));
      const step = stepKey(event) || { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (event.key === "Enter") {
        event.preventDefault();
        items[active]?.click();
      } else if (step) {
        event.preventDefault();
        if (!items.length) return;
        items[active]?.classList.remove("active");
        items[(active + step + items.length) % items.length].classList.add("active");
      }
    });
    draw();
  });
}

projectMenuButton.addEventListener("click", () => {
  const project = findProject(view.id);
  if (!project) return;
  openPopover(projectMenuButton, (box) => {
    box.append(
      menuItem(project.description ? "Edit description" : "Add description", "", editDescription),
      project.completed_at
        ? menuItem("Reopen project", "", () => setProjectCompleted(project, false))
        : menuItem("Complete project", "", () => setProjectCompleted(project, true)),
      menuItem("Delete project", "", () => deleteProject(project), "danger"),
    );
  });
});

document.addEventListener("pointerdown", (event) => {
  // Clicking away from the tasks lets go of the selected one, so keys stop acting on it.
  if (!event.target.closest(".row, #popover, #toast")) clearSelection();
  if (!popover.contains(event.target)) closePopover();
});

// Project titles and new projects

pageTitle.addEventListener("click", () => {
  if (!pageTitle.hasAttribute("data-editable") || pageTitle.isContentEditable) return;
  pageTitle.contentEditable = "plaintext-only";
  editHistory.host = null;
  pageTitle.focus();
  getSelection().selectAllChildren(pageTitle);
  getSelection().collapseToEnd();
});

pageTitle.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") pageTitle.textContent = findProject(view.id)?.title ?? "";
    pageTitle.blur();
  }
});

pageTitle.addEventListener("blur", () => {
  if (!document.hasFocus()) return;
  pageTitle.removeAttribute("contenteditable");
  const project = findProject(view.id);
  if (!project) return;
  const title = pageTitle.textContent.replace(/\s+/g, " ").trim();
  if (title && title !== project.title) {
    project.title = title;
    send("PATCH", `/api/projects/${project.id}`, { title });
  }
  render();
});

function showDescription(text) {
  showLinks(projectDescription, text);
  projectDescription.hidden = !text;
}

function editDescription() {
  projectDescription.hidden = false;
  projectDescription.textContent = findProject(view.id)?.description ?? "";
  projectDescription.contentEditable = "plaintext-only";
  editHistory.host = null;
  projectDescription.focus();
  getSelection().selectAllChildren(projectDescription);
  getSelection().collapseToEnd();
}

projectDescription.addEventListener("click", (event) => {
  if (!event.target.closest("a") && !projectDescription.isContentEditable) editDescription();
});

projectDescription.addEventListener("paste", (event) => {
  const url = event.clipboardData.getData("text/plain").trim();
  const selected = getSelection().toString();
  if (!URL_RE.test(url) || !selected.trim()) return;
  event.preventDefault();
  document.execCommand("insertText", false, linkMarkup(selected, url));
});

projectDescription.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.stopPropagation();
  projectDescription.textContent = findProject(view.id)?.description ?? "";
  projectDescription.blur();
});

projectDescription.addEventListener("blur", () => {
  if (!document.hasFocus()) return;
  projectDescription.removeAttribute("contenteditable");
  const project = findProject(view.id);
  const description = projectDescription.innerText.trim();
  if (project && description !== project.description) {
    project.description = description;
    send("PATCH", `/api/projects/${project.id}`, { description });
  }
  render();
});

document.getElementById("add-project").addEventListener("click", () => {
  newProjectForm.hidden = false;
  newProjectInput.focus();
});

newProjectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = newProjectInput.value.trim();
  newProjectInput.value = "";
  newProjectForm.hidden = true;
  if (!title) return;
  const project = createProject(title);
  location.hash = `#project/${project.id}`;
});

newProjectInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.stopPropagation();
    newProjectInput.value = "";
    newProjectInput.blur();
  }
});

newProjectInput.addEventListener("blur", () => {
  if (!newProjectInput.value.trim()) newProjectForm.hidden = true;
});

completedToggle.addEventListener("click", () => {
  completedProjects.hidden = !completedProjects.hidden;
});

// Dragging: the row itself travels through the list as an empty slot, while a
// copy follows the pointer. Dropping on the sidebar assigns instead of reorders.

function pressRow(event) {
  typingIntoLink = null;
  if (event.button !== 0 || event.ctrlKey || event.pointerType === "touch") return;
  const row = event.target.closest(".row");
  if (!row || event.target.closest("button, input") || row.classList.contains("editing")) return;
  const movable = row.parentElement.classList.contains("list");
  trackPress(event, row, movable ? { kind: "task" } : null, (up) => {
    if (!event.target.closest("a")) beginEdit(row, { x: up.clientX, y: up.clientY });
  });
}

function pressProject(event) {
  if (event.button !== 0 || event.pointerType === "touch") return;
  const link = event.target.closest(".nav-row");
  if (link) trackPress(event, link, { kind: event.currentTarget === viewsNav ? "view" : "project" }, () => {});
}

function trackPress(down, element, options, onClick) {
  const { pointerId, clientX: startX, clientY: startY } = down;
  let dragged = false;
  const move = (event) => {
    if (event.pointerId !== pointerId) return;
    if (!dragged && options && Math.hypot(event.clientX - startX, event.clientY - startY) >= DRAG_START_PX) {
      dragged = true;
      startDrag(element, event, startX, startY, options.kind);
    }
    if (drag) moveDrag(event);
  };
  const stop = (event) => {
    if (event.pointerId !== pointerId) return;
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", stop);
    removeEventListener("pointercancel", stop);
    if (drag) finishDrag(event.type === "pointerup");
    else if (!dragged && event.type === "pointerup") onClick(event);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", stop);
  addEventListener("pointercancel", stop);
}

function startDrag(element, event, startX, startY, kind) {
  closePopover();
  document.activeElement?.blur?.();
  // WebKit starts selecting the text the pointer passes over.
  getSelection().removeAllRanges();
  const box = element.getBoundingClientRect();
  const ghost = element.cloneNode(true);
  ghost.classList.add("drag-ghost");
  if (kind === "task") ghost.querySelector(".task-time").value = element.querySelector(".task-time").value;
  ghost.classList.remove("selected", "active");
  ghost.style.width = `${box.width}px`;
  document.body.append(ghost);
  element.classList.add("dragging");
  document.body.classList.add("is-dragging");
  drag = {
    kind, element, ghost, target: null, x: event.clientX, y: event.clientY, fromBacklog: Boolean(element.closest(".backlog")),
    grabX: startX - box.left, grabY: startY - box.top,
    home: element.parentElement, homeNext: element.nextElementSibling,
    frame: requestAnimationFrame(scrollWhileDragging),
  };
  document.body.setPointerCapture?.(event.pointerId);
}

function listUnderPointer(hit) {
  if (drag.kind === "project") return projectList;
  if (drag.kind === "view") return viewsNav;
  const group = drag.kind === "task" && hit?.closest(".group");
  // Search is in how well tasks match. Any other list takes the tasks it would show.
  if (!group || group.dataset.part === "results") return null;
  if (group.takes && !group.takes(findTask(drag.element.dataset.id))) return null;
  return group.querySelector(".rows.list");
}

function moveDrag(event) {
  drag.x = event.clientX;
  drag.y = event.clientY;
  drag.ghost.style.transform = `translate(${drag.x - drag.grabX}px, ${drag.y - drag.grabY}px)`;
  const hit = document.elementFromPoint(drag.x, drag.y);

  let target = drag.kind === "task" ? hit?.closest("[data-drop]") ?? null : null;
  // Planning's list takes back a task from the days, but not a habit, and its own tasks move within it.
  if (target?.dataset.drop === "unschedule" && (drag.fromBacklog || findTask(drag.element.dataset.id)?.repeat)) target = null;
  if (target !== drag.target) {
    drag.target?.classList.remove("drop-target");
    target?.classList.add("drop-target");
    drag.target = target;
  }
  if (target) return;

  const list = listUnderPointer(hit);
  // Over a list that would not take the task, letting go puts it back where it came from.
  drag.refused = !list && drag.kind === "task" && Boolean(hit?.closest(".group"));
  if (list) placeInList(list);
}

function placeInList(list) {
  const { element } = drag;
  const box = list.getBoundingClientRect();
  // A narrow window lays the sidebar out in a row.
  const style = getComputedStyle(list);
  const across = style.display.includes("flex") && style.flexDirection === "row";
  // offsetTop ignores the slide animations, so rows in motion do not flicker.
  const before = [...list.children].find((child) => child !== element && (across
    ? box.left + child.offsetLeft + child.offsetWidth / 2 > drag.x
    : box.top + child.offsetTop + child.offsetHeight / 2 > drag.y)) ?? null;
  if (element.parentElement === list && element.nextElementSibling === before) return;
  const selector = { task: ".rows.list .row", project: "#project-list .nav-row", view: "#views .nav-row" }[drag.kind];
  const rows = [...document.querySelectorAll(selector)].filter((row) => row !== element);
  const offsets = new Map(rows.map((row) => [row.dataset.key, row.getBoundingClientRect().top]));
  list.insertBefore(element, before);
  slideRows(offsets, rows);
}

function scrollWhileDragging() {
  if (!drag) return;
  if (drag.kind === "task") {
    const box = main.getBoundingClientRect();
    const speed = drag.y < box.top + EDGE_SCROLL_PX ? -10 : drag.y > box.bottom - EDGE_SCROLL_PX ? 10 : 0;
    if (speed && drag.x > box.left) {
      main.scrollTop += speed;
      const list = listUnderPointer(document.elementFromPoint(drag.x, drag.y));
      if (list) placeInList(list);
    }
  }
  drag.frame = requestAnimationFrame(scrollWhileDragging);
}

function finishDrag(commit) {
  const { element, ghost, target, home, homeNext, kind } = drag;
  cancelAnimationFrame(drag.frame);
  target?.classList.remove("drop-target");
  document.body.classList.remove("is-dragging");

  const assigned = commit && target;
  if (!commit || assigned || drag.refused) home.insertBefore(element, homeNext);
  const landing = element.getBoundingClientRect();
  const finish = () => {
    ghost.remove();
    element.classList.remove("dragging");
  };
  if (assigned || reducedMotion.matches) {
    finish();
  } else {
    const start = new DOMMatrixReadOnly(getComputedStyle(ghost).transform);
    ghost.animate([
      { transform: `translate(${start.e}px, ${start.f}px)` },
      { transform: `translate(${landing.left}px, ${landing.top}px)` },
    ], { duration: 130, easing: "ease-out", fill: "forwards" }).finished.then(finish, finish);
  }
  drag = null;

  if (!commit) return;
  if (assigned) {
    dropOnSidebar(findTask(element.dataset.id), target.dataset.drop);
  } else if (element.parentElement === home && element.nextElementSibling === homeNext) {
    return;
  } else if (kind === "project") {
    const ids = [...projectList.children].map((link) => link.dataset.key);
    ids.forEach((id, rank) => { findProject(id).rank = rank; });
    send("POST", "/api/order", { list: "projects", ids });
  } else if (kind === "view") {
    saveViewOrder();
  } else {
    const ids = [...element.parentElement.children].map((row) => row.dataset.id);
    applyOrder(element.closest(".group").dataset.list, ids);
  }
}

function dropOnSidebar(task, drop) {
  if (drop === "today") {
    if (task.day !== state.today) setDay(task, state.today);
  } else if (drop === "inbox") {
    patchTask(task, { project_id: null, day: null, repeat: null, habit_rank: null, overdue_rank: null, list_rank: nextRank("inbox") },
      { project_id: null, day: null });
  } else if (drop.startsWith("day:")) {
    setDay(task, drop.slice(4));
  } else if (drop === "unschedule") {
    const { day } = task;
    setDay(task, null);
    const project = findProject(task.project_id);
    showToast(project ? `Back in ${project.title}` : "Back in Inbox", () => setDay(task, day));
  } else {
    const projectId = drop.slice(8);
    if (task.project_id !== projectId) setProject(task, projectId);
  }
}

groupsEl.addEventListener("pointerdown", pressRow);
projectList.addEventListener("pointerdown", pressProject);
viewsNav.addEventListener("pointerdown", pressProject);

// Quick capture, help and toasts

function openCapture() {
  closePopover();
  help.hidden = true;
  capture.hidden = false;
  captureInput.focus();
}

function closeCapture(keepText = false) {
  capture.hidden = true;
  if (!keepText) captureInput.value = "";
  focusStart();
}

document.getElementById("capture-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const title = captureInput.value;
  createTask(title, "inbox");
  closeCapture();
  if (title.trim()) showToast("Added to Inbox");
});

captureInput.addEventListener("keydown", submitOnEnter);
captureInput.addEventListener("paste", pasteOneLine);
capture.addEventListener("pointerdown", (event) => { if (event.target === capture) closeCapture(true); });
help.addEventListener("pointerdown", (event) => { if (event.target === help) help.hidden = true; });
document.getElementById("help-toggle").addEventListener("click", () => { help.hidden = false; });

function hideToast() {
  toastEl.hidden = true;
  recentlyDeleted = [];
}

function showToast(message, undo) {
  clearTimeout(toastTimer);
  recentlyDeleted = [];
  document.getElementById("toast-message").textContent = message;
  const button = document.getElementById("toast-undo");
  button.hidden = !undo;
  button.onclick = () => {
    hideToast();
    undo();
  };
  toastEl.hidden = false;
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

// Keyboard

function goTo(hash) {
  // Ends any edit while its view is still the one on screen.
  document.activeElement?.blur();
  help.hidden = true;
  if (!capture.hidden) closeCapture(true);
  if (hash !== (location.hash || "#today")) {
    location.hash = hash;
    return;
  }
  // ⌘T comes back to today from another day.
  if (shownDay) showDay(state.today);
  focusStart();
}

// Ergon's Mac app runs these from its menu bar; each does what its key does here.
const MENU_COMMANDS = {
  today: () => goTo("#today"),
  week: () => goTo("#week"),
  plan: () => goTo("#plan"),
  inbox: () => goTo("#inbox"),
  habits: () => goTo("#habits"),
  goals: () => goTo("#goals"),
  search: () => startSearch(true),
  find: () => startSearch(false),
  jot: openCapture,
  newTask: () => {
    closePopover();
    help.hidden = true;
    if (!capture.hidden) closeCapture(true);
    focusAddRow();
  },
  shortcuts: () => { help.hidden = false; },
};

function menuCommand(name) {
  MENU_COMMANDS[name]?.();
}

document.addEventListener("keydown", (event) => {
  const command = event.metaKey && !event.shiftKey && !event.altKey ? event.key.toLowerCase() : "";
  if (command === "j") {
    event.preventDefault();
    openCapture();
    return;
  }
  if (VIEW_KEYS[command]) {
    event.preventDefault();
    goTo(VIEW_KEYS[command]);
    return;
  }
  if (event.metaKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === "u") {
    event.preventDefault();
    goTo("#plan");
    return;
  }
  if (command === "f" || command === "l") {
    event.preventDefault();
    startSearch(command === "l");
    return;
  }
  if (event.key === "Escape") {
    if (drag) finishDrag(false);
    else if (!capture.hidden) closeCapture();
    else if (!help.hidden) help.hidden = true;
    else if (!popover.hidden) closePopover();
    else if (view.kind === "goals" && clearGoalSelection()) return;
    else if (view.plan && !selectedId && !searchOpen) goTo("#week");
    else if (selectedId || !searchOpen) clearSelection();
    else closeSearch();
    return;
  }
  const typing = event.target.closest?.("input, textarea, [contenteditable]");
  const step = stepKey(event);
  if (step && !typing && capture.hidden && help.hidden && popover.hidden) {
    event.preventDefault();
    moveSelection(step);
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || !capture.hidden || !help.hidden || !popover.hidden) return;
  if ((event.key === " " || event.key === "Enter") && event.target.closest?.("button, a")) return;
  if (event.key === "?") {
    help.hidden = false;
    return;
  }
  if (view.kind === "goals") {
    goalsKey(event);
    return;
  }
  if (event.key === "n") {
    event.preventDefault();
    focusAddRow();
    return;
  }
  const up = event.key === "ArrowUp" || event.key === "k";
  const down = event.key === "ArrowDown" || event.key === "j";
  if (up || down) {
    event.preventDefault();
    if (event.altKey) moveSelectedTask(down ? 1 : -1);
    else moveSelection(down ? 1 : -1);
    return;
  }
  if (view.kind === "week" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    const task = selectedId && findTask(selectedId);
    if (!event.altKey) showWeek(addDays(weekShown(), 7 * step));
    else if (task && !task.done_at && !event.repeat) moveByDay(task, step);
    return;
  }

  // A held key repeats, and these act on a different task each time.
  const task = selectedId && findTask(selectedId);
  if (!task || event.repeat) return;
  const row = groupsEl.querySelector(`.row[data-id="${task.id}"]`);
  const open = !task.done_at;
  if (event.key === "Enter" || event.key === " " || event.key === "x") {
    event.preventDefault();
    toggleDone(task);
  } else if (event.key === "e") {
    event.preventDefault();
    beginEdit(row);
  } else if (event.key === "Backspace" || event.key === "Delete") {
    deleteTask(task);
  } else if (open && event.key === "t" && !task.repeat) {
    toggleToday(task);
  } else if (event.key === "m") {
    event.preventDefault();
    row.querySelector(".task-time").focus();
  } else if (open && { d: 1, r: 1, p: 1 }[event.key]) {
    event.preventDefault();
    row.classList.add("popover-open");
    runAction({ d: "day", r: "remind", p: "project" }[event.key], task, row);
  }
});

// Startup

addEventListener("hashchange", (event) => {
  view = parseHash();
  // Leaving Search goes back to the view it was opened from.
  if (view.kind === "search" && renderedView !== "search") viewBeforeSearch = new URL(event.oldURL).hash || "#today";
  closePopover();
  render();
});

restoreViewOrder();
addEventListener("focus", refresh);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, SYNC_MS);

refresh();
