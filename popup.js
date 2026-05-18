const INDEX_KEY = "syncNotebook:index";
const NOTE_PREFIX = "syncNotebook:note:";
const CHUNK_SIZE = 2500;
const SAVE_DELAY_MS = 350;
const MAX_TITLE_LENGTH = 64;

const hasChromeStorage =
  typeof chrome !== "undefined" &&
  chrome.storage &&
  chrome.storage.sync;

const storage = createStorageAdapter();

const elements = {};
let index = createEmptyIndex();
let noteCache = new Map();
let activeId = null;
let saveTimer = null;
let saving = false;
let ignoreRemoteChangesUntil = 0;

window.addEventListener("DOMContentLoaded", init);

async function init() {
  bindElements();
  bindEvents();
  elements.syncMode.textContent = hasChromeStorage ? "Chrome Sync" : "Local preview";

  if (hasChromeStorage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync" || Date.now() < ignoreRemoteChangesUntil) {
        return;
      }
      const changedKeys = Object.keys(changes);
      if (changedKeys.some((key) => key === INDEX_KEY || key.startsWith(NOTE_PREFIX))) {
        reloadFromStorage("Synced from Chrome");
      }
    });
  }

  await reloadFromStorage("Ready");
}

function bindElements() {
  elements.addNote = document.getElementById("addNote");
  elements.searchInput = document.getElementById("searchInput");
  elements.syncNow = document.getElementById("syncNow");
  elements.syncMode = document.getElementById("syncMode");
  elements.statusText = document.getElementById("statusText");
  elements.notesList = document.getElementById("notesList");
  elements.titleInput = document.getElementById("titleInput");
  elements.noteEditor = document.getElementById("noteEditor");
}

function bindEvents() {
  elements.addNote.addEventListener("click", createNote);
  elements.syncNow.addEventListener("click", async () => {
    await flushSave();
    await reloadFromStorage("Synced manually");
  });
  elements.searchInput.addEventListener("input", renderList);

  elements.titleInput.addEventListener("input", () => {
    const note = getActiveNote();
    if (!note) {
      return;
    }
    const value = elements.titleInput.value.trim();
    note.manualTitle = Boolean(value);
    note.title = value || deriveTitle(note.content);
    note.updatedAt = Date.now();
    touchIndexNote(note);
    renderList();
    queueSave("Saving...");
  });

  elements.noteEditor.addEventListener("input", () => {
    const note = getActiveNote();
    if (!note) {
      return;
    }
    const previousDerivedTitle = deriveTitle(note.content);
    note.content = elements.noteEditor.value;
    note.updatedAt = Date.now();
    if (!note.manualTitle || !note.title || note.title === previousDerivedTitle) {
      note.manualTitle = false;
      note.title = deriveTitle(note.content);
      elements.titleInput.value = note.title;
    }
    touchIndexNote(note);
    renderList();
    queueSave("Saving...");
  });
}

async function reloadFromStorage(successMessage) {
  setStatus("Loading...");
  clearTimeout(saveTimer);
  saveTimer = null;

  try {
    index = normalizeIndex((await storage.get(INDEX_KEY))[INDEX_KEY]);
    noteCache = await loadNotes(index);

    if (!index.order.length) {
      const firstNote = buildNote({ content: "" });
      index.order.push(firstNote.id);
      index.activeId = firstNote.id;
      noteCache.set(firstNote.id, firstNote);
      await persistNotebook(firstNote.id);
    }

    activeId = index.activeId && noteCache.has(index.activeId)
      ? index.activeId
      : index.order[0];
    index.activeId = activeId;
    showActiveNote();
    renderList();
    setStatus(successMessage || "Ready");
  } catch (error) {
    setStatus(error.message || "Failed to load", true);
  }
}

async function loadNotes(currentIndex) {
  const notes = new Map();
  const loaded = await Promise.all(currentIndex.order.map((id) => loadNote(id, currentIndex.notes[id])));
  for (const note of loaded) {
    if (note) {
      notes.set(note.id, note);
    }
  }
  currentIndex.order = currentIndex.order.filter((id) => notes.has(id));
  for (const id of currentIndex.order) {
    touchIndexNote(notes.get(id));
  }
  return notes;
}

async function loadNote(id, indexNote) {
  const metaKey = noteMetaKey(id);
  const storedMeta = (await storage.get(metaKey))[metaKey];
  const meta = storedMeta || indexNote;

  if (!meta) {
    return null;
  }

  const chunkCount = Number(meta.chunkCount || 0);
  const chunkKeys = Array.from({ length: chunkCount }, (_, chunkIndex) => noteChunkKey(id, chunkIndex));
  const chunks = chunkKeys.length ? await storage.get(chunkKeys) : {};
  const content = chunkKeys.map((key) => chunks[key] || "").join("");

  return buildNote({
    id,
    title: meta.title,
    content,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    manualTitle: Boolean(meta.manualTitle),
  });
}

function createEmptyIndex() {
  return {
    version: 1,
    activeId: null,
    order: [],
    notes: {},
  };
}

function normalizeIndex(value) {
  const normalized = createEmptyIndex();
  if (!value || typeof value !== "object") {
    return normalized;
  }

  const notes = value.notes && typeof value.notes === "object" ? value.notes : {};
  const order = Array.isArray(value.order) ? value.order.filter((id) => typeof id === "string") : [];
  normalized.order = [...new Set(order.filter((id) => notes[id]))];
  normalized.notes = notes;
  normalized.activeId = typeof value.activeId === "string" ? value.activeId : normalized.order[0] || null;
  return normalized;
}

function buildNote(input) {
  const now = Date.now();
  const content = typeof input.content === "string" ? input.content : "";
  const title = cleanTitle(input.title) || deriveTitle(content);
  return {
    id: input.id || `note-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    content,
    createdAt: Number(input.createdAt || now),
    updatedAt: Number(input.updatedAt || now),
    manualTitle: Boolean(input.manualTitle),
  };
}

async function createNote() {
  await flushSave();
  const note = buildNote({ content: "" });
  index.order.unshift(note.id);
  activeId = note.id;
  index.activeId = note.id;
  noteCache.set(note.id, note);
  touchIndexNote(note);
  showActiveNote();
  renderList();
  await persistNotebook(note.id);
  elements.noteEditor.focus();
  setStatus("New note created");
}

async function selectNote(id) {
  if (id === activeId) {
    return;
  }
  await flushSave();
  activeId = id;
  index.activeId = id;
  showActiveNote();
  renderList();
  await saveIndexOnly();
}

function showActiveNote() {
  const note = getActiveNote();
  elements.titleInput.value = note ? note.title : "";
  elements.noteEditor.value = note ? note.content : "";
  elements.titleInput.disabled = !note;
  elements.noteEditor.disabled = !note;
}

function getActiveNote() {
  return activeId ? noteCache.get(activeId) : null;
}

function renderList() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const fragment = document.createDocumentFragment();
  const ids = index.order.filter((id) => {
    const note = noteCache.get(id);
    if (!note) {
      return false;
    }
    if (!query) {
      return true;
    }
    return `${note.title}\n${note.content}`.toLowerCase().includes(query);
  });

  elements.notesList.innerHTML = "";

  if (!ids.length) {
    const empty = document.createElement("li");
    empty.className = "emptyState";
    empty.textContent = "No matching notes";
    fragment.append(empty);
    elements.notesList.append(fragment);
    return;
  }

  for (const id of ids) {
    const note = noteCache.get(id);
    const item = document.createElement("li");
    item.className = `noteItem${id === activeId ? " active" : ""}`;
    item.title = buildTooltip(note);
    item.addEventListener("click", () => selectNote(id));

    const title = document.createElement("span");
    title.className = "noteTitle";
    title.textContent = note.title;

    const meta = document.createElement("span");
    meta.className = "noteMeta";
    meta.textContent = formatDate(note.updatedAt);

    item.append(title, meta);
    fragment.append(item);
  }

  elements.notesList.append(fragment);
}

function buildTooltip(note) {
  const preview = note.content.trim().split(/\s+/).slice(0, 18).join(" ");
  return `Last modified: ${new Date(note.updatedAt).toLocaleString()}${preview ? `\n${preview}` : ""}`;
}

function touchIndexNote(note) {
  index.notes[note.id] = {
    id: note.id,
    title: note.title,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    manualTitle: note.manualTitle,
    preview: note.content.trim().slice(0, 160),
    length: note.content.length,
    chunkCount: chunkText(note.content).length,
  };
}

function queueSave(message) {
  setStatus(message);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNotebook(activeId).catch((error) => {
      setStatus(error.message || "Failed to save", true);
    });
  }, SAVE_DELAY_MS);
}

async function flushSave() {
  if (!saveTimer) {
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = null;
  await persistNotebook(activeId);
}

async function persistNotebook(noteId) {
  const note = noteId ? noteCache.get(noteId) : null;
  saving = true;
  ignoreRemoteChangesUntil = Date.now() + 1500;
  try {
    if (note) {
      touchIndexNote(note);
      await saveNote(note);
    }
    await saveIndexOnly();
    setStatus(`Synced ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  } finally {
    saving = false;
  }
}

async function saveIndexOnly() {
  index.activeId = activeId;
  index.version = 1;
  await storage.set({ [INDEX_KEY]: index });
}

async function saveNote(note) {
  const chunks = chunkText(note.content);
  const metaKey = noteMetaKey(note.id);
  const previousMeta = (await storage.get(metaKey))[metaKey];
  const items = {
    [metaKey]: {
      id: note.id,
      title: note.title,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      manualTitle: note.manualTitle,
      chunkCount: chunks.length,
    },
  };

  chunks.forEach((chunk, index) => {
    items[noteChunkKey(note.id, index)] = chunk;
  });

  await storage.set(items);

  const previousChunkCount = Number(previousMeta && previousMeta.chunkCount ? previousMeta.chunkCount : 0);
  if (previousChunkCount > chunks.length) {
    const staleKeys = [];
    for (let chunkIndex = chunks.length; chunkIndex < previousChunkCount; chunkIndex += 1) {
      staleKeys.push(noteChunkKey(note.id, chunkIndex));
    }
    await storage.remove(staleKeys);
  }
}

function chunkText(text) {
  const chunks = [];
  for (let index = 0; index < text.length; index += CHUNK_SIZE) {
    chunks.push(text.slice(index, index + CHUNK_SIZE));
  }
  return chunks.length ? chunks : [""];
}

function noteMetaKey(id) {
  return `${NOTE_PREFIX}${id}:meta`;
}

function noteChunkKey(id, index) {
  return `${NOTE_PREFIX}${id}:chunk:${index}`;
}

function deriveTitle(content) {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return cleanTitle(firstLine) || "Untitled note";
}

function cleanTitle(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function setStatus(message, isError = false) {
  if (saving && message === "Ready") {
    return;
  }
  elements.statusText.textContent = message;
  elements.statusText.classList.toggle("dangerText", isError);
}

function createStorageAdapter() {
  if (hasChromeStorage) {
    return {
      get(keys) {
        return new Promise((resolve, reject) => {
          chrome.storage.sync.get(keys, (result) => {
            const error = chrome.runtime.lastError;
            if (error) {
              reject(new Error(error.message));
              return;
            }
            resolve(result || {});
          });
        });
      },
      set(items) {
        return new Promise((resolve, reject) => {
          chrome.storage.sync.set(items, () => {
            const error = chrome.runtime.lastError;
            if (error) {
              reject(new Error(error.message));
              return;
            }
            resolve();
          });
        });
      },
      remove(keys) {
        return new Promise((resolve, reject) => {
          chrome.storage.sync.remove(keys, () => {
            const error = chrome.runtime.lastError;
            if (error) {
              reject(new Error(error.message));
              return;
            }
            resolve();
          });
        });
      },
    };
  }

  return {
    async get(keys) {
      if (keys === null) {
        return Object.fromEntries(Object.keys(localStorage).map((key) => [key, parseLocalValue(key)]));
      }
      const requestedKeys = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requestedKeys.map((key) => [key, parseLocalValue(key)]));
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        localStorage.setItem(key, JSON.stringify(value));
      }
    },
    async remove(keys) {
      const removeKeys = Array.isArray(keys) ? keys : [keys];
      for (const key of removeKeys) {
        localStorage.removeItem(key);
      }
    },
  };
}

function parseLocalValue(key) {
  const value = localStorage.getItem(key);
  if (value === null) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return undefined;
  }
}
