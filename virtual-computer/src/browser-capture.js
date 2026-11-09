import {check} from './errors.js';

// CDP supports scaling before encoding, so even a long page can be captured
// whole without allocating an unbounded bitmap in the controller.
export async function capturePage(context, page, command) {
  if (!command.selector && !command.clip && !command.full_page) {
    // Mobile pages without viewport meta can have a 980px layout viewport.
    // Playwright captures the visible device screen rather than that layout.
    const data = await page.screenshot({type: command.format || 'jpeg', ...(command.format === 'png' ? {} : {quality: 85}), scale: 'css'});
    check(data.length <= 4_000_000, 'Screenshot exceeds 4 MB; use JPEG or a smaller clip');
    return {mime_type: 'image/' + (command.format || 'jpeg'), base64: data.toString('base64'), ...page.viewportSize(), scale: 1};
  }
  const layout = await page.evaluate(() => ({
    x: scrollX, y: scrollY, viewportWidth: innerWidth, viewportHeight: innerHeight,
    width: Math.max(innerWidth, document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
    height: Math.max(innerHeight, document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
  }));
  let clip;
  if (command.selector) {
    const target = command.frame ? page.frameLocator(command.frame) : page;
    const locator = target.locator(command.selector);
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    check(box && box.width > 0 && box.height > 0, 'Element has no visible area');
    const scroll = await page.evaluate(() => ({x: scrollX, y: scrollY}));
    clip = {x: Math.max(0, box.x + scroll.x), y: Math.max(0, box.y + scroll.y), width: box.width, height: box.height};
  } else if (command.clip) {
    clip = command.clip;
    check(clip.x + clip.width <= layout.width && clip.y + clip.height <= layout.height, 'clip must fit inside the page');
  } else if (command.full_page) {
    clip = {x: 0, y: 0, width: layout.width, height: layout.height};
  } else {
    clip = {x: layout.x, y: layout.y, width: layout.viewportWidth, height: layout.viewportHeight};
  }
  check(clip.width > 0 && clip.height > 0 && clip.width <= 100000 && clip.height <= 100000, 'Screenshot area is too large; use clip');
  let scale = Math.min(1, Math.sqrt(4_000_000 / (clip.width * clip.height)), 16000 / Math.max(clip.width, clip.height));
  // Chromium rounds the output dimensions; leave a pixel of headroom so its
  // encoded image also fits the backend's decoded-pixel limit.
  while (Math.ceil(clip.width * scale) * Math.ceil(clip.height * scale) > 4_000_000) scale *= 0.999;
  const format = command.format || 'jpeg';
  const cdp = await context.newCDPSession(page);
  try {
    const {data} = await cdp.send('Page.captureScreenshot', {format, ...(format === 'jpeg' ? {quality: 85} : {}),
      captureBeyondViewport: true, clip: {...clip, scale}});
    check(data.length <= 5_333_336, 'Screenshot exceeds 4 MB; use JPEG or a smaller clip');
    return {mime_type: 'image/' + format, base64: data, width: Math.floor(clip.width * scale), height: Math.floor(clip.height * scale), scale};
  } finally { await cdp.detach().catch(() => {}); }
}
