const MENU_ROOT_ID = 'save-image-as-root';
const MENU_ITEMS = [
  { id: 'save-image-original', title: 'Original format', format: 'original' },
  { id: 'save-image-png', title: 'PNG', format: 'png' },
  { id: 'save-image-jpeg', title: 'JPG', format: 'jpeg' },
  { id: 'save-image-webp', title: 'WebP', format: 'webp' },
];
const MENU_FORMAT_BY_ID = Object.fromEntries(MENU_ITEMS.map((item) => [item.id, item.format]));
const ALLOWED_PAGE_PATTERNS = ['http://*/*', 'https://*/*', 'file:///*'];
const OFFSCREEN_PATH = 'offscreen.html';
const DEFAULT_SETTINGS = {
  jpegQuality: 92,
  webpQuality: 90,
  jpegBackgroundColor: '#ffffff',
  saveAs: true,
};
const MIME_BY_EXTENSION = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  jfif: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

let creatingOffscreenDocument = null;

chrome.runtime.onInstalled.addListener(async () => {
  await initializeExtension();
});

chrome.runtime.onStartup.addListener(async () => {
  await initializeExtension();
});

chrome.action.onClicked.addListener(async () => {
  await chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const format = MENU_FORMAT_BY_ID[info.menuItemId];
  if (!format || !tab?.id) {
    return;
  }

  try {
    const target = await resolveTargetFromClick(info, tab);
    const settings = await getSettings();
    await ensureOffscreenDocument();

    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'SAVE_IMAGE_AS_CONVERT',
      requestedFormat: format,
      source: target,
      settings,
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'The conversion failed.');
    }

    if (!response.dataUrl) {
      throw new Error('The conversion finished, but no file data was returned.');
    }

    await chrome.downloads.download({
      url: response.dataUrl,
      filename: response.filename,
      saveAs: Boolean(settings.saveAs),
    });
  } catch (error) {
    const message = normalizeErrorMessage(error);
    console.error('[Save Image As]', error);
    await showToast(tab.id, info.frameId, message);
  }
});

async function initializeExtension() {
  await ensureDefaultSettings();
  await recreateContextMenus();
}

async function ensureDefaultSettings() {
  const current = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const updates = {};

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (current[key] === undefined) {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

async function recreateContextMenus() {
  await removeAllContextMenus();

  chrome.contextMenus.create({
    id: MENU_ROOT_ID,
    title: 'Save image as…',
    contexts: ['image', 'page'],
    documentUrlPatterns: ALLOWED_PAGE_PATTERNS,
  });

  for (const item of MENU_ITEMS) {
    chrome.contextMenus.create({
      id: item.id,
      parentId: MENU_ROOT_ID,
      title: item.title,
      contexts: ['image', 'page'],
      documentUrlPatterns: ALLOWED_PAGE_PATTERNS,
    });
  }
}

function removeAllContextMenus() {
  return new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => resolve());
  });
}

async function getSettings() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    jpegQuality: clampNumber(settings.jpegQuality, 1, 100, DEFAULT_SETTINGS.jpegQuality),
    webpQuality: clampNumber(settings.webpQuality, 1, 100, DEFAULT_SETTINGS.webpQuality),
    jpegBackgroundColor: normalizeColor(settings.jpegBackgroundColor, DEFAULT_SETTINGS.jpegBackgroundColor),
    saveAs: Boolean(settings.saveAs),
  };
}

async function resolveTargetFromClick(info, tab) {
  const prepared = await tryReadPreparedTarget(tab.id, info.frameId);
  if (prepared?.ok) {
    return prepared;
  }

  if (info.srcUrl) {
    return buildFallbackTarget(info.srcUrl, info.pageUrl || tab.url || '');
  }

  if ((info.pageUrl || '').startsWith('file:')) {
    throw new Error("Couldn't read the file page. In chrome://extensions, enable 'Allow access to file URLs' for this extension and try again.");
  }

  throw new Error('Right-click directly on an image, canvas, inline SVG, or an element with a CSS background image, then try again.');
}

async function tryReadPreparedTarget(tabId, frameId) {
  try {
    if (typeof frameId === 'number') {
      return await chrome.tabs.sendMessage(tabId, { type: 'SAVE_IMAGE_AS_PREPARE_TARGET' }, { frameId });
    }
    return await chrome.tabs.sendMessage(tabId, { type: 'SAVE_IMAGE_AS_PREPARE_TARGET' });
  } catch (error) {
    return null;
  }
}

function buildFallbackTarget(srcUrl, pageUrl) {
  const absoluteUrl = normalizeUrl(srcUrl, pageUrl);
  const sourceMime = mimeFromUrl(absoluteUrl);
  const originalExtension = extensionFromUrl(absoluteUrl) || extensionFromMime(sourceMime) || '';
  const filenameBase = sanitizeFilenameBase(filenameBaseFromUrl(absoluteUrl) || 'image');

  return {
    ok: true,
    sourceKind: 'url',
    sourceUrl: absoluteUrl,
    sourceMime,
    originalExtension,
    filenameBase,
  };
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = 'getContexts' in chrome.runtime
    ? await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [offscreenUrl],
      })
    : [];

  if (contexts.length > 0) {
    return;
  }

  if (!('getContexts' in chrome.runtime)) {
    const matchedClients = await clients.matchAll();
    const alreadyExists = matchedClients.some((client) => client.url === offscreenUrl);
    if (alreadyExists) {
      return;
    }
  }

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['BLOBS', 'DOM_PARSER'],
    justification: 'Convert image data in a hidden extension page and package the result for download.',
  });

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}


async function showToast(tabId, frameId, text) {
  if (!tabId) {
    return;
  }

  const payload = {
    type: 'SAVE_IMAGE_AS_TOAST',
    level: 'error',
    text,
  };

  try {
    if (typeof frameId === 'number') {
      await chrome.tabs.sendMessage(tabId, payload, { frameId });
      return;
    }
    await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    // Ignore. Restricted pages don't allow content scripts.
  }
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function normalizeColor(value, fallback) {
  return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim())
    ? value.trim()
    : fallback;
}

function normalizeUrl(url, baseUrl) {
  if (!url) {
    return '';
  }

  if (/^(data:|blob:|file:|https?:)/i.test(url)) {
    return url;
  }

  try {
    return new URL(url, baseUrl || undefined).href;
  } catch {
    return url;
  }
}

function filenameBaseFromUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname || '');
    const name = pathname.split('/').pop() || '';
    const withoutExtension = name.replace(/\.[^.]+$/, '');
    return withoutExtension || '';
  } catch {
    return '';
  }
}

function extensionFromUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname || '');
    const filename = pathname.split('/').pop() || '';
    const match = filename.match(/\.([a-zA-Z0-9]+)$/);
    return match ? match[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

function mimeFromUrl(url) {
  return MIME_BY_EXTENSION[extensionFromUrl(url)] || '';
}

function extensionFromMime(mimeType) {
  const normalized = (mimeType || '').toLowerCase();
  return Object.entries(MIME_BY_EXTENSION).find(([, value]) => value === normalized)?.[0] || '';
}

function sanitizeFilenameBase(value) {
  const cleaned = (value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/g, '')
    .slice(0, 120);
  return cleaned || 'image';
}

function normalizeErrorMessage(error) {
  if (!error) {
    return 'Something went wrong.';
  }
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  return 'Something went wrong.';
}
