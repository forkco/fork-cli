// Content sniffing for `file`: magic bytes only, never the file name.
const SIGNATURES = [
  [b => b.subarray(0, 5).toString() === '%PDF-', 'application/pdf', 'PDF document'],
  [b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, 'image/jpeg', 'JPEG image data'],
  [b => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'image/png', 'PNG image data'],
  [b => /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1')), 'image/gif', 'GIF image data'],
  [b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP', 'image/webp', 'RIFF (little-endian) data, Web/P image'],
  [b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE', 'audio/x-wav', 'RIFF (little-endian) data, WAVE audio'],
  [b => b.subarray(4, 8).toString('latin1') === 'ftyp', 'video/mp4', 'ISO Media, MP4'],
  [b => b.subarray(0, 4).toString('hex') === '1a45dfa3', 'video/webm', 'WebM/Matroska data'],
  [b => b.subarray(0, 4).toString('latin1') === 'OggS', 'audio/ogg', 'Ogg data'],
  [b => b.subarray(0, 4).toString('latin1') === 'fLaC', 'audio/flac', 'FLAC audio bitstream data'],
  [b => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0), 'audio/mpeg', 'Audio file with ID3 / MPEG ADTS'],
  [b => b.subarray(0, 4).toString('hex') === '504b0304' || b.subarray(0, 4).toString('hex') === '504b0506', 'application/zip', 'Zip archive data'],
  [b => b[0] === 0x1f && b[1] === 0x8b, 'application/gzip', 'gzip compressed data'],
  [b => b.subarray(257, 262).toString('latin1') === 'ustar', 'application/x-tar', 'POSIX tar archive'],
  [b => b.subarray(0, 6).toString('hex') === '377abcaf271c', 'application/x-7z-compressed', '7-zip archive data'],
  [b => b.subarray(0, 4).toString('latin1') === 'Rar!', 'application/vnd.rar', 'RAR archive data'],
  [b => b.subarray(0, 4).toString('hex') === '00000100', 'image/vnd.microsoft.icon', 'MS Windows icon resource'],
  [b => b.subarray(0, 2).toString('latin1') === 'BM', 'image/bmp', 'PC bitmap'],
  [b => /^(wOFF|wOF2)/.test(b.subarray(0, 4).toString('latin1')), 'font/woff', 'Web Open Font Format'],
  [b => b.subarray(0, 4).toString('hex') === 'd0cf11e0', 'application/x-ole-storage', 'Composite Document File V2 (legacy Office)'],
];

export function detectType(bytes) {
  if (!bytes.length) return {mime: 'inode/x-empty', description: 'empty'};
  for (const [test, mime, description] of SIGNATURES) if (test(bytes)) {
    if (mime === 'application/zip') {
      const head = bytes.subarray(0, 4096).toString('latin1');
      if (head.includes('word/')) return {mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', description: 'Microsoft Word 2007+'};
      if (head.includes('xl/')) return {mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', description: 'Microsoft Excel 2007+'};
      if (head.includes('ppt/')) return {mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', description: 'Microsoft PowerPoint 2007+'};
      if (head.includes('mimetypeapplication/epub+zip')) return {mime: 'application/epub+zip', description: 'EPUB document'};
    }
    return {mime, description};
  }
  const sample = bytes.subarray(0, 65536);
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(sample.length < bytes.length ? sample.subarray(0, sample.lastIndexOf(10) + 1 || sample.length) : sample); }
  catch { return {mime: 'application/octet-stream', description: 'data'}; }
  if (text.includes('\0')) return {mime: 'application/octet-stream', description: 'data'};
  const trimmed = text.trimStart();
  const ascii = /^[\x00-\x7f]*$/.test(text) ? 'ASCII' : 'Unicode text, UTF-8';
  if (/^<svg[\s>]/i.test(trimmed) || /^<\?xml[^>]*>\s*<svg/i.test(trimmed)) return {mime: 'image/svg+xml', description: 'SVG Scalable Vector Graphics image'};
  if (/^<!doctype html|^<html[\s>]/i.test(trimmed)) return {mime: 'text/html', description: `HTML document, ${ascii} text`};
  if (/^<\?xml/.test(trimmed)) return {mime: 'text/xml', description: `XML document, ${ascii} text`};
  if (/^[[{]/.test(trimmed)) { try { JSON.parse(text); return {mime: 'application/json', description: 'JSON data'}; } catch { /* plain text */ } }
  if (/^%!PS/.test(trimmed)) return {mime: 'application/postscript', description: 'PostScript document'};
  const lines = text.split('\n').slice(0, 5).filter(Boolean);
  if (lines.length >= 2 && lines.every(l => (l.match(/,/g) || []).length === (lines[0].match(/,/g) || []).length) && lines[0].includes(',')) return {mime: 'text/csv', description: `CSV ${ascii} text`};
  return {mime: 'text/plain', description: ascii === 'ASCII' ? 'ASCII text' : 'Unicode text, UTF-8 text'};
}
