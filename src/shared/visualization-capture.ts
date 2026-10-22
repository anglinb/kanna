/**
 * Saving a visualization as a PNG. The host cannot see into the frame: the
 * document runs in an opaque-origin sandbox, two frames down. So the page
 * draws itself. `prepareVisualizationDocument` adds the script below to every
 * document at load, and the shell passes the host's request down and the
 * image back up.
 *
 * The page is cloned with its stylesheets and the resolved values of its
 * custom properties, laid in an SVG `foreignObject`, and drawn onto a canvas
 * from a `data:` URL. A `data:` image is same-origin to the canvas, and
 * WebKit leaves a `data:` SVG with a `foreignObject` untainted too. What the
 * clone cannot carry over is put in by hand: a canvas's pixels (as an image
 * with the canvas's own computed box), a `blob:` image, the current values
 * of form fields. Shadow roots are not cloned, so the rows the controls
 * script took over fall back to their plain markup, which draws the same.
 *
 * The iOS app shows the saved shell without this, and can take a snapshot of
 * its own web view instead.
 */

/** Canvas limits that hold in every browser: iOS Safari will not make a canvas over 16.7M pixels. */
const MAX_SIDE = 16384
const MAX_AREA = 16_777_216

/**
 * The capture's arithmetic, as the script's own source so the tests run the
 * very text that ships. At the screen's density, and never under 2x, so a
 * capture taken on a 1x screen is still sharp on a 2x one; scaled down only
 * as far as the canvas limits need.
 */
export const VISUALIZATION_CAPTURE_GEOMETRY = [
  `const captureSize = (width, height, pixelRatio) => { const fits = Math.min(${MAX_SIDE} / width, ${MAX_SIDE} / height, Math.sqrt(${MAX_AREA} / (width * height))); const scale = Math.min(Math.max(2, Math.min(3, pixelRatio || 1)), fits); return { scale, width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }; };`,
].join("\n")

export const VISUALIZATION_CAPTURE_SCRIPT = `(() => {
  if (window.__kannaCapture) return;
  window.__kannaCapture = true;
  ${VISUALIZATION_CAPTURE_GEOMETRY}
  const sheets = () => [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])].filter(sheet => !sheet.disabled);
  const rulesOf = sheet => { try { return [...sheet.cssRules]; } catch { return []; } };
  const stylesheet = () => sheets().map(sheet => {
    const text = rulesOf(sheet).map(rule => rule.cssText).join('\\n');
    const media = sheet.media?.mediaText;
    return media && media !== 'all' ? '@media ' + media + '{' + text + '}' : text;
  }).join('\\n');
  // Every custom property the page sets. Their values go on the clone's root
  // resolved, since :root in the SVG is the <svg>, not the clone's <html>.
  const customProperties = () => {
    const names = new Set();
    const collect = style => { for (let index = 0; index < style.length; index++) if (style[index].startsWith('--')) names.add(style[index]); };
    const walk = rules => { for (const rule of rules) { if (rule.style) collect(rule.style); if (rule.cssRules) walk([...rule.cssRules]); } };
    for (const sheet of sheets()) walk(rulesOf(sheet));
    collect(document.documentElement.style);
    collect(getComputedStyle(document.documentElement));
    return names;
  };
  const rasterize = (source, width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width); canvas.height = Math.max(1, height);
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  };
  // An image in place of a canvas, in the canvas's computed box: a rule
  // written for canvas would not match it.
  const canvasImage = canvas => {
    const image = document.createElement('img');
    for (const attribute of canvas.attributes) image.setAttribute(attribute.name, attribute.value);
    const computed = getComputedStyle(canvas);
    for (let index = 0; index < computed.length; index++) image.style.setProperty(computed[index], computed.getPropertyValue(computed[index]));
    try { image.src = canvas.toDataURL('image/png'); } catch {}
    return image;
  };
  const fill = (requested) => {
    if (requested && CSS.supports('color', requested)) return requested;
    const probe = document.createElement('i');
    probe.style.backgroundColor = 'var(--background)';
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  };
  const load = source => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The page could not be drawn.'));
    image.src = source;
  });
  const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
  const capture = async (background) => {
    await document.fonts.ready;
    const root = document.documentElement;
    const width = Math.ceil(root.clientWidth || innerWidth);
    const height = Math.ceil(Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0));
    const clone = root.cloneNode(true);
    const originals = [root, ...root.querySelectorAll('*')];
    const copies = [clone, ...clone.querySelectorAll('*')];
    originals.forEach((original, index) => {
      const copy = copies[index];
      if (!copy) return;
      const tag = original.localName;
      if (['script', 'noscript', 'style', 'link', 'meta'].includes(tag)) { copy.remove(); return; }
      // Without its shadow root the row's own rules draw the selection again.
      copy.removeAttribute('data-kanna-row');
      if (tag === 'canvas') copy.replaceWith(canvasImage(original));
      else if (tag === 'img' && original.complete && original.naturalWidth && !/^data:/.test(original.currentSrc)) {
        try { copy.src = rasterize(original, original.naturalWidth, original.naturalHeight); copy.removeAttribute('srcset'); } catch {}
      } else if (tag === 'input') {
        if (original.type === 'checkbox' || original.type === 'radio') copy.toggleAttribute('checked', original.checked);
        else copy.setAttribute('value', original.value);
      } else if (tag === 'textarea') copy.textContent = original.value;
      else if (tag === 'select') [...original.options].forEach((option, at) => copy.options[at]?.toggleAttribute('selected', option.selected));
    });
    const computed = getComputedStyle(root);
    for (const name of customProperties()) {
      const value = computed.getPropertyValue(name);
      if (value) clone.style.setProperty(name, value);
    }
    // The page's text color comes from its root's color-scheme. In the SVG
    // the clone is not the root, so it is given the color it resolved to.
    clone.style.setProperty('color', computed.color);
    clone.style.setProperty('color-scheme', computed.colorScheme);
    const style = document.createElement('style');
    style.textContent = stylesheet();
    (clone.querySelector('head') ?? clone).prepend(style);
    const markup = new XMLSerializer().serializeToString(clone);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '"><foreignObject x="0" y="0" width="100%" height="100%">' + markup + '</foreignObject></svg>';
    const image = await load('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
    await image.decode?.().catch(() => {});
    // Safari can paint an SVG image before its fonts are in.
    await frame();
    const size = captureSize(width, height, devicePixelRatio);
    const canvas = document.createElement('canvas');
    canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d');
    context.fillStyle = fill(background);
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(image, 0, 0, size.width, size.height);
    return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The image could not be made.')), 'image/png'));
  };
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'kanna:capture' || typeof event.data.id !== 'string') return;
    const { id, background } = event.data;
    capture(typeof background === 'string' ? background : '').then(
      png => parent.postMessage({ type: 'kanna:captured', id, png }, '*'),
      error => parent.postMessage({ type: 'kanna:captured', id, error: String(error?.message ?? error) }, '*'),
    );
  });
})();`

/** What a capture is called when nobody names it: the title as a slug. */
export function visualizationImageName(title: string): string {
  const slug = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "")
  return slug || "visualization"
}

/**
 * What a capture can be saved as. The page draws a PNG, and the host
 * re-encodes it for the others. No SVG: the one the page builds holds the
 * page as HTML in a `foreignObject`, which only a browser draws (Preview,
 * Figma and Illustrator show it blank or broken), with every font inlined.
 */
export const VISUALIZATION_IMAGE_TYPES = {
  png: { label: "PNG", mimeType: "image/png", extension: "png" },
  jpeg: { label: "JPEG", mimeType: "image/jpeg", extension: "jpg" },
  webp: { label: "WebP", mimeType: "image/webp", extension: "webp" },
} as const

export type VisualizationImageType = keyof typeof VISUALIZATION_IMAGE_TYPES

/**
 * The file a name typed for a capture is saved as. The extension is added
 * here, whether or not one was typed, and an image extension typed for
 * another type is swapped for this one; what a file system will not take goes.
 */
export function visualizationImageFilename(name: string, title: string, type: VisualizationImageType = "png"): string {
  const base = name.trim().replace(/\.(png|jpe?g|webp)$/i, "")
    // Control characters and what Windows, macOS or a shell will not take in a name.
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "-")
    .replace(/^[.\s]+/, "").trim().slice(0, 120).trim()
  return `${base || visualizationImageName(title)}.${VISUALIZATION_IMAGE_TYPES[type].extension}`
}

/**
 * The alpha of a computed color, 1 when it has none. For finding what is
 * painted behind the frame: a color that lets something show through is not it.
 */
export function cssColorAlpha(value: string): number {
  const color = value.trim().toLowerCase()
  if (color === "transparent") return 0
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color)
  if (slash) return slash[2] ? Number(slash[1]) / 100 : Number(slash[1])
  const legacy = /^(?:rgba|hsla)\((?:[^,]*,){3}\s*([\d.]+)(%?)\s*\)$/.exec(color)
  if (legacy) return legacy[2] ? Number(legacy[1]) / 100 : Number(legacy[1])
  return 1
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The page answers with whatever it likes. Only a PNG, and not an absurd one, is saved. */
export function isPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
}
