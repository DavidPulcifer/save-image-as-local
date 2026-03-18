# Save Image As (Local Clean)

After other similar extensions had malware issues after changing hands in ownership, I wanted to create a local extension that I can install on my machine that ensures I am in control of the source code.

Note this was generated with the help of ChatGPT, but appears to be working for me.

A local-only Chromium extension that lets you right-click and save:

- regular `<img>` elements
- CSS background images
- inline SVG
- canvas elements
- original files when you want the exact source bytes

## Features

- Save as **Original**, **PNG**, **JPG**, or **WebP**
- Preserves a sensible filename when possible
- Works with **WebP**, **AVIF**, **SVG**, **PNG**, **JPG**, **GIF**, and more as source formats
- Handles **CSS `background-image`** values when you right-click the element itself
- Handles **cross-origin** images by fetching them through the extension when needed
- Includes an options page for JPEG / WebP quality, JPEG background color, and Save As behavior
- No analytics, no remote configuration, no hidden iframes, no external code

## Install

1. Unzip the archive.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the unzipped `save-image-as-local` folder.

## Use

Right-click an image, canvas, inline SVG, or an element with a CSS background image.
Then choose:

- **Save image as… → Original format**
- **Save image as… → PNG**
- **Save image as… → JPG**
- **Save image as… → WebP**

Click the extension icon to open its options page.

## Notes

- For `file://` pages, enable **Allow access to file URLs** on the extension details page.
- Converted JPG / PNG / WebP files are re-encoded, so metadata such as EXIF is usually not preserved.
- Original-format saves preserve the original bytes whenever the browser can read them directly.
- Very large images may be slower because the extension converts them entirely in-browser.

## Permissions

- **All sites**: required so the extension can read the exact image you clicked and fetch cross-origin image files when needed.
- **Downloads**: required to save files to disk.
- **Storage**: required for local settings only.
- **Offscreen**: required to convert images in a hidden extension page.


## Fixes in 1.0.1

- Fixed empty 0-byte downloads caused by passing binary `ArrayBuffer` payloads through Chrome extension message channels.
- The extension now transfers captured and converted files as `data:` URLs across contexts, which matches Chrome's JSON-serializable messaging model.
