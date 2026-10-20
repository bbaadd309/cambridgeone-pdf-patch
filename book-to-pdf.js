/*************************************************************************
 * Book -> PDF exporter
 *
 * Cambridge One "imgbook" ebooks are stored on disk as:
 *   <bookDir>[/assets]/imgbook-meta/book.json         (page order + dims)
 *   <bookDir>[/assets]/imgbook-meta/book-overlays.json (clickable hotspots)
 *   <bookDir>[/assets]/imgbook-meta/toc_metadata.json  (table of contents)
 *   <bookDir>[/assets]/images/<size>/<file>            (one JPEG per page)
 *
 * Generates two PDFs per book:
 *   <productCode>.pdf      - fast/light (medium-res images)
 *   <productCode>-hq.pdf   - high quality (xlrg-res images)
 *
 * Internal page links (overlays of type "page") become clickable PDF
 * link annotations, and the TOC becomes PDF outline bookmarks.
 * JPEG data is embedded as-is (DCTDecode); no external dependencies.
 *************************************************************************/

const fs = require('fs');
const path = require('path');

// quality preference orders
const HQ_ORDER = ['pagexlLrgImgFolder', 'pageLrgImgFolder', 'pageMedImgFolder', 'pageSmImgFolder', 'pageThumbImgFolder'];
const FAST_ORDER = ['pageMedImgFolder', 'pageSmImgFolder', 'pageLrgImgFolder', 'pagexlLrgImgFolder', 'pageThumbImgFolder'];
const DIR_DEFAULTS = {
  pagexlLrgImgFolder: 'images/xlrg',
  pageLrgImgFolder: 'images/lrg',
  pageMedImgFolder: 'images/med',
  pageSmImgFolder: 'images/sm',
  pageThumbImgFolder: 'images/thumbnail',
};

/* Read width/height from a JPEG buffer by scanning for a SOF marker. */
function jpegSize(buf) {
  let i = 2; // skip FFD8
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/* Find the page image on disk, following the given folder preference order. */
function findPageImage(baseDir, imgDirs, page) {
  const names = [];
  if (page.bgimage) names.push(page.bgimage);            // full filename (has extension)
  if (page.fid !== undefined && page.fid !== null) names.push(page.fid + '.jpg');
  for (const name of names) {
    for (const dir of imgDirs) {
      const p = path.join(baseDir, dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function esc(s) { return String(s).replace(/[()\\]/g, m => '\\' + m); }

/* Resolve image folder paths for a preference order, honouring book.json paths. */
function imageDirs(bookJson, order) {
  const p = (bookJson && bookJson.paths) || {};
  return order.map(k => String(p[k] || DIR_DEFAULTS[k]).replace(/\/+$/, ''));
}

/*
 * Parse book-overlays.json -> internal links.
 * Returns { links: Map<sno, [{x,y,w,h,destSno}]>, labelToSno: Map<label, sno> }
 * Coordinates are in native page space (top-left origin).
 */
function parseLinks(baseDir, bookJson) {
  const overlaysPath = path.join(baseDir, 'imgbook-meta', 'book-overlays.json');
  const labelToSno = new Map();
  (bookJson.pages.page || []).forEach((pg, i) => labelToSno.set(String(pg.pagelabel), i + 1));

  const links = new Map();
  if (!fs.existsSync(overlaysPath)) return { links, labelToSno };
  try {
    const ov = JSON.parse(fs.readFileSync(overlaysPath, 'utf8'));
    for (const pg of (ov.pages && ov.pages.page) || []) {
      for (const o of pg.overlays || []) {
        if (o.type !== 'page' || !o.page || o.page.pagelabel === undefined) continue;
        const destSno = labelToSno.get(String(o.page.pagelabel));
        if (destSno === undefined) continue;
        if (!links.has(pg.sno)) links.set(pg.sno, []);
        links.get(pg.sno).push({ x: o.x, y: o.y, w: o.w, h: o.h, destSno });
      }
    }
  } catch (e) { /* overlays optional */ }
  return { links, labelToSno };
}

/* HTML -> plain text (entities decoded, block tags -> newlines). */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/*
 * Per-page text layer: pages carry a "page-text" field pointing at an
 * HTML file under pagetext-meta/. Returns Map<sno, text>.
 */
function parsePageTexts(baseDir, bookJson) {
  const p = (bookJson && bookJson.paths) || {};
  const textDir = path.join(baseDir, String(p.pageTextMetaFolder || 'pagetext-meta'));
  const texts = new Map();
  if (!fs.existsSync(textDir)) return texts;
  (bookJson.pages.page || []).forEach((pg, i) => {
    // candidate text file names for this page
    const names = [];
    if (pg['page-text']) names.push(pg['page-text']);
    if (pg.bgimage) names.push(pg.bgimage.replace(/\.[^.]+$/, '.html'));
    if (pg.fid !== undefined && pg.fid !== null) names.push(pg.fid + '.html');
    for (const name of names) {
      const fp = path.join(textDir, name);
      if (!fs.existsSync(fp)) continue;
      try {
        const t = htmlToText(fs.readFileSync(fp, 'utf8'));
        if (t) texts.set(i + 1, t);
      } catch (e) { /* skip page */ }
      break;
    }
  });
  return texts;
}

/* Encode a JS string as a PDF hex string of UTF-16 code units (Identity-H). */
function toHexText(s) {
  const units = [];
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) { units.push(0x3f); if (code >= 0xd800 && code <= 0xdbff) i++; continue; }
    units.push(code);
  }
  return Buffer.from(units.flatMap(u => [u >> 8, u & 0xff])).toString('hex');
}

/* Parse toc_metadata.json -> outline entries [{title, sno}] (first breadcrumb). */
function parseOutline(baseDir, labelToSno) {
  const tocPath = path.join(baseDir, 'imgbook-meta', 'toc_metadata.json');
  const out = [];
  if (!fs.existsSync(tocPath)) return out;
  try {
    const toc = JSON.parse(fs.readFileSync(tocPath, 'utf8'));
    for (const pg of (toc.pages && toc.pages.page) || []) {
      const title = (pg.breadcrumbs || []).find(b => b && b !== '---');
      const sno = labelToSno.get(String(pg['page-label']));
      if (title && sno !== undefined && (!out.length || out[out.length - 1].title !== String(title))) {
        out.push({ title: String(title), sno });
      }
    }
  } catch (e) { /* toc optional */ }
  return out;
}

/*
 * Build a PDF file (streaming writes).
 * entries: ordered [{file, sno}]; links/outline keyed by sno;
 * pageW/pageH: native page coordinate space from book.json.
 */
function writePdf(entries, outFile, title, opts) {
  const { links, outline, texts, pageW, pageH } = opts;
  const snoToPdf = new Map(entries.map((e, i) => [e.sno, i])); // sno -> pdf page index
  const hasText = entries.some(e => texts.has(e.sno));
  const fd = fs.openSync(outFile, 'w');
  try {
    const offsets = {};
    let pos = 0;
    const push = (data) => {
      const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary');
      fs.writeSync(fd, b);
      pos += b.length;
    };
    const obj = (n, data) => { offsets[n] = pos; push(`${n} 0 obj\n`); push(data); push('\nendobj\n'); };

    push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');

    const pageCount = entries.length;
    const firstPageObj = 3;                  // 1=catalog, 2=pages
    const fontObj = firstPageObj + pageCount * 3;
    const cmapObj = fontObj + 1;
    const outlineRootObj = cmapObj + 1;
    const firstOutlineItemObj = outlineRootObj + 1;

    const pageObjNum = (i) => firstPageObj + i * 3;
    const outlineItems = outline.filter(e => snoToPdf.has(e.sno));

    const kids = [];
    for (let i = 0; i < pageCount; i++) kids.push(`${pageObjNum(i)} 0 R`);

    const outlineRef = outlineItems.length ? ` /Outlines ${outlineRootObj} 0 R /PageMode /UseOutlines` : '';
    obj(1, `<< /Type /Catalog /Pages 2 0 R${outlineRef} >>`);
    obj(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`);

    for (let i = 0; i < pageCount; i++) {
      const img = fs.readFileSync(entries[i].file);
      const dim = jpegSize(img) || { width: 612, height: 792 };
      const w = 612; // page width in points
      const h = Math.round((dim.height / dim.width) * w);
      const sx = w / pageW, sy = h / pageH;

      // link annotations (overlay coords are top-left origin; PDF is bottom-left)
      let annots = '';
      const pageLinks = links.get(entries[i].sno) || [];
      const annotParts = [];
      for (const l of pageLinks) {
        const dest = snoToPdf.get(l.destSno);
        if (dest === undefined) continue;
        const x1 = Math.round(l.x * sx * 100) / 100;
        const y2 = Math.round((pageH - l.y) * sy * 100) / 100;
        const x2 = Math.round((l.x + l.w) * sx * 100) / 100;
        const y1 = Math.round((pageH - l.y - l.h) * sy * 100) / 100;
        annotParts.push(`<< /Subtype /Link /Rect [${x1} ${y1} ${x2} ${y2}] /Border [0 0 0] /Dest [${pageObjNum(dest)} 0 R /Fit] >>`);
      }
      if (annotParts.length) annots = ` /Annots [${annotParts.join(' ')}]`;

      const pageObj = pageObjNum(i);
      const contentObj = pageObj + 1;
      const imageObj = pageObj + 2;

      const fontRes = hasText ? ` /Font << /F1 ${fontObj} 0 R >>` : '';
      obj(pageObj, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imageObj} 0 R >>${fontRes} >> /Contents ${contentObj} 0 R${annots} >>`);

      // invisible text layer (rendering mode 3) for search/copy/extraction
      let content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ`;
      const text = texts.get(entries[i].sno);
      if (text) {
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length) {
          const leading = Math.min(24, Math.max(8, Math.round(h / (lines.length + 2) * 10) / 10));
          const fontSize = Math.round(leading * 0.8 * 10) / 10;
          const parts = lines.map(l => `<${toHexText(l)}> Tj\nT*`);
          content += `\nBT /Tr 3 /F1 ${fontSize} Tf ${leading} TL 10 ${h - 20} Td\n${parts.join('\n')}ET`;
        }
      }
      obj(contentObj, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

      offsets[imageObj] = pos;
      push(`${imageObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${dim.width} /Height ${dim.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`);
      push(img);
      push('\nendstream\nendobj\n');
    }

    // font + ToUnicode for the invisible text layer
    if (hasText) {
      obj(fontObj, `<< /Type /Font /Subtype /Type0 /BaseFont /Helvetica /Encoding /Identity-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Helvetica /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>] /ToUnicode ${cmapObj} 0 R >>`);
      const cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
      obj(cmapObj, `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
    }

    let nextObj = firstOutlineItemObj;
    if (outlineItems.length) {
      obj(outlineRootObj, `<< /Type /Outlines /First ${firstOutlineItemObj} 0 R /Last ${firstOutlineItemObj + outlineItems.length - 1} 0 R /Count ${outlineItems.length} >>`);
      outlineItems.forEach((e, i) => {
        const parts = [`/Title (${esc(e.title)})`, `/Parent ${outlineRootObj} 0 R`, `/Dest [${pageObjNum(snoToPdf.get(e.sno))} 0 R /Fit]`];
        if (i > 0) parts.push(`/Prev ${firstOutlineItemObj + i - 1} 0 R`);
        if (i < outlineItems.length - 1) parts.push(`/Next ${firstOutlineItemObj + i + 1} 0 R`);
        obj(firstOutlineItemObj + i, `<< ${parts.join(' ')} >>`);
      });
      nextObj += outlineItems.length;
    }

    const xrefPos = pos;
    const total = nextObj;
    let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let i = 1; i < total; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    push(xref);
    push(`trailer\n<< /Size ${total} /Root 1 0 R /Info << /Title (${esc(title)}) >> >>\nstartxref\n${xrefPos}\n%%EOF`);
  } finally {
    fs.closeSync(fd);
  }
  return outFile;
}

/* Locate the folder that contains imgbook-meta/book.json (book root or assets/). */
function findMetaDir(bookDir) {
  for (const base of [bookDir, path.join(bookDir, 'assets')]) {
    const p = path.join(base, 'imgbook-meta', 'book.json');
    if (fs.existsSync(p)) return { baseDir: base, bookJsonPath: p };
  }
  return null;
}

/* Ordered [{file, sno}] for pages that exist on disk. */
function collectEntries(baseDir, bookJson, order) {
  const dirs = imageDirs(bookJson, order);
  const entries = [];
  (bookJson.pages.page || []).forEach((pg, i) => {
    const file = findPageImage(baseDir, dirs, pg);
    if (file) entries.push({ file, sno: i + 1 });
  });
  return entries;
}

/**
 * Generate fast + HQ PDFs for a downloaded book.
 * Returns array of written paths (may be empty).
 */
function generate(bookDir, productCode) {
  const meta = findMetaDir(bookDir);
  if (!meta) return [];

  const bookJson = JSON.parse(fs.readFileSync(meta.bookJsonPath, 'utf8'));
  const pages = bookJson && bookJson.pages && bookJson.pages.page;
  if (!Array.isArray(pages) || !pages.length) return [];

  const { links, labelToSno } = parseLinks(meta.baseDir, bookJson);
  const opts = {
    links,
    outline: parseOutline(meta.baseDir, labelToSno),
    texts: parsePageTexts(meta.baseDir, bookJson),
    pageW: bookJson.pageWidth || 612,
    pageH: bookJson.pageHeight || 792,
  };

  const title = bookJson.title || productCode;
  const out = [];
  for (const [suffix, order] of [['', FAST_ORDER], ['-hq', HQ_ORDER]]) {
    const entries = collectEntries(meta.baseDir, bookJson, order);
    if (!entries.length) continue;
    out.push(writePdf(entries, path.join(bookDir, `${productCode}${suffix}.pdf`), title, opts));
  }
  return out;
}

module.exports = { generate };
