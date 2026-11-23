"use strict";

// Goals: a map of boxes of text joined by arrows, on a space that pans and zooms. Boxes and arrows sync
// like tasks; where you are on the map, and how near, is this browser's own.

const SVG_NS = "http://www.w3.org/2000/svg";
const MAP_GRID = 24;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const ARROW_HEAD = 9;
// A box joined to another starts this far to its right.
const JOINED_GAP = 64;
// About the size of a new box, before it has any text.
const NEW_BOX = { w: 140, h: 40 };
// Room left for the page's title when showing the whole map.
const MAP_TOP = 120;
const MAP_MARGIN = 60;
const MAP_VIEW_KEY = "ergon.goals.view";

const goalsEl = document.getElementById("goals");
const goalPlane = document.getElementById("goal-plane");
const goalBoxesEl = document.getElementById("goal-boxes");
const goalArrowsEl = document.getElementById("goal-arrows");
const goalPending = document.getElementById("goal-pending");
const goalsEmpty = document.getElementById("goals-empty");
const goalsNav = document.getElementById("goals-nav");

// The map's place on screen: a point on it shows at (point * zoom + x, point * zoom + y). Null until
// first shown, when it takes in every box.
let mapView = loadMapView();
let saveMapTimer = 0;
// What is selected: { kind: "box" | "arrow", id }.
let goalSelected = null;
// A box being written for the first time, and the arrow joining it to another; both reach the server
// once it has some text.
let draft = null;
// The press under way: panning the map, moving a box, or drawing an arrow from a box.
let gesture = null;
// The zoom a trackpad pinch started from, while it lasts.
let pinchFrom = null;

const mapBoxes = () => (draft ? [...state.boxes, draft.box] : state.boxes);
const mapArrows = () => (draft?.arrow ? [...state.arrows, draft.arrow] : state.arrows);
const findBox = (id) => mapBoxes().find((box) => box.id === id);
const findArrow = (id) => state.arrows.find((arrow) => arrow.id === id);
const boxElement = (id) => goalBoxesEl.querySelector(`.goal-box[data-key="${id}"]`);
// Two boxes are joined once, whichever way the arrow points.
const joined = (a, b) => mapArrows().some((arrow) => (arrow.from_id === a && arrow.to_id === b) || (arrow.from_id === b && arrow.to_id === a));
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function loadMapView() {
  try {
    const saved = JSON.parse(localStorage.getItem(MAP_VIEW_KEY));
    if ([saved?.x, saved?.y, saved?.zoom].every(Number.isFinite)) return saved;
  } catch {
    // Storage can be off; the map then starts by showing every box.
  }
  return null;
}

function saveMapView() {
  clearTimeout(saveMapTimer);
  saveMapTimer = setTimeout(() => {
    try {
      localStorage.setItem(MAP_VIEW_KEY, JSON.stringify(mapView));
    } catch {
      // Only a convenience.
    }
  }, 300);
}

// Rendering

function renderGoals() {
  if (goalSelected && !(goalSelected.kind === "box" ? findBox(goalSelected.id) : findArrow(goalSelected.id))) goalSelected = null;
  syncChildren(goalBoxesEl, mapBoxes(), (box) => box.id, createBoxElement, updateBoxElement);
  if (!mapView) showWholeMap();
  placeMap();
  drawArrows();
  goalsEmpty.hidden = mapBoxes().length > 0;
}

function createBoxElement() {
  const element = document.createElement("div");
  element.className = "goal-box";
  element.innerHTML = '<div class="goal-text"></div>'
    + '<button class="goal-handle" type="button" tabindex="-1" title="Drag to another box to join them" aria-label="Join to another box"></button>';
  return element;
}

function updateBoxElement(element, box) {
  const at = gesture?.kind === "move" && gesture.id === box.id ? gesture.at : box;
  element.style.left = `${at.x}px`;
  element.style.top = `${at.y}px`;
  element.classList.toggle("selected", goalSelected?.kind === "box" && goalSelected.id === box.id);
  element.classList.toggle("unmatched", !boxMatches(box));
  const text = element.querySelector(".goal-text");
  if (!element.classList.contains("editing") && text.textContent !== box.text) text.textContent = box.text;
}

// ⌘F dims the boxes that don't hold every word searched for.
function boxMatches(box) {
  const text = fold(box.text);
  return searchTerms().every((term) => text.includes(term));
}

function placeMap() {
  const { x, y, zoom } = mapView;
  goalPlane.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  goalsEl.style.backgroundSize = `${MAP_GRID * zoom}px ${MAP_GRID * zoom}px`;
  goalsEl.style.backgroundPosition = `${x}px ${y}px`;
}

// A box's place and size on the map, as laid out.
function boxRect(id) {
  const element = boxElement(id);
  return element && { x: element.offsetLeft, y: element.offsetTop, w: element.offsetWidth, h: element.offsetHeight };
}

const middle = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

// Where a line from the middle of `rect` toward `point` leaves it, and `gap` further on.
function edgePoint(rect, point, gap = 0) {
  const center = middle(rect);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const length = Math.hypot(dx, dy);
  if (!length) return center;
  const reach = Math.min(dx ? rect.w / 2 / Math.abs(dx) : Infinity, dy ? rect.h / 2 / Math.abs(dy) : Infinity);
  return { x: center.x + dx * reach + (dx / length) * gap, y: center.y + dy * reach + (dy / length) * gap };
}

function createArrowElement() {
  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("class", "goal-arrow");
  group.innerHTML = '<line class="hit"/><line class="shaft"/><path class="head"/>';
  return group;
}

// An arrow runs between the edges of its boxes, as if from the middle of one to the middle of the other.
function shapeArrow(group, start, end) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const base = { x: end.x - ARROW_HEAD * cos, y: end.y - ARROW_HEAD * sin };
  const half = ARROW_HEAD / 2;
  for (const line of group.querySelectorAll("line")) {
    line.setAttribute("x1", start.x);
    line.setAttribute("y1", start.y);
    line.setAttribute("x2", line.classList.contains("hit") ? end.x : base.x + cos);
    line.setAttribute("y2", line.classList.contains("hit") ? end.y : base.y + sin);
  }
  group.querySelector(".head").setAttribute("d",
    `M${end.x},${end.y} L${base.x + half * sin},${base.y - half * cos} L${base.x - half * sin},${base.y + half * cos} Z`);
}

function updateArrowElement(group, arrow) {
  const from = boxRect(arrow.from_id);
  const to = boxRect(arrow.to_id);
  group.style.display = from && to ? "" : "none";
  if (!from || !to) return;
  shapeArrow(group, edgePoint(from, middle(to), 2), edgePoint(to, middle(from), 3));
  group.classList.toggle("selected", goalSelected?.kind === "arrow" && goalSelected.id === arrow.id);
  group.classList.toggle("unmatched", ![arrow.from_id, arrow.to_id].every((id) => boxMatches(findBox(id))));
}

function drawArrows() {
  syncChildren(goalArrowsEl, mapArrows(), (arrow) => arrow.id, createArrowElement, updateArrowElement);
}

// Moving around the map

function mapPoint(clientX, clientY) {
  const area = goalsEl.getBoundingClientRect();
  return { x: (clientX - area.left - mapView.x) / mapView.zoom, y: (clientY - area.top - mapView.y) / mapView.zoom };
}

// The middle of what's on screen, below the title.
function mapMiddle() {
  const area = goalsEl.getBoundingClientRect();
  return mapPoint(area.left + area.width / 2, area.top + (area.height + MAP_TOP) / 2);
}

function zoomAt(clientX, clientY, zoom) {
  const area = goalsEl.getBoundingClientRect();
  const to = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
  const [x, y] = [clientX - area.left, clientY - area.top];
  mapView = { x: x - (x - mapView.x) * (to / mapView.zoom), y: y - (y - mapView.y) * (to / mapView.zoom), zoom: to };
  placeMap();
  saveMapView();
}

function zoomBy(factor) {
  const area = goalsEl.getBoundingClientRect();
  zoomAt(area.left + area.width / 2, area.top + (area.height + MAP_TOP) / 2, mapView.zoom * factor);
}

// Every box in view, no nearer than full size.
function showWholeMap() {
  const area = goalsEl.getBoundingClientRect();
  const rects = mapBoxes().map((box) => boxRect(box.id)).filter(Boolean);
  if (!rects.length) {
    mapView = { x: Math.round(area.width / 2), y: Math.round((area.height + MAP_TOP) / 2), zoom: 1 };
  } else {
    const left = Math.min(...rects.map((rect) => rect.x));
    const top = Math.min(...rects.map((rect) => rect.y));
    const right = Math.max(...rects.map((rect) => rect.x + rect.w));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
    const room = { w: area.width - 2 * MAP_MARGIN, h: area.height - MAP_TOP - MAP_MARGIN };
    const zoom = clamp(Math.min(room.w / (right - left), room.h / (bottom - top)), ZOOM_MIN, 1);
    mapView = {
      x: Math.round(area.width / 2 - ((left + right) / 2) * zoom),
      y: Math.round(MAP_TOP + room.h / 2 - ((top + bottom) / 2) * zoom),
      zoom,
    };
  }
  placeMap();
  saveMapView();
}

// Brings a box on screen, if it's off it.
function revealBox(id) {
  const rect = boxRect(id);
  if (!rect) return;
  const area = goalsEl.getBoundingClientRect();
  const { x, y, zoom } = mapView;
  const [left, top] = [rect.x * zoom + x, rect.y * zoom + y];
  const [right, bottom] = [left + Math.max(rect.w, NEW_BOX.w) * zoom, top + Math.max(rect.h, NEW_BOX.h) * zoom];
  const dx = left < MAP_MARGIN ? MAP_MARGIN - left : right > area.width - MAP_MARGIN ? area.width - MAP_MARGIN - right : 0;
  const dy = top < MAP_TOP ? MAP_TOP - top : bottom > area.height - MAP_MARGIN ? area.height - MAP_MARGIN - bottom : 0;
  if (!dx && !dy) return;
  mapView = { x: x + dx, y: y + dy, zoom };
  placeMap();
  saveMapView();
}

// Changing the map

function selectGoal(kind, id) {
  goalSelected = id ? { kind, id } : null;
  renderGoals();
}

const cleanText = (text) => text.replace(/ /g, " ").trim().split("\n").map((line) => line.trim()).join("\n");

function editingBox() {
  return goalBoxesEl.querySelector(".goal-box.editing");
}

function editBox(id, point) {
  const current = editingBox();
  if (current && current.dataset.key !== id) finishEdit(current, true);
  const element = boxElement(id);
  if (!element || element.classList.contains("editing")) return;
  goalSelected = { kind: "box", id };
  renderGoals();
  element.classList.add("editing");
  const text = element.querySelector(".goal-text");
  text.contentEditable = "plaintext-only";
  text.focus();
  const range = point && document.caretRangeFromPoint?.(point.x, point.y);
  const selection = getSelection();
  if (range && text.contains(range.startContainer)) {
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    selection.selectAllChildren(text);
    selection.collapseToEnd();
  }
}

// Saving keeps what was written; emptying a box deletes it, as emptying a task's title does.
function finishEdit(element, save) {
  if (!element.classList.contains("editing")) return;
  element.classList.remove("editing");
  const text = element.querySelector(".goal-text");
  const written = cleanText(text.innerText);
  text.removeAttribute("contenteditable");
  getSelection().removeAllRanges();
  const id = element.dataset.key;
  if (draft?.box.id === id) {
    const { box, arrow } = draft;
    draft = null;
    if (save && written) {
      box.text = written;
      state.boxes.push(box);
      send("POST", "/api/boxes", box);
      if (arrow) {
        state.arrows.push(arrow);
        send("POST", "/api/arrows", arrow);
      }
    } else if (goalSelected?.id === id) {
      goalSelected = null;
    }
  } else {
    const box = findBox(id);
    if (box && save && written && written !== box.text) {
      box.text = written;
      send("PATCH", `/api/boxes/${id}`, { text: written });
    } else if (box && save && !written) {
      deleteBox(box);
    }
    text.textContent = findBox(id)?.text ?? "";
  }
  renderGoals();
}

// A new box, written straight away, and joined to the box `from` when given.
function startBox(x, y, from = null) {
  const current = editingBox();
  if (current) finishEdit(current, true);
  const box = { id: crypto.randomUUID(), text: "", x: Math.round(x), y: Math.round(y) };
  draft = { box, arrow: from && findBox(from) ? { id: crypto.randomUUID(), from_id: from, to_id: box.id } : null };
  renderGoals();
  revealBox(box.id);
  editBox(box.id);
}

// Joined boxes go to the right of the box they come from, one under another.
function addJoinedBox(from) {
  const rect = boxRect(from);
  if (!rect) return;
  const taken = mapBoxes().filter((box) => box.id !== from).map((box) => boxRect(box.id)).filter(Boolean);
  const x = rect.x + rect.w + JOINED_GAP;
  let y = rect.y;
  const overlaps = (other) => x < other.x + other.w + 12 && x + NEW_BOX.w + 12 > other.x && y < other.y + other.h + 12 && y + NEW_BOX.h + 12 > other.y;
  while (taken.some(overlaps)) y += NEW_BOX.h + 16;
  startBox(x, y, from);
}

function joinBoxes(from, to) {
  if (from === to || joined(from, to) || draft?.box.id === from || draft?.box.id === to) return;
  const arrow = { id: crypto.randomUUID(), from_id: from, to_id: to };
  state.arrows.push(arrow);
  send("POST", "/api/arrows", arrow);
  renderGoals();
}

function deleteBox(box) {
  const arrows = state.arrows.filter((arrow) => arrow.from_id === box.id || arrow.to_id === box.id);
  state.boxes = state.boxes.filter((other) => other !== box);
  state.arrows = state.arrows.filter((arrow) => !arrows.includes(arrow));
  send("PATCH", `/api/boxes/${box.id}`, { deleted: true });
  renderGoals();
  showToast("Deleted", () => {
    state.boxes.push(box);
    state.arrows.push(...arrows);
    send("PATCH", `/api/boxes/${box.id}`, { deleted: false });
    renderGoals();
  });
}

function deleteArrow(arrow) {
  state.arrows = state.arrows.filter((other) => other !== arrow);
  send("PATCH", `/api/arrows/${arrow.id}`, { deleted: true });
  renderGoals();
  showToast("Deleted arrow", () => {
    state.arrows.push(arrow);
    send("PATCH", `/api/arrows/${arrow.id}`, { deleted: false });
    renderGoals();
  });
}

// Keys, while nothing is being written; app.js sends them here in Goals.
function goalsKey(event) {
  const box = goalSelected?.kind === "box" ? findBox(goalSelected.id) : null;
  const arrow = goalSelected?.kind === "arrow" ? findArrow(goalSelected.id) : null;
  if (event.key === "n") {
    event.preventDefault();
    const at = mapMiddle();
    startBox(at.x - NEW_BOX.w / 2, at.y - NEW_BOX.h / 2);
  } else if (box && (event.key === "Enter" || event.key === "e")) {
    event.preventDefault();
    editBox(box.id);
  } else if (box && event.key === "Tab") {
    event.preventDefault();
    addJoinedBox(box.id);
  } else if ((box || arrow) && (event.key === "Backspace" || event.key === "Delete")) {
    event.preventDefault();
    if (box) deleteBox(box);
    else deleteArrow(arrow);
  }
}

// Esc puts away the selection first.
function clearGoalSelection() {
  if (!goalSelected) return false;
  selectGoal(null);
  return true;
}

// Writing in a box: Enter saves, Shift-Enter starts a new line, Tab saves and adds a box joined to
// it, and Esc puts the text back as it was.
goalBoxesEl.addEventListener("keydown", (event) => {
  const element = event.target.closest(".goal-box.editing");
  if (!element || event.isComposing) return;
  if (!((event.key === "Enter" && !event.shiftKey) || event.key === "Escape" || event.key === "Tab")) return;
  event.preventDefault();
  event.stopPropagation();
  const id = element.dataset.key;
  finishEdit(element, event.key !== "Escape");
  if (!findBox(id)) return;
  if (event.key === "Tab") addJoinedBox(id);
  else selectGoal("box", id);
});

goalBoxesEl.addEventListener("focusout", (event) => {
  const element = event.target.closest(".goal-box.editing");
  // Switching to another app keeps the box open, so writing carries on when you come back.
  if (element && document.hasFocus()) finishEdit(element, true);
});

// Pressing on the map

goalsEl.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || gesture) return;
  const handle = event.target.closest(".goal-handle");
  const boxEl = event.target.closest(".goal-box");
  // The box being written takes its own presses, to place the caret or select text.
  if (boxEl?.classList.contains("editing")) return;
  // Anything else ends writing, and keeps the keyboard off the box's dot.
  event.preventDefault();
  document.activeElement?.blur();
  const start = { x: event.clientX, y: event.clientY };
  const arrowEl = event.target.closest(".goal-arrow");
  if (handle && findBox(boxEl.dataset.key)) {
    gesture = { kind: "join", from: boxEl.dataset.key, start, moved: false };
  } else if (boxEl && findBox(boxEl.dataset.key)) {
    const box = findBox(boxEl.dataset.key);
    gesture = { kind: "move", id: box.id, start, at: { x: box.x, y: box.y }, origin: { x: box.x, y: box.y }, moved: false,
      wasSelected: goalSelected?.kind === "box" && goalSelected.id === box.id };
    selectGoal("box", box.id);
  } else if (arrowEl) {
    selectGoal("arrow", arrowEl.dataset.key);
    return;
  } else {
    gesture = { kind: "pan", start, origin: { x: mapView.x, y: mapView.y }, moved: false };
    goalsEl.classList.add("panning");
  }
  goalsEl.setPointerCapture(event.pointerId);
});

function boxUnder(event, except) {
  const element = document.elementFromPoint(event.clientX, event.clientY)?.closest(".goal-box");
  return element && element.dataset.key !== except && !element.classList.contains("editing") ? element : null;
}

goalsEl.addEventListener("pointermove", (event) => {
  if (!gesture) return;
  const dx = event.clientX - gesture.start.x;
  const dy = event.clientY - gesture.start.y;
  if (!gesture.moved && Math.hypot(dx, dy) < DRAG_START_PX) return;
  gesture.moved = true;
  if (gesture.kind === "pan") {
    mapView = { ...mapView, x: gesture.origin.x + dx, y: gesture.origin.y + dy };
    placeMap();
  } else if (gesture.kind === "move") {
    gesture.at = { x: Math.round(gesture.origin.x + dx / mapView.zoom), y: Math.round(gesture.origin.y + dy / mapView.zoom) };
    const element = boxElement(gesture.id);
    element.style.left = `${gesture.at.x}px`;
    element.style.top = `${gesture.at.y}px`;
    drawArrows();
  } else {
    const target = boxUnder(event, gesture.from);
    goalBoxesEl.querySelectorAll(".drop-target").forEach((element) => element !== target && element.classList.remove("drop-target"));
    target?.classList.add("drop-target");
    const from = boxRect(gesture.from);
    const end = target ? edgePoint(boxRect(target.dataset.key), middle(from), 3) : mapPoint(event.clientX, event.clientY);
    goalPending.style.display = "";
    shapeArrow(goalPending, edgePoint(from, end, 2), end);
  }
});

goalsEl.addEventListener("pointerup", (event) => {
  const done = gesture;
  gesture = null;
  goalsEl.classList.remove("panning");
  if (!done) return;
  if (done.kind === "pan") {
    if (done.moved) saveMapView();
    else selectGoal(null);
  } else if (done.kind === "move") {
    const box = findBox(done.id);
    if (done.moved && box) {
      Object.assign(box, done.at);
      send("PATCH", `/api/boxes/${box.id}`, done.at);
      renderGoals();
    } else if (done.wasSelected) {
      // A click on the selected box starts writing in it, where it was clicked.
      editBox(done.id, { x: event.clientX, y: event.clientY });
    }
  } else {
    const target = boxUnder(event, done.from);
    goalPending.style.display = "none";
    goalBoxesEl.querySelectorAll(".drop-target").forEach((element) => element.classList.remove("drop-target"));
    if (!done.moved) {
      addJoinedBox(done.from);
    } else if (target) {
      joinBoxes(done.from, target.dataset.key);
    } else {
      // Let go on empty space: a new box there, joined to the first.
      const at = mapPoint(event.clientX, event.clientY);
      startBox(at.x - NEW_BOX.w / 2, at.y - NEW_BOX.h / 2, done.from);
    }
  }
});

goalsEl.addEventListener("pointercancel", () => {
  gesture = null;
  goalsEl.classList.remove("panning");
  goalPending.style.display = "none";
  renderGoals();
});

goalsEl.addEventListener("dblclick", (event) => {
  // The map holds on to the pointer while pressed, so the event comes from it rather than what's under it.
  const under = document.elementFromPoint(event.clientX, event.clientY);
  const boxEl = under?.closest(".goal-box");
  if (boxEl) {
    if (findBox(boxEl.dataset.key)) editBox(boxEl.dataset.key, { x: event.clientX, y: event.clientY });
    return;
  }
  if (under?.closest(".goal-arrow, .page-heading")) return;
  const at = mapPoint(event.clientX, event.clientY);
  startBox(at.x - NEW_BOX.w / 2, at.y - NEW_BOX.h / 2);
});

// Two fingers on a trackpad move the map, and pinching zooms; so do a mouse's wheel, and the wheel with ⌃.
goalsEl.addEventListener("wheel", (event) => {
  event.preventDefault();
  const scale = event.deltaMode === 1 ? 16 : 1;
  if (event.ctrlKey) {
    if (!pinchFrom) zoomAt(event.clientX, event.clientY, mapView.zoom * Math.exp(-event.deltaY * scale * 0.01));
    return;
  }
  mapView = { ...mapView, x: mapView.x - event.deltaX * scale, y: mapView.y - event.deltaY * scale };
  placeMap();
  saveMapView();
}, { passive: false });

// Safari and Ergon's Mac app tell of a pinch as a gesture of its own.
goalsEl.addEventListener("gesturestart", (event) => {
  event.preventDefault();
  pinchFrom = mapView.zoom;
});
goalsEl.addEventListener("gesturechange", (event) => {
  event.preventDefault();
  if (pinchFrom) zoomAt(event.clientX, event.clientY, pinchFrom * event.scale);
});
goalsEl.addEventListener("gestureend", (event) => {
  event.preventDefault();
  pinchFrom = null;
});

document.getElementById("goals-out").addEventListener("click", () => zoomBy(1 / 1.25));
document.getElementById("goals-in").addEventListener("click", () => zoomBy(1.25));
document.getElementById("goals-all").addEventListener("click", showWholeMap);
