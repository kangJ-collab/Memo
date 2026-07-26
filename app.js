"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const T = window.KKAMEOKJA_TEXT_KO;

if (!T) {
  throw new Error("Missing language data: lang-ko.js");
}

const STORAGE_KEY = "kkameokja-data-v2";
const LEGACY_KEY = "naegememo-data-v1";
const DAY = 86_400_000;

const THEME_COLORS = Object.freeze({
  base: "#F6F7F9",
  mist: "#ECEFF2",
  cream: "#F7F1E5",
  leaf: "#EAF2E9",
  sky: "#EAF2F8",
  violet: "#F0ECF8",
  apricot: "#FAEEE6",
  rose: "#F8EDEF",
  night: "#151B22"
});

const DEFAULT_STATE = Object.freeze({
  version: 2,
  notes: [],
  settings: {
    theme: "base",
    customThemeColor: "#F6F7F9",
    fontSize: 15,
    fontWeight: 400,
    density: "normal",
    cardShape: "standard",
    defaultMode: "memo",
    urlDetect: true,
    sort: "bottom",
    onboarded: false,
    linkView: "list"
  }
});

let state = loadState();
let currentTab = "main";
let currentMode = state.settings.defaultMode;
let currentFilter = "all";
let archiveStatus = "archived";
let detailId = null;
let composeMode = "text";
let pendingRevisit = null;
let revisitContext = { mode: "compose", noteId: null };
let selectedRevisit = null;
let confirmAction = null;
let pressTimer = null;
let suppressClickUntil = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeId() {
  return crypto.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function normalizeNote(note) {
  const type = note.type === "todo"
    ? "checklist"
    : note.type === "memo"
      ? "text"
      : ["text", "link", "checklist"].includes(note.type)
        ? note.type
        : "text";

  const createdAt = note.createdAt || new Date().toISOString();
  const normalized = {
    id: note.id || makeId(),
    text: String(note.text || ""),
    type,
    status: ["inbox", "archived", "completed", "trashed"].includes(note.status)
      ? note.status
      : "inbox",
    pinned: Boolean(note.pinned),
    revisitAt: note.revisitAt || null,
    createdAt,
    updatedAt: note.updatedAt || createdAt,
    trashedAt: note.trashedAt || null,
    completedAt: note.completedAt || null
  };

  if (type === "checklist") {
    normalized.items = Array.isArray(note.items)
      ? note.items.map((item) => ({ text: String(item.text || ""), done: Boolean(item.done) }))
      : String(note.text || "")
        .split("\n")
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => ({ text, done: false }));
  }

  return normalized;
}

function normalizeState(raw) {
  const settings = {
    ...clone(DEFAULT_STATE.settings),
    ...(raw?.settings || {})
  };

  if (["light", "system"].includes(settings.theme)) {
    settings.theme = "base";
  }
  if (settings.theme === "dark") {
    settings.theme = "night";
  }
  if (![...Object.keys(THEME_COLORS), "custom"].includes(settings.theme)) {
    settings.theme = "base";
  }
  if (!["memo", "todo"].includes(settings.defaultMode)) {
    settings.defaultMode = "memo";
  }
  if (!["bottom", "top"].includes(settings.sort)) {
    settings.sort = "bottom";
  }
  if (!["wide", "normal", "compact"].includes(settings.density)) {
    settings.density = "normal";
  }
  if (!["standard", "round"].includes(settings.cardShape)) {
    settings.cardShape = "standard";
  }
  if (!["list", "grid"].includes(settings.linkView)) {
    settings.linkView = "list";
  }

  return {
    version: 2,
    notes: Array.isArray(raw?.notes) ? raw.notes.map(normalizeNote) : [],
    settings
  };
}

function loadState() {
  try {
    const current = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (current && Array.isArray(current.notes)) {
      return normalizeState(current);
    }

    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY));
    if (legacy && Array.isArray(legacy.notes)) {
      const migrated = normalizeState(legacy);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch (error) {
    console.warn("Failed to load saved data", error);
  }

  return clone(DEFAULT_STATE);
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function escapeHtml(value = "") {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function firstUrl(text = "") {
  return (text.match(/https?:\/\/[^\s]+/i) || [])[0] || "";
}

function hasDetectedUrl(text = "") {
  return state.settings.urlDetect && Boolean(firstUrl(text));
}

function formatTime(value) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function isToday(value) {
  return new Date(value).toDateString() === new Date().toDateString();
}

function activeNote() {
  return state.notes.find((note) => note.id === detailId) || null;
}

function clamp(number, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, number));
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(clean)) {
    return { r: 246, g: 247, b: 249 };
  }
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b]
    .map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function mixHex(first, second, amount) {
  const a = hexToRgb(first);
  const b = hexToRgb(second);
  return rgbToHex({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount
  });
}

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const channels = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function clearCustomPalette() {
  const style = document.documentElement.style;
  [
    "--page-bg", "--app-bg", "--surface", "--surface-soft", "--text",
    "--text-soft", "--text-faint", "--line", "--accent", "--accent-soft"
  ].forEach((property) => style.removeProperty(property));
}

function applyCustomPalette(color) {
  const root = document.documentElement;
  const style = root.style;
  const dark = luminance(color) < 0.27;
  const appBg = color;
  const surface = dark ? mixHex(color, "#FFFFFF", 0.085) : mixHex(color, "#FFFFFF", 0.72);
  const surfaceSoft = dark ? mixHex(color, "#FFFFFF", 0.14) : mixHex(color, "#000000", 0.04);
  const line = dark ? mixHex(color, "#FFFFFF", 0.2) : mixHex(color, "#000000", 0.11);
  const text = dark ? "#F1F4F6" : "#1E2935";
  const textSoft = dark ? "#A9B4BE" : "#687583";
  const textFaint = dark ? "#788591" : "#919CA7";
  const accent = dark ? "#71C3B3" : "#397E73";
  const accentSoft = dark ? mixHex(color, "#71C3B3", 0.22) : mixHex(color, "#397E73", 0.12);

  root.dataset.theme = "custom";
  root.style.colorScheme = dark ? "dark" : "light";
  style.setProperty("--page-bg", dark ? mixHex(color, "#000000", 0.38) : mixHex(color, "#000000", 0.08));
  style.setProperty("--app-bg", appBg);
  style.setProperty("--surface", surface);
  style.setProperty("--surface-soft", surfaceSoft);
  style.setProperty("--text", text);
  style.setProperty("--text-soft", textSoft);
  style.setProperty("--text-faint", textFaint);
  style.setProperty("--line", line);
  style.setProperty("--accent", accent);
  style.setProperty("--accent-soft", accentSoft);
}

function applySettings() {
  const root = document.documentElement;
  const settings = state.settings;

  clearCustomPalette();
  root.style.removeProperty("color-scheme");
  root.dataset.theme = settings.theme;
  root.dataset.density = settings.density;
  root.dataset.cardShape = settings.cardShape;
  root.style.setProperty("--font-size", `${settings.fontSize}px`);
  root.style.setProperty("--font-weight", String(settings.fontWeight));

  if (settings.theme === "custom") {
    applyCustomPalette(settings.customThemeColor);
  } else if (settings.theme !== "night") {
    root.style.setProperty("--app-bg", THEME_COLORS[settings.theme] || THEME_COLORS.base);
    root.style.setProperty("--page-bg", mixHex(THEME_COLORS[settings.theme] || THEME_COLORS.base, "#000000", 0.08));
  }

  const themeColor = settings.theme === "night" ? "#151B22" : "#397E73";
  $('meta[name="theme-color"]')?.setAttribute("content", themeColor);

  $$("#theme-grid [data-theme]").forEach((button) => {
    button.classList.toggle("active", button.dataset.theme === settings.theme);
  });

  $("#custom-theme-color").value = settings.customThemeColor;
  $("#font-size-range").value = settings.fontSize;
  $("#font-size-output").textContent = `${settings.fontSize}px`;
  $("#url-detect-toggle").checked = settings.urlDetect;

  setSegmentValue("#font-weight-segment", String(settings.fontWeight));
  setSegmentValue("#density-segment", settings.density);
  setSegmentValue("#card-shape-segment", settings.cardShape);
  setSegmentValue("#default-mode-segment", settings.defaultMode);
  setSegmentValue("#sort-segment", settings.sort);
  setSegmentValue("#link-view-segment", settings.linkView, "view");
}

function setSegmentValue(selector, value, dataKey = "value") {
  $$(`${selector} button`).forEach((button) => {
    button.classList.toggle("active", button.dataset[dataKey] === value);
  });
}

function sorted(notes) {
  const result = [...notes];
  result.sort((a, b) => {
    const difference = new Date(a.createdAt) - new Date(b.createdAt);
    return state.settings.sort === "top" ? -difference : difference;
  });
  return result;
}

function checklistItems(note) {
  if (Array.isArray(note.items)) {
    return note.items;
  }
  return note.text
    .split("\n")
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ text, done: false }));
}

function noteTypeForText(text) {
  if (composeMode === "checklist" || currentMode === "todo") {
    return "checklist";
  }
  return hasDetectedUrl(text) ? "link" : "text";
}

function emptyState(message) {
  return `<div class="empty-state"><div><svg><use href="#i-note"></use></svg><div>${message}</div></div></div>`;
}

function badgeHtml(note) {
  const badges = [];
  if (note.pinned) {
    badges.push(`<span class="badge pin"><svg><use href="#i-pin"></use></svg>${T.pinned}</span>`);
  }
  if (note.revisitAt) {
    const overdue = new Date(note.revisitAt) <= new Date();
    badges.push(`<span class="badge ${overdue ? "overdue" : "revisit"}"><svg><use href="#i-clock"></use></svg>${T.revisit}</span>`);
  }
  if (note.status === "completed") {
    badges.push(`<span class="badge completed"><svg><use href="#i-check"></use></svg>${T.completed}</span>`);
  }
  return badges.join("");
}

function noteContentHtml(note, interactive = true) {
  if (note.type === "checklist") {
    return checklistItems(note)
      .map((item, index) => `
        <div class="checklist-row ${item.done ? "done" : ""}" ${interactive ? `data-check-index="${index}"` : ""}>
          <span class="checklist-box"></span>
          <span class="checklist-text">${escapeHtml(item.text)}</span>
        </div>
      `)
      .join("");
  }

  let html = `<div class="note-text">${escapeHtml(note.text)}</div>`;
  const url = firstUrl(note.text);
  if ((note.type === "link" || hasDetectedUrl(note.text)) && url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      html += `
        <div class="link-preview">
          <span class="link-icon"><svg><use href="#i-link"></use></svg></span>
          <span class="link-info">
            <strong>${escapeHtml(host)}</strong>
            <small>${escapeHtml(url)}</small>
          </span>
        </div>
      `;
    } catch {
      // Invalid URLs remain plain text.
    }
  }
  return html;
}

function cardHtml(note) {
  return `
    <div class="card-wrap" data-note-id="${note.id}">
      <article class="note-card type-${note.type} ${note.status === "completed" ? "is-completed" : ""}" data-open-note="${note.id}">
        ${noteContentHtml(note)}
        <div class="note-meta">
          <div class="note-badges">${badgeHtml(note)}</div>
          <time class="note-time">${formatTime(note.createdAt)}</time>
        </div>
      </article>
    </div>
  `;
}

function mainNotes() {
  let notes = state.notes.filter((note) => note.status === "inbox");
  notes = notes.filter((note) => currentMode === "todo" ? note.type === "checklist" : note.type !== "checklist");

  if (currentFilter === "today") {
    notes = notes.filter((note) => isToday(note.createdAt));
  } else if (currentFilter === "pinned") {
    notes = notes.filter((note) => note.pinned);
  } else if (currentFilter === "links") {
    notes = notes.filter((note) => note.type === "link" || firstUrl(note.text));
  }

  return sorted(notes);
}

function renderMain() {
  const notes = mainNotes();
  const list = $("#main-list");
  const emptyMessage = currentFilter === "all"
    ? currentMode === "todo" ? T.emptyTodo : T.emptyMemo
    : T.emptyFiltered;

  list.classList.toggle("link-grid", currentFilter === "links" && state.settings.linkView === "grid");
  list.innerHTML = notes.length ? notes.map(cardHtml).join("") : emptyState(emptyMessage);

  const pinned = state.notes
    .filter((note) => note.status === "inbox" && note.pinned)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  $("#pinned-section").classList.toggle("hidden", !pinned.length || currentFilter !== "all");
  $("#pinned-count").textContent = pinned.length;
  $("#pinned-list").innerHTML = pinned
    .slice(0, 4)
    .map((note) => `
      <button class="pinned-mini-card" data-open-note="${note.id}">
        <span><svg><use href="#i-pin"></use></svg>${T.pinned}</span>
        ${escapeHtml(note.text.slice(0, 72))}
      </button>
    `)
    .join("");

  $("#link-view-toolbar").classList.toggle("hidden", currentFilter !== "links");
  bindDynamic(list);
  bindDynamic($("#pinned-list"));

  if (state.settings.sort === "bottom" && currentTab === "main") {
    requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
    });
  }
}

function renderRevisit() {
  const list = $("#revisit-list");
  const notes = state.notes
    .filter((note) => note.status === "inbox" && note.revisitAt)
    .sort((a, b) => new Date(a.revisitAt) - new Date(b.revisitAt));

  if (!notes.length) {
    list.innerHTML = emptyState(T.emptyRevisit);
    return;
  }

  const now = Date.now();
  const due = notes.filter((note) => new Date(note.revisitAt).getTime() <= now);
  const upcoming = notes.filter((note) => new Date(note.revisitAt).getTime() > now);

  const sections = [];
  if (due.length) {
    sections.push(`<div class="section-title">${T.revisitDue}<span>${due.length}</span></div>${due.map(cardHtml).join("")}`);
  }
  if (upcoming.length) {
    sections.push(`<div class="section-title">${T.revisitUpcoming}<span>${upcoming.length}</span></div>${upcoming.map(cardHtml).join("")}`);
  }

  list.innerHTML = sections.join("");
  bindDynamic(list);
}

function archiveEmptyMessage() {
  if (archiveStatus === "completed") return T.emptyCompleted;
  if (archiveStatus === "trashed") return T.emptyTrash;
  return T.emptyArchive;
}

function renderArchive() {
  const notes = sorted(state.notes.filter((note) => note.status === archiveStatus));
  const list = $("#archive-list");
  list.innerHTML = notes.length ? notes.map(cardHtml).join("") : emptyState(archiveEmptyMessage());

  $("#count-archived").textContent = state.notes.filter((note) => note.status === "archived").length;
  $("#count-completed").textContent = state.notes.filter((note) => note.status === "completed").length;
  $("#count-trashed").textContent = state.notes.filter((note) => note.status === "trashed").length;
  $("#archive-caption").textContent = archiveStatus === "archived"
    ? T.archiveCaption
    : archiveStatus === "completed"
      ? T.completedCaption
      : T.trashCaption;

  bindDynamic(list);
}

function renderRevisitBadge() {
  const count = state.notes.filter((note) => (
    note.status === "inbox"
    && note.revisitAt
    && new Date(note.revisitAt) <= new Date()
  )).length;

  const badge = $("#revisit-badge");
  badge.textContent = count;
  badge.classList.toggle("hidden", !count);
}

function renderAll() {
  renderMain();
  renderRevisit();
  renderArchive();
  renderRevisitBadge();
}

function bindDynamic(root = document) {
  $$('[data-open-note]', root).forEach((element) => {
    element.onclick = (event) => {
      if (Date.now() < suppressClickUntil) {
        event.preventDefault();
        return;
      }
      openDetail(element.dataset.openNote);
    };
  });

  $$('[data-check-index]', root).forEach((element) => {
    element.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const wrapper = element.closest("[data-note-id]");
      if (!wrapper) return;
      toggleChecklistItem(wrapper.dataset.noteId, Number(element.dataset.checkIndex));
    };
  });
}

function setMode(mode) {
  if (!["memo", "todo"].includes(mode)) return;
  currentMode = mode;
  $$("#mode-segment button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  updateComposeUi();
  renderMain();
}

function setMainFilter(filter) {
  currentFilter = filter;
  $$("#smart-filters button").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === filter);
  });
  renderMain();
}

function setTab(tab) {
  if (!["main", "revisit", "archive"].includes(tab)) return;
  currentTab = tab;
  ["main", "revisit", "archive"].forEach((name) => {
    const screen = $(`#tab-${name}`);
    screen.hidden = name !== tab;
  });
  renderAll();
}

function openOverlay(selector) {
  const screen = $(selector);
  if (!screen || screen.classList.contains("show")) return;
  screen.classList.add("show");
  history.pushState({ overlay: selector }, "", `#${selector.replace("#screen-", "")}`);
}

function closeOverlay(selector, fromPopState = false) {
  const screen = $(selector);
  if (!screen) return;
  screen.classList.remove("show");
  if (!fromPopState && location.hash) {
    history.back();
  }
}

function openDetail(noteId) {
  detailId = noteId;
  const note = activeNote();
  if (!note) return;
  refreshDetail();
  openOverlay("#screen-detail");
}

function refreshDetail() {
  const note = activeNote();
  if (!note) return;

  $("#detail-content").innerHTML = noteContentHtml(note);
  $("#detail-meta").innerHTML = `
    ${T.created} ${formatDate(note.createdAt)}<br>
    ${T.edited} ${formatDate(note.updatedAt)}
    ${note.revisitAt ? `<br>${T.revisit} ${formatDate(note.revisitAt)}` : ""}
  `;
  $("#btn-detail-pin").classList.toggle("on", note.pinned);
  renderDetailActions(note);
  bindDynamic($("#screen-detail"));
}

function actionDefinitions(note) {
  if (note.status === "trashed") {
    return [
      ["restore", "i-restore", T.restore, ""],
      ["deleteForever", "i-trash", T.deleteForever, "danger"]
    ];
  }

  const actions = [
    ["edit", "i-edit", T.edit, ""],
    ["copy", "i-copy", T.copy, ""],
    ["share", "i-share", T.share, ""],
    ["pin", "i-pin", note.pinned ? T.unpin : T.pinned, note.pinned ? "on" : ""],
    ["revisit", "i-clock", T.revisit, note.revisitAt ? "on" : ""]
  ];

  if (note.status === "inbox") {
    actions.push(
      ["complete", "i-check", T.complete, ""],
      ["archive", "i-archive", T.archive, ""],
      ["trash", "i-trash", T.delete, "danger"]
    );
  } else {
    actions.push(
      ["restore", "i-restore", T.restoreToMemo, ""],
      ["trash", "i-trash", T.delete, "danger"]
    );
  }

  return actions;
}

function renderDetailActions(note) {
  const grid = $("#detail-action-grid");
  grid.innerHTML = actionDefinitions(note)
    .map(([action, icon, label, className]) => `
      <button class="detail-action ${className}" data-action="${action}">
        <i><svg><use href="#${icon}"></use></svg></i>
        <span>${label}</span>
      </button>
    `)
    .join("");

  $$('[data-action]', grid).forEach((button) => {
    button.onclick = () => performAction(button.dataset.action);
  });
}

function startEdit() {
  const note = activeNote();
  if (!note) return;
  $("#detail-content").classList.add("hidden");
  $("#detail-meta").classList.add("hidden");
  $("#detail-editor").classList.remove("hidden");
  $("#detail-editor").value = note.text;
  $("#detail-action-grid").classList.add("hidden");
  $("#detail-edit-actions").classList.remove("hidden");
  $("#detail-editor").focus();
}

function finishEdit(saveChanges) {
  const note = activeNote();
  if (saveChanges && note) {
    const value = $("#detail-editor").value.trim();
    if (value) {
      note.text = value;
      if (note.type === "checklist") {
        const previousItems = checklistItems(note);
        note.items = value
          .split("\n")
          .map((text) => text.trim())
          .filter(Boolean)
          .map((text, index) => ({ text, done: previousItems[index]?.done || false }));
      } else {
        note.type = hasDetectedUrl(value) ? "link" : "text";
      }
      note.updatedAt = new Date().toISOString();
      saveState();
    }
  }

  $("#detail-content").classList.remove("hidden");
  $("#detail-meta").classList.remove("hidden");
  $("#detail-editor").classList.add("hidden");
  $("#detail-action-grid").classList.remove("hidden");
  $("#detail-edit-actions").classList.add("hidden");
  renderAll();
  refreshDetail();
}

function toggleChecklistItem(noteId, index) {
  const note = state.notes.find((item) => item.id === noteId);
  if (!note || note.type !== "checklist") return;
  note.items = checklistItems(note);
  if (!note.items[index]) return;
  note.items[index].done = !note.items[index].done;
  note.updatedAt = new Date().toISOString();
  saveState();
  renderAll();
  if (detailId === noteId && $("#screen-detail").classList.contains("show")) {
    refreshDetail();
  }
}

async function performAction(action) {
  const note = activeNote();
  if (!note) return;

  if (action === "edit") {
    if (!$("#screen-detail").classList.contains("show")) {
      refreshDetail();
      openOverlay("#screen-detail");
    }
    startEdit();
    return;
  }

  if (action === "copy") {
    await navigator.clipboard?.writeText(note.text);
    toast(T.copied);
    return;
  }

  if (action === "share") {
    if (navigator.share) {
      await navigator.share({ text: note.text }).catch(() => undefined);
    } else {
      await navigator.clipboard?.writeText(note.text);
      toast(T.shareCopied);
    }
    return;
  }

  if (action === "revisit") {
    openRevisitSheet("existing", note.id);
    return;
  }

  if (action === "pin") {
    note.pinned = !note.pinned;
  } else if (action === "complete") {
    note.status = "completed";
    note.completedAt = new Date().toISOString();
    note.pinned = false;
    note.revisitAt = null;
  } else if (action === "archive") {
    note.status = "archived";
    note.pinned = false;
    note.revisitAt = null;
  } else if (action === "restore") {
    note.status = "inbox";
    note.trashedAt = null;
  } else if (action === "trash") {
    askConfirm(T.deleteTitle, T.deleteDescription, T.delete, () => {
      note.status = "trashed";
      note.pinned = false;
      note.revisitAt = null;
      note.trashedAt = new Date().toISOString();
      note.updatedAt = note.trashedAt;
      saveState();
      renderAll();
      if ($("#screen-detail").classList.contains("show")) {
        closeOverlay("#screen-detail");
      }
    });
    return;
  } else if (action === "deleteForever") {
    askConfirm(T.deleteForeverTitle, T.deleteForeverDescription, T.deleteForever, () => {
      state.notes = state.notes.filter((item) => item.id !== note.id);
      saveState();
      renderAll();
      if ($("#screen-detail").classList.contains("show")) {
        closeOverlay("#screen-detail");
      }
    });
    return;
  }

  note.updatedAt = new Date().toISOString();
  saveState();
  renderAll();
  if ($("#screen-detail").classList.contains("show")) {
    refreshDetail();
  }
}

function sendNote() {
  const input = $("#compose-input");
  const text = input.value.trim();
  if (!text) return;

  const now = new Date().toISOString();
  const type = noteTypeForText(text);
  const note = {
    id: makeId(),
    text,
    type,
    status: "inbox",
    pinned: false,
    revisitAt: pendingRevisit,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    completedAt: null
  };

  if (type === "checklist") {
    note.items = text
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => ({ text: item, done: false }));
  }

  state.notes.push(note);
  saveState();

  input.value = "";
  input.style.height = "auto";
  composeMode = "text";
  pendingRevisit = null;
  $("#compose-tools").classList.remove("open");
  $("#btn-compose-tools").classList.remove("open");
  updateComposeUi();
  renderAll();
  toast(T.saved);
}

function updateComposeUi() {
  const input = $("#compose-input");
  const todoMode = composeMode === "checklist" || currentMode === "todo";
  const hasText = Boolean(input.value.trim());

  $("#btn-send").disabled = !hasText;
  $("#compose-mode-chip").classList.toggle("hidden", !todoMode);
  $("#btn-tool-todo").classList.toggle("active", composeMode === "checklist");
  $("#compose-revisit-chip").classList.toggle("hidden", !pendingRevisit);
  $("#compose-revisit-label").textContent = pendingRevisit ? formatDate(pendingRevisit) : "";
  input.placeholder = todoMode ? T.todoPlaceholder : T.memoPlaceholder;
}

function openActionSheet(noteId) {
  detailId = noteId;
  const note = activeNote();
  if (!note) return;

  $("#action-preview").textContent = note.text.slice(0, 80);
  $("#action-list").innerHTML = actionDefinitions(note)
    .map(([action, icon, label, className]) => `
      <button class="sheet-action ${className}" data-sheet-action="${action}">
        <svg><use href="#${icon}"></use></svg>
        <span>${label}</span>
      </button>
    `)
    .join("");

  $$('[data-sheet-action]').forEach((button) => {
    button.onclick = () => {
      hideSheet("#sheet-actions");
      performAction(button.dataset.sheetAction);
    };
  });

  showSheet("#sheet-actions");
}

function showSheet(selector) {
  const sheet = $(selector);
  sheet.classList.add("show");
  sheet.setAttribute("aria-hidden", "false");
}

function hideSheet(selector) {
  const sheet = $(selector);
  sheet.classList.remove("show");
  sheet.setAttribute("aria-hidden", "true");
}

function openRevisitSheet(mode, noteId = null) {
  revisitContext = { mode, noteId };
  selectedRevisit = null;
  $("#revisit-custom-input").value = "";
  $$("#revisit-quick button").forEach((button) => button.classList.remove("active"));
  $("#btn-revisit-confirm").disabled = true;
  showSheet("#sheet-revisit");
}

function selectRevisitDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(9, 0, 0, 0);
  selectedRevisit = date.toISOString();
  $("#btn-revisit-confirm").disabled = false;
}

function confirmRevisit() {
  const customValue = $("#revisit-custom-input").value;
  if (customValue) {
    selectedRevisit = new Date(customValue).toISOString();
  }
  if (!selectedRevisit) {
    toast(T.chooseDate);
    return;
  }

  if (revisitContext.mode === "compose") {
    pendingRevisit = selectedRevisit;
  } else {
    const note = state.notes.find((item) => item.id === revisitContext.noteId);
    if (note) {
      note.revisitAt = selectedRevisit;
      note.updatedAt = new Date().toISOString();
      saveState();
      renderAll();
      if ($("#screen-detail").classList.contains("show")) {
        refreshDetail();
      }
    }
  }

  hideSheet("#sheet-revisit");
  updateComposeUi();
  toast(T.revisitSet);
}

function renderSearch() {
  const query = $("#search-input").value.trim().toLowerCase();
  const type = $("#search-type-filters .active")?.dataset.type || "all";
  const range = $("#search-date-filters .active")?.dataset.range || "all";
  let notes = state.notes.filter((note) => note.status !== "trashed");

  if (query) {
    notes = notes.filter((note) => note.text.toLowerCase().includes(query));
  }
  if (type !== "all") {
    notes = notes.filter((note) => note.type === type);
  }

  const now = new Date();
  if (range !== "all") {
    notes = notes.filter((note) => {
      const date = new Date(note.createdAt);
      if (range === "today") return date.toDateString() === now.toDateString();
      if (range === "7d") return date >= new Date(now.getTime() - 7 * DAY);
      if (range === "month") return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
      return true;
    });
  }

  const results = $("#search-results");
  results.innerHTML = notes.length
    ? sorted(notes).map(cardHtml).join("")
    : emptyState(query ? T.searchEmpty : T.searchPrompt);
  bindDynamic(results);
}

function renderPinnedAll() {
  const notes = state.notes
    .filter((note) => note.status === "inbox" && note.pinned)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const list = $("#pinned-all-list");
  list.innerHTML = notes.length ? notes.map(cardHtml).join("") : emptyState(T.emptyPinned);
  bindDynamic(list);
}

function backupData() {
  const data = {
    app: T.appName,
    version: 2,
    exportedAt: new Date().toISOString(),
    notes: state.notes,
    settings: state.settings
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `${T.backupPrefix}_${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  toast(T.backupCreated);
}

async function restoreData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.notes)) throw new Error("Invalid backup");
    askConfirm(T.restoreTitle, T.restoreDescription, T.restore, () => {
      state = normalizeState(data);
      currentMode = state.settings.defaultMode;
      saveState();
      applySettings();
      setMode(currentMode);
      renderAll();
      closeOverlay("#screen-settings");
      toast(T.restored);
    });
  } catch {
    toast(T.invalidBackup);
  }
}

function cleanupTrash() {
  const cutoff = Date.now() - 30 * DAY;
  const before = state.notes.length;
  state.notes = state.notes.filter((note) => !(
    note.status === "trashed"
    && new Date(note.trashedAt || note.updatedAt).getTime() < cutoff
  ));
  if (before !== state.notes.length) {
    saveState();
  }
}

function askConfirm(title, description, confirmText, action) {
  $("#confirm-title").textContent = title;
  $("#confirm-description").textContent = description;
  $("#btn-confirm-ok").textContent = confirmText;
  confirmAction = action;
  $("#modal-confirm").classList.add("show");
  $("#modal-confirm").setAttribute("aria-hidden", "false");
}

function closeConfirm() {
  $("#modal-confirm").classList.remove("show");
  $("#modal-confirm").setAttribute("aria-hidden", "true");
  confirmAction = null;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 1700);
}

function bindSegment(selector, settingKey, transform = (value) => value) {
  $$(`${selector} button`).forEach((button) => {
    button.onclick = () => {
      state.settings[settingKey] = transform(button.dataset.value);
      saveState();
      applySettings();
      renderAll();
    };
  });
}

function initializeEvents() {
  $$("[data-tab]").forEach((button) => {
    button.onclick = () => setTab(button.dataset.tab);
  });

  $$("#mode-segment button").forEach((button) => {
    button.onclick = () => setMode(button.dataset.mode);
  });

  $$("#smart-filters button").forEach((button) => {
    button.onclick = () => setMainFilter(button.dataset.filter);
  });

  $$("#link-view-segment button").forEach((button) => {
    button.onclick = () => {
      state.settings.linkView = button.dataset.view;
      saveState();
      applySettings();
      renderMain();
    };
  });

  $("#btn-onboarding-start").onclick = () => {
    state.settings.onboarded = true;
    saveState();
    $("#onboarding").classList.remove("show");
    $("#onboarding").setAttribute("aria-hidden", "true");
  };

  $("#compose-input").oninput = (event) => {
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(event.target.scrollHeight, 126)}px`;
    updateComposeUi();
  };

  $("#compose-input").onkeydown = (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      sendNote();
    }
  };

  $("#btn-send").onclick = sendNote;
  $("#btn-compose-tools").onclick = () => {
    $("#compose-tools").classList.toggle("open");
    $("#btn-compose-tools").classList.toggle("open");
  };
  $("#btn-tool-todo").onclick = () => {
    composeMode = composeMode === "checklist" ? "text" : "checklist";
    updateComposeUi();
  };
  $("#btn-tool-revisit").onclick = () => openRevisitSheet("compose");
  $("#btn-compose-mode-clear").onclick = () => {
    composeMode = "text";
    updateComposeUi();
  };
  $("#btn-compose-revisit-clear").onclick = () => {
    pendingRevisit = null;
    updateComposeUi();
  };

  $("#btn-settings-open").onclick = () => openOverlay("#screen-settings");
  $("#btn-settings-back").onclick = () => closeOverlay("#screen-settings");
  $("#btn-search-open").onclick = () => {
    openOverlay("#screen-search");
    renderSearch();
    setTimeout(() => $("#search-input").focus(), 230);
  };
  $("#btn-search-back").onclick = () => closeOverlay("#screen-search");
  $("#btn-detail-back").onclick = () => closeOverlay("#screen-detail");
  $("#btn-pinned-open").onclick = () => {
    renderPinnedAll();
    openOverlay("#screen-pinned");
  };
  $("#btn-pinned-back").onclick = () => closeOverlay("#screen-pinned");

  $("#btn-detail-pin").onclick = () => performAction("pin");
  $("#btn-detail-more").onclick = () => openActionSheet(detailId);
  $("#btn-detail-edit-cancel").onclick = () => finishEdit(false);
  $("#btn-detail-edit-save").onclick = () => finishEdit(true);

  $("#search-input").oninput = renderSearch;
  $$("#search-type-filters button, #search-date-filters button").forEach((button) => {
    button.onclick = () => {
      $$(`button`, button.parentElement).forEach((item) => item.classList.toggle("active", item === button));
      renderSearch();
    };
  });

  $$("#archive-segment button").forEach((button) => {
    button.onclick = () => {
      archiveStatus = button.dataset.status;
      $$("#archive-segment button").forEach((item) => item.classList.toggle("active", item === button));
      renderArchive();
    };
  });

  $$("#theme-grid [data-theme]").forEach((button) => {
    button.onclick = () => {
      state.settings.theme = button.dataset.theme;
      saveState();
      applySettings();
    };
  });

  $("#custom-theme-color").oninput = (event) => {
    state.settings.customThemeColor = event.target.value;
    state.settings.theme = "custom";
    saveState();
    applySettings();
  };

  $("#font-size-range").oninput = (event) => {
    state.settings.fontSize = Number(event.target.value);
    saveState();
    applySettings();
  };

  $("#url-detect-toggle").onchange = (event) => {
    state.settings.urlDetect = event.target.checked;
    saveState();
    renderAll();
  };

  bindSegment("#font-weight-segment", "fontWeight", Number);
  bindSegment("#density-segment", "density");
  bindSegment("#card-shape-segment", "cardShape");
  bindSegment("#default-mode-segment", "defaultMode");
  bindSegment("#sort-segment", "sort");

  $("#btn-backup").onclick = backupData;
  $("#btn-restore").onclick = () => $("#restore-file-input").click();
  $("#restore-file-input").onchange = (event) => {
    if (event.target.files[0]) {
      restoreData(event.target.files[0]);
    }
    event.target.value = "";
  };
  $("#btn-delete-all").onclick = () => {
    askConfirm(T.deleteAllTitle, T.deleteAllDescription, T.deleteForever, () => {
      state = clone(DEFAULT_STATE);
      currentMode = state.settings.defaultMode;
      currentFilter = "all";
      archiveStatus = "archived";
      saveState();
      applySettings();
      setMode(currentMode);
      renderAll();
      closeOverlay("#screen-settings");
      toast(T.deletedAll);
    });
  };

  $$("#revisit-quick button").forEach((button) => {
    button.onclick = () => {
      $$("#revisit-quick button").forEach((item) => item.classList.toggle("active", item === button));
      $("#revisit-custom-input").value = "";
      selectRevisitDays(Number(button.dataset.days));
    };
  });

  $("#revisit-custom-input").onchange = (event) => {
    selectedRevisit = event.target.value ? new Date(event.target.value).toISOString() : null;
    $$("#revisit-quick button").forEach((button) => button.classList.remove("active"));
    $("#btn-revisit-confirm").disabled = !selectedRevisit;
  };
  $("#btn-revisit-confirm").onclick = confirmRevisit;

  $$(".sheet-overlay").forEach((overlay) => {
    overlay.onclick = (event) => {
      if (event.target === overlay) {
        hideSheet(`#${overlay.id}`);
      }
    };
  });

  $("#btn-confirm-cancel").onclick = closeConfirm;
  $("#btn-confirm-ok").onclick = () => {
    const action = confirmAction;
    closeConfirm();
    action?.();
  };
  $("#modal-confirm").onclick = (event) => {
    if (event.target.id === "modal-confirm") closeConfirm();
  };

  window.addEventListener("popstate", () => {
    $$(".overlay-screen.show").forEach((screen) => screen.classList.remove("show"));
  });

  document.addEventListener("contextmenu", (event) => {
    if (event.target.closest("[data-open-note], .note-card, .pinned-mini-card, .sheet")) {
      event.preventDefault();
    }
  });

  document.addEventListener("selectstart", (event) => {
    if (event.target.closest("[data-open-note], .note-card, .pinned-mini-card, .sheet")) {
      event.preventDefault();
    }
  });

  document.addEventListener("pointerdown", (event) => {
    const card = event.target.closest("[data-open-note]");
    if (!card) return;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      suppressClickUntil = Date.now() + 500;
      openActionSheet(card.dataset.openNote);
    }, 550);
  });

  ["pointerup", "pointermove", "pointercancel"].forEach((name) => {
    document.addEventListener(name, () => clearTimeout(pressTimer));
  });
}

function initialize() {
  cleanupTrash();
  currentMode = state.settings.defaultMode;
  applySettings();
  setMode(currentMode);
  updateComposeUi();
  renderAll();
  initializeEvents();

  if (!state.settings.onboarded) {
    $("#onboarding").classList.add("show");
    $("#onboarding").setAttribute("aria-hidden", "false");
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(console.error);
    });
  }
}

document.addEventListener("DOMContentLoaded", initialize);
