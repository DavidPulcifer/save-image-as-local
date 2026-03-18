const OUTPUT_MIME_BY_FORMAT = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const EXTENSION_BY_MIME = {
  'application/octet-stream': 'bin',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message?.type !== 'SAVE_IMAGE_AS_CONVERT') {
    return undefined;
  }

  (async () => {
    const result = await convertAndPackage(message.source, message.requestedFormat, message.settings || {});
    sendResponse({ ok: true, ...result });
  })().catch((error) => {
    sendResponse({ ok: false, error: normalizeErrorMessage(error) });
  });

  return true;
});

async function convertAndPackage(source, requestedFormat, settings) {
  if (!source?.sourceKind) {
    throw new Error('No image source was supplied.');
  }

  const input = await readSourceBlob(source);
  const filenameBase = sanitizeFilenameBase(source.filenameBase || filenameBaseFromUrl(source.sourceUrl) || 'image');
  const originalMime = input.mimeType || source.sourceMime || mimeFromUrl(source.sourceUrl) || 'application/octet-stream';

  if (requestedFormat === 'original') {
    const originalExtension = normalizeOriginalExtension(source.originalExtension, originalMime, source.sourceUrl);
    return {
      filename: `${filenameBase}.${originalExtension}`,
      mimeType: input.blob.type || originalMime,
      dataUrl: await blobToDataUrl(input.blob),
    };
  }

  const outputMime = OUTPUT_MIME_BY_FORMAT[requestedFormat];
  if (!outputMime) {
    throw new Error(`Unsupported output format: ${requestedFormat}`);
  }

  const quality = requestedFormat === 'jpeg'
    ? clampQuality(settings.jpegQuality, 92)
    : requestedFormat === 'webp'
      ? clampQuality(settings.webpQuality, 90)
      : undefined;

  const outputBlob = await rasterizeToBlob(input.blob, outputMime, quality, {
    preferredWidth: source.preferredWidth,
    preferredHeight: source.preferredHeight,
    jpegBackgroundColor: normalizeColor(settings.jpegBackgroundColor, '#ffffff'),
  });

  return {
    filename: `${filenameBase}.${EXTENSION_BY_MIME[outputMime] || 'img'}`,
    mimeType: outputBlob.type || outputMime,
    dataUrl: await blobToDataUrl(outputBlob),
  };
}

async function readSourceBlob(source) {
  switch (source.sourceKind) {
    case 'binary': {
      if (!source.dataUrl) {
        throw new Error('The captured image data was empty.');
      }

      const blob = await dataUrlToBlob(source.dataUrl);
      const mimeType = blob.type || source.sourceMime || 'application/octet-stream';
      return {
        blob: blob.type ? blob : new Blob([await blob.arrayBuffer()], { type: mimeType }),
        mimeType,
      };
    }
    case 'inline-svg': {
      const markup = normalizeSvgMarkup(source.svgMarkup, source.preferredWidth, source.preferredHeight);
      return {
        blob: new Blob([markup], { type: 'image/svg+xml' }),
        mimeType: 'image/svg+xml',
      };
    }
    case 'url': {
      const response = await fetch(source.sourceUrl, {
        credentials: 'include',
        cache: 'force-cache',
      });

      if (!response.ok) {
        throw new Error(`Couldn't fetch the source image (${response.status}).`);
      }

      let blob = await response.blob();
      const mimeType = blob.type || source.sourceMime || mimeFromUrl(source.sourceUrl) || 'application/octet-stream';

      if (!blob.type && mimeType) {
        blob = new Blob([await blob.arrayBuffer()], { type: mimeType });
      }

      return { blob, mimeType };
    }
    default:
      throw new Error(`Unsupported source kind: ${source.sourceKind}`);
  }
}

async function rasterizeToBlob(inputBlob, outputMime, quality, options) {
  const { image, objectUrl } = await loadImageFromBlob(inputBlob);

  try {
    const width = pickDimension(options.preferredWidth, image.naturalWidth || image.width || 0);
    const height = pickDimension(options.preferredHeight, image.naturalHeight || image.height || 0);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d', { alpha: outputMime !== 'image/jpeg' });
    if (!ctx) {
      throw new Error('Your browser did not provide a 2D canvas context.');
    }

    if (outputMime === 'image/jpeg') {
      ctx.fillStyle = options.jpegBackgroundColor;
      ctx.fillRect(0, 0, width, height);
    }

    ctx.drawImage(image, 0, 0, width, height);
    return await canvasToBlob(canvas, outputMime, quality);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = 'async';

    image.onload = () => resolve({ image, objectUrl });
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('The browser could not decode that image.'));
    };

    image.src = objectUrl;
  });
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('The browser failed to encode the converted image.'));
        return;
      }
      resolve(blob);
    }, mimeType, quality);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The browser failed to package the converted image.'));
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.startsWith('data:')) {
        reject(new Error('The browser returned an invalid file payload.'));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  if (!response.ok) {
    throw new Error('The browser could not decode the captured image data.');
  }
  return await response.blob();
}

function normalizeSvgMarkup(markup, preferredWidth, preferredHeight) {
  const parser = new DOMParser();
  const documentNode = parser.parseFromString(markup || '', 'image/svg+xml');
  const svg = documentNode.documentElement;

  if (!svg || svg.nodeName.toLowerCase() !== 'svg') {
    throw new Error('The inline SVG could not be parsed.');
  }

  if (!svg.getAttribute('xmlns')) {
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  if (!svg.getAttribute('xmlns:xlink')) {
    svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  }
  if (!svg.getAttribute('width') && Number(preferredWidth) > 0) {
    svg.setAttribute('width', String(Math.round(preferredWidth)));
  }
  if (!svg.getAttribute('height') && Number(preferredHeight) > 0) {
    svg.setAttribute('height', String(Math.round(preferredHeight)));
  }

  return new XMLSerializer().serializeToString(svg);
}

function pickDimension(preferred, natural) {
  const naturalNumber = Number(natural);
  if (Number.isFinite(naturalNumber) && naturalNumber > 0) {
    return Math.max(1, Math.round(naturalNumber));
  }

  const preferredNumber = Number(preferred);
  if (Number.isFinite(preferredNumber) && preferredNumber > 0) {
    return Math.max(1, Math.round(preferredNumber));
  }

  return 1;
}

function normalizeOriginalExtension(sourceExtension, mimeType, sourceUrl) {
  const fromSource = (sourceExtension || '').toLowerCase().replace(/^\./, '');
  if (fromSource) {
    return fromSource;
  }

  const fromMime = EXTENSION_BY_MIME[(mimeType || '').toLowerCase()];
  if (fromMime) {
    return fromMime;
  }

  const fromUrl = extensionFromUrl(sourceUrl || '');
  if (fromUrl) {
    return fromUrl;
  }

  return 'bin';
}

function clampQuality(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback / 100;
  }
  return Math.min(1, Math.max(0.01, Math.round(numeric) / 100));
}

function normalizeColor(value, fallback) {
  return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim())
    ? value.trim()
    : fallback;
}

function filenameBaseFromUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname || '');
    const filename = pathname.split('/').pop() || '';
    return filename.replace(/\.[^.]+$/, '') || '';
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
  const extension = extensionFromUrl(url || '');
  return extension ? Object.entries(EXTENSION_BY_MIME).find(([, ext]) => ext === extension)?.[0] || '' : '';
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
