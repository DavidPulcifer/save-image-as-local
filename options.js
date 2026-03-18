const DEFAULT_SETTINGS = {
  jpegQuality: 92,
  webpQuality: 90,
  jpegBackgroundColor: '#ffffff',
  saveAs: true,
};

const jpegQualityInput = document.getElementById('jpegQuality');
const webpQualityInput = document.getElementById('webpQuality');
const jpegBackgroundColorInput = document.getElementById('jpegBackgroundColor');
const saveAsInput = document.getElementById('saveAs');
const statusNode = document.getElementById('status');

const jpegQualityValue = document.getElementById('jpegQualityValue');
const webpQualityValue = document.getElementById('webpQualityValue');
const jpegBackgroundColorValue = document.getElementById('jpegBackgroundColorValue');

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function normalizeColor(value, fallback) {
  return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim())
    ? value.trim().toLowerCase()
    : fallback;
}

function renderValues() {
  jpegQualityValue.textContent = jpegQualityInput.value;
  webpQualityValue.textContent = webpQualityInput.value;
  jpegBackgroundColorValue.textContent = jpegBackgroundColorInput.value.toLowerCase();
}

async function restoreSettings() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  jpegQualityInput.value = String(clampNumber(settings.jpegQuality, 1, 100, DEFAULT_SETTINGS.jpegQuality));
  webpQualityInput.value = String(clampNumber(settings.webpQuality, 1, 100, DEFAULT_SETTINGS.webpQuality));
  jpegBackgroundColorInput.value = normalizeColor(settings.jpegBackgroundColor, DEFAULT_SETTINGS.jpegBackgroundColor);
  saveAsInput.checked = Boolean(settings.saveAs);
  renderValues();
}

async function saveSettings() {
  const payload = {
    jpegQuality: clampNumber(jpegQualityInput.value, 1, 100, DEFAULT_SETTINGS.jpegQuality),
    webpQuality: clampNumber(webpQualityInput.value, 1, 100, DEFAULT_SETTINGS.webpQuality),
    jpegBackgroundColor: normalizeColor(jpegBackgroundColorInput.value, DEFAULT_SETTINGS.jpegBackgroundColor),
    saveAs: Boolean(saveAsInput.checked),
  };

  await chrome.storage.local.set(payload);
  statusNode.textContent = 'Settings saved.';
  window.setTimeout(() => {
    if (statusNode.textContent === 'Settings saved.') {
      statusNode.textContent = '';
    }
  }, 1800);
}

async function resetDefaults() {
  await chrome.storage.local.set(DEFAULT_SETTINGS);
  await restoreSettings();
  statusNode.textContent = 'Defaults restored.';
  window.setTimeout(() => {
    if (statusNode.textContent === 'Defaults restored.') {
      statusNode.textContent = '';
    }
  }, 1800);
}

jpegQualityInput.addEventListener('input', renderValues);
webpQualityInput.addEventListener('input', renderValues);
jpegBackgroundColorInput.addEventListener('input', renderValues);
document.getElementById('saveButton').addEventListener('click', saveSettings);
document.getElementById('resetButton').addEventListener('click', resetDefaults);
document.addEventListener('DOMContentLoaded', restoreSettings);
restoreSettings();
