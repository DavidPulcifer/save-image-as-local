(() => {
  const state = {
    descriptor: null,
    element: null,
  };

  document.addEventListener('contextmenu', (event) => {
    try {
      const context = inspectContextMenuTarget(event);
      state.descriptor = context.descriptor;
      state.element = context.element;
    } catch (error) {
      state.descriptor = null;
      state.element = null;
    }
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'SAVE_IMAGE_AS_PREPARE_TARGET') {
      prepareTarget()
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: normalizeErrorMessage(error) }));
      return true;
    }

    if (message?.type === 'SAVE_IMAGE_AS_TOAST') {
      showToast(message.text || 'Something went wrong.', message.level || 'error');
    }

    return undefined;
  });

  function inspectContextMenuTarget(event) {
    const pathElements = getPathElements(event);
    const firstElement = pathElements[0] || null;

    for (const element of pathElements) {
      if (element instanceof HTMLImageElement) {
        return {
          element,
          descriptor: buildUrlDescriptor(element.currentSrc || element.src, element, 'image'),
        };
      }

      if (element instanceof HTMLInputElement && element.type === 'image' && element.src) {
        return {
          element,
          descriptor: buildUrlDescriptor(element.src, element, 'image-input'),
        };
      }

      if (element instanceof HTMLCanvasElement) {
        return {
          element,
          descriptor: {
            kind: 'canvas',
            filenameBase: pickFilenameBase('', element, 'canvas'),
            originalExtension: 'png',
            sourceMime: 'image/png',
          },
        };
      }

      if (element instanceof SVGSVGElement) {
        return {
          element,
          descriptor: buildInlineSvgDescriptor(element),
        };
      }

      if (element instanceof SVGElement) {
        const svg = element.closest('svg');
        if (svg) {
          return {
            element: svg,
            descriptor: buildInlineSvgDescriptor(svg),
          };
        }
      }
    }

    for (const element of pathElements) {
      const backgroundUrl = getFirstBackgroundUrl(element);
      if (backgroundUrl) {
        return {
          element,
          descriptor: buildUrlDescriptor(backgroundUrl, element, 'background'),
        };
      }
    }

    return {
      element: firstElement,
      descriptor: null,
    };
  }

  function buildInlineSvgDescriptor(svgElement) {
    const rect = svgElement.getBoundingClientRect();
    return {
      kind: 'inline-svg',
      filenameBase: pickFilenameBase('', svgElement, 'svg'),
      preferredWidth: positiveRounded(rect.width),
      preferredHeight: positiveRounded(rect.height),
      sourceMime: 'image/svg+xml',
      originalExtension: 'svg',
    };
  }

  function buildUrlDescriptor(rawUrl, element, kind) {
    const absoluteUrl = normalizeUrl(rawUrl);
    const sourceMime = mimeFromUrl(absoluteUrl);
    const originalExtension = extensionFromUrl(absoluteUrl) || extensionFromMime(sourceMime) || '';
    const preferredSize = inferPreferredSize(element);

    return {
      kind: 'url',
      sourceUrl: absoluteUrl,
      sourceMime,
      originalExtension,
      filenameBase: pickFilenameBase(absoluteUrl, element, kind),
      preferredWidth: preferredSize.width,
      preferredHeight: preferredSize.height,
    };
  }

  async function prepareTarget() {
    if (!state.descriptor) {
      return {
        ok: false,
        error: 'No image target was captured from that right-click.',
      };
    }

    if (state.descriptor.kind === 'canvas') {
      return await prepareCanvasTarget(state.element, state.descriptor);
    }

    if (state.descriptor.kind === 'inline-svg') {
      return prepareInlineSvgTarget(state.element, state.descriptor);
    }

    if (state.descriptor.kind === 'url') {
      return await prepareUrlTarget(state.descriptor);
    }

    return {
      ok: false,
      error: 'Unsupported target type.',
    };
  }

  async function prepareCanvasTarget(canvasElement, descriptor) {
    if (!(canvasElement instanceof HTMLCanvasElement)) {
      throw new Error('The selected canvas was no longer available.');
    }

    const blob = await canvasToBlob(canvasElement, 'image/png');
    return {
      ok: true,
      sourceKind: 'binary',
      dataUrl: await blobToDataUrl(blob),
      sourceMime: 'image/png',
      originalExtension: 'png',
      filenameBase: descriptor.filenameBase,
      preferredWidth: positiveRounded(canvasElement.width || canvasElement.clientWidth),
      preferredHeight: positiveRounded(canvasElement.height || canvasElement.clientHeight),
    };
  }

  function prepareInlineSvgTarget(svgElement, descriptor) {
    if (!(svgElement instanceof SVGSVGElement)) {
      throw new Error('The selected SVG was no longer available.');
    }

    const clone = svgElement.cloneNode(true);
    if (!clone.getAttribute('xmlns')) {
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    }
    if (!clone.getAttribute('xmlns:xlink')) {
      clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    }
    if (!clone.getAttribute('width') && descriptor.preferredWidth) {
      clone.setAttribute('width', String(descriptor.preferredWidth));
    }
    if (!clone.getAttribute('height') && descriptor.preferredHeight) {
      clone.setAttribute('height', String(descriptor.preferredHeight));
    }

    return {
      ok: true,
      sourceKind: 'inline-svg',
      svgMarkup: new XMLSerializer().serializeToString(clone),
      sourceMime: 'image/svg+xml',
      originalExtension: 'svg',
      filenameBase: descriptor.filenameBase,
      preferredWidth: descriptor.preferredWidth,
      preferredHeight: descriptor.preferredHeight,
    };
  }

  async function prepareUrlTarget(descriptor) {
    validateSupportedProtocol(descriptor.sourceUrl);

    if (shouldFetchInPageContext(descriptor.sourceUrl)) {
      try {
        const response = await fetch(descriptor.sourceUrl, { credentials: 'include' });
        if (!response.ok) {
          throw new Error(`The page couldn't fetch that image (${response.status}).`);
        }
        const blob = await response.blob();
        return {
          ok: true,
          sourceKind: 'binary',
          dataUrl: await blobToDataUrl(blob),
          sourceMime: blob.type || descriptor.sourceMime || 'application/octet-stream',
          originalExtension: descriptor.originalExtension || extensionFromMime(blob.type) || '',
          filenameBase: descriptor.filenameBase,
          preferredWidth: descriptor.preferredWidth,
          preferredHeight: descriptor.preferredHeight,
        };
      } catch (error) {
        if (/^(blob:|data:|file:)/i.test(descriptor.sourceUrl) || isSameOriginUrl(descriptor.sourceUrl)) {
          throw error;
        }
      }
    }

    return {
      ok: true,
      sourceKind: 'url',
      sourceUrl: descriptor.sourceUrl,
      sourceMime: descriptor.sourceMime,
      originalExtension: descriptor.originalExtension,
      filenameBase: descriptor.filenameBase,
      preferredWidth: descriptor.preferredWidth,
      preferredHeight: descriptor.preferredHeight,
    };
  }

  function getPathElements(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    return path.filter((item) => item instanceof Element);
  }

  function getFirstBackgroundUrl(element) {
    if (!(element instanceof Element)) {
      return '';
    }

    const style = getComputedStyle(element);
    const backgroundImage = style.backgroundImage || style.background || '';
    const extracted = extractFirstCssUrl(backgroundImage);
    return extracted ? normalizeUrl(extracted) : '';
  }

  function extractFirstCssUrl(cssValue) {
    if (!cssValue || cssValue === 'none') {
      return '';
    }

    const markerIndex = cssValue.toLowerCase().indexOf('url(');
    if (markerIndex < 0) {
      return '';
    }

    let index = markerIndex + 4;
    while (index < cssValue.length && /\s/.test(cssValue[index])) {
      index += 1;
    }

    const quote = cssValue[index] === '"' || cssValue[index] === '\'' ? cssValue[index++] : null;
    let value = '';

    while (index < cssValue.length) {
      const character = cssValue[index];
      if (quote) {
        if (character === quote) {
          break;
        }
        value += character;
        index += 1;
        continue;
      }

      if (character === ')') {
        break;
      }

      value += character;
      index += 1;
    }

    return value.trim();
  }

  function shouldFetchInPageContext(url) {
    return /^(blob:|data:|file:)/i.test(url) || isSameOriginUrl(url);
  }

  function isSameOriginUrl(url) {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch {
      return false;
    }
  }

  function validateSupportedProtocol(url) {
    if (!/^(https?:|data:|blob:|file:)/i.test(url)) {
      throw new Error('That image used an unsupported URL scheme.');
    }
  }

  function normalizeUrl(url) {
    if (!url) {
      return '';
    }

    if (/^(https?:|data:|blob:|file:)/i.test(url)) {
      return url;
    }

    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return url;
    }
  }

  function inferPreferredSize(element) {
    if (element instanceof HTMLImageElement) {
      return {
        width: positiveRounded(element.naturalWidth || element.width || element.clientWidth),
        height: positiveRounded(element.naturalHeight || element.height || element.clientHeight),
      };
    }

    const rect = element?.getBoundingClientRect?.();
    return {
      width: positiveRounded(rect?.width),
      height: positiveRounded(rect?.height),
    };
  }

  function positiveRounded(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.max(1, Math.round(numeric)) : undefined;
  }

  function pickFilenameBase(url, element, kind) {
    const candidates = [
      filenameBaseFromUrl(url),
      element?.getAttribute?.('download') || '',
      element?.getAttribute?.('alt') || '',
      element?.getAttribute?.('aria-label') || '',
      element?.getAttribute?.('title') || '',
      kind === 'background' ? `${document.title || ''} background` : document.title || '',
    ];

    for (const candidate of candidates) {
      const sanitized = sanitizeFilenameBase(candidate);
      if (sanitized && sanitized !== 'image') {
        return sanitized;
      }
    }

    return 'image';
  }

  function filenameBaseFromUrl(url) {
    if (!url || /^data:/i.test(url)) {
      return '';
    }

    try {
      const parsed = new URL(url, document.baseURI);
      const pathname = decodeURIComponent(parsed.pathname || '');
      const filename = pathname.split('/').pop() || '';
      return filename.replace(/\.[^.]+$/, '') || '';
    } catch {
      return '';
    }
  }

  function extensionFromUrl(url) {
    if (!url || /^data:/i.test(url)) {
      return '';
    }

    try {
      const parsed = new URL(url, document.baseURI);
      const pathname = decodeURIComponent(parsed.pathname || '');
      const filename = pathname.split('/').pop() || '';
      const match = filename.match(/\.([a-zA-Z0-9]+)$/);
      return match ? match[1].toLowerCase() : '';
    } catch {
      return '';
    }
  }

  function extensionFromMime(mimeType) {
    return {
      'image/avif': 'avif',
      'image/bmp': 'bmp',
      'image/gif': 'gif',
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/svg+xml': 'svg',
      'image/tiff': 'tiff',
      'image/webp': 'webp',
      'image/x-icon': 'ico',
    }[(mimeType || '').toLowerCase()] || '';
  }

  function mimeFromUrl(url) {
    return {
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
    }[extensionFromUrl(url)] || '';
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

  function canvasToBlob(canvas, mimeType) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('The browser could not serialize that canvas.'));
            return;
          }
          resolve(blob);
        }, mimeType);
      } catch (error) {
        reject(error);
      }
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('The browser could not package that image.'));
      reader.onload = () => {
        if (typeof reader.result !== 'string' || !reader.result.startsWith('data:')) {
          reject(new Error('The browser returned an invalid image payload.'));
          return;
        }
        resolve(reader.result);
      };
      reader.readAsDataURL(blob);
    });
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

  function showToast(text, level) {
    const existing = document.getElementById('__save_image_as_toast__');
    if (existing) {
      existing.remove();
    }

    const host = document.createElement('div');
    host.id = '__save_image_as_toast__';
    host.style.position = 'fixed';
    host.style.right = '16px';
    host.style.bottom = '16px';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';

    const root = host.attachShadow({ mode: 'open' });
    const wrapper = document.createElement('div');
    wrapper.textContent = text;
    wrapper.style.font = '13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    wrapper.style.maxWidth = '340px';
    wrapper.style.padding = '10px 12px';
    wrapper.style.borderRadius = '10px';
    wrapper.style.boxShadow = '0 10px 24px rgba(0,0,0,0.18)';
    wrapper.style.background = level === 'error' ? 'rgba(32, 33, 36, 0.96)' : 'rgba(17, 17, 17, 0.92)';
    wrapper.style.color = '#fff';
    wrapper.style.border = '1px solid rgba(255,255,255,0.12)';

    root.appendChild(wrapper);
    document.documentElement.appendChild(host);

    window.setTimeout(() => host.remove(), 4200);
  }
})();
