const INDEX_KEY = "syncNotebook:index";
const NOTE_PREFIX = "syncNotebook:note:";
const CHUNK_SIZE = 2500;
const MENU_ID = "add-selection-to-fstntpd";
const MAX_TITLE_LENGTH = 64;

chrome.runtime.onInstalled.addListener(createContextMenu);
chrome.runtime.onStartup.addListener(createContextMenu);

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText) {
    return;
  }

  saveSelectionAsNote(info.selectionText)
    .then(() => showBadge("+"))
    .catch((error) => {
      console.error(error);
      showBadge("!");
    });
});

function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Add to FstNtpd",
      contexts: ["selection"],
    });
  });
}

async function saveSelectionAsNote(selectionText) {
  const content = selectionText.trim();
  if (!content) {
    return;
  }

  const note = buildNote(content);
  const index = normalizeIndex((await storageGet(INDEX_KEY))[INDEX_KEY]);
  index.order.unshift(note.id);
  index.activeId = note.id;
  index.notes[note.id] = buildIndexNote(note);

  await saveNote(note);
  await storageSet({ [INDEX_KEY]: index });
}

function buildNote(content) {
  const now = Date.now();
  return {
    id: `note-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: deriveTitle(content),
    content,
    createdAt: now,
    updatedAt: now,
    manualTitle: false,
  };
}

function normalizeIndex(value) {
  const normalized = {
    version: 1,
    activeId: null,
    order: [],
    notes: {},
  };

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

function buildIndexNote(note) {
  return {
    id: note.id,
    title: note.title,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    manualTitle: note.manualTitle,
    preview: buildPreview(note.content),
    length: note.content.length,
    chunkCount: chunkText(note.content).length,
  };
}

async function saveNote(note) {
  const chunks = chunkText(note.content);
  const items = {
    [noteMetaKey(note.id)]: {
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

  await storageSet(items);
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

function buildPreview(content) {
  const preview = content.trim().replace(/\s+/g, " ");
  return preview ? preview.slice(0, 96) : "Empty note";
}

function storageGet(keys) {
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
}

function storageSet(items) {
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
}

function showBadge(text) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: text === "+" ? "#2e7d32" : "#b42318" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1500);
}
