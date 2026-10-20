#!/usr/bin/env node
/*************************************************************************
 * Cambridge One -> PDF patcher
 *
 * Patches the installed app's resources/app.asar in place:
 *   1. Injects a hook into desktop/downloader-process/download.js that
 *      calls the PDF exporter whenever a book download finishes.
 *   2. Adds desktop/pdf-export/book-to-pdf.js (the exporter).
 *   3. Moves the data directory (books/PDFs) to %APPDATA%\CambridgeOne
 *      instead of a loose "CambridgeOne" folder on the drive root.
 *
 * The original app.asar is kept as app.asar.bak next to it.
 *
 * Usage:
 *   node patch.js [path-to-install-dir]
 *   node patch.js [path-to-install-dir] --restore
 *
 * Requires Node.js 14+. No dependencies.
 *************************************************************************/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- patch definitions (verified against CambridgeOne 2.54.0) ----------

const DOWNLOAD_JS = 'desktop/downloader-process/download.js';
const CONFIG_JS = 'desktop/config.js';
const MODULE_JS = 'desktop/pdf-export/book-to-pdf.js';

const MARKER = 'pdf-export/book-to-pdf';

// inject the PDF call right where a download reaches FINISHED
const HOOK_ANCHOR = 'g.status=h.FINISHED,delete g.assetOnDownload,g&&g.metadata&&(delete g.metadata.isObselete';
const HOOK = `g.status=h.FINISHED,(()=>{try{let t=require(c.resolve(__dirname,"../pdf-export/book-to-pdf")).generate(g.location,g.productCode);t&&t.length&&console.log("PDF exported:",t)}catch(e){console.error("PDF export failed:",e)}})(),delete g.assetOnDownload,g&&g.metadata&&(delete g.metadata.isObselete`;

// move data dir (books/courses/db) off the drive root into %APPDATA%
const STORAGE_ANCHOR = 'a="win32"===process.platform?o.resolve(__dirname,"..","..","..","..","../CambridgeOne"):process.env.userDataPath';
const STORAGE_NEW = 'a=process.env.userDataPath';
const STORAGE_CHECK = 'a=process.env.userDataPath,';

// ---------- asar helpers ----------

const BLOCK = 4194304;
function integrity(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += BLOCK) {
    blocks.push(crypto.createHash('sha256').update(buf.subarray(i, Math.min(i + BLOCK, buf.length))).digest('hex'));
  }
  if (!blocks.length) blocks.push(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  return { algorithm: 'SHA256', hash: crypto.createHash('sha256').update(buf).digest('hex'), blockSize: BLOCK, blocks };
}

function readHeader(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonSize = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonSize);
  fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
  return { tree: JSON.parse(jsonBuf.toString()), dataStart: 16 + jsonSize };
}

function getNode(tree, p) {
  let n = tree;
  for (const part of p.split('/')) {
    n = n.files && n.files[part];
    if (!n) return null;
  }
  return n;
}

function addFileNode(tree, p, buf) {
  const parts = p.split('/');
  const name = parts.pop();
  let n = tree;
  for (const part of parts) {
    n.files[part] = n.files[part] || { files: {} };
    n = n.files[part];
  }
  n.files[name] = { size: buf.length, integrity: integrity(buf) };
}

// ---------- patching ----------

function patchDownloadJs(content) {
  const s = content.toString('utf8');
  if (s.includes(MARKER)) return { content, skipped: true };
  if (!s.includes(HOOK_ANCHOR)) return { content: null, error: 'download.js layout changed (unsupported app version)' };
  return { content: Buffer.from(s.replace(HOOK_ANCHOR, HOOK), 'utf8'), skipped: false };
}

function patchConfigJs(content) {
  const s = content.toString('utf8');
  if (s.includes(STORAGE_CHECK)) return { content, skipped: true };
  if (!s.includes(STORAGE_ANCHOR)) return { content: null, error: 'config.js layout changed (unsupported app version)' };
  return { content: Buffer.from(s.replace(STORAGE_ANCHOR, STORAGE_NEW), 'utf8'), skipped: false };
}

function findInstallDir(argDir) {
  const candidates = [];
  if (argDir) candidates.push(argDir);
  const la = process.env.LOCALAPPDATA || '';
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  candidates.push(
    path.join(la, 'Programs', 'Cambridge One Desktop App'),
    path.join(pf, 'Cambridge One Desktop App'),
    path.join(pf86, 'Cambridge One Desktop App'),
    path.join(la, 'Programs', 'CambridgeOne'),
    path.join(pf, 'CambridgeOne'),
  );
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'resources', 'app.asar'))) return c;
  }
  return null;
}

function restore(installDir) {
  const asar = path.join(installDir, 'resources', 'app.asar');
  const bak = asar + '.bak';
  if (!fs.existsSync(bak)) { console.error('No backup found at', bak); process.exit(1); }
  fs.copyFileSync(bak, asar);
  console.log('Restored original app.asar from backup.');
}

function patch(installDir) {
  const asarPath = path.join(installDir, 'resources', 'app.asar');
  const bakPath = asarPath + '.bak';
  const moduleSrc = path.join(__dirname, 'book-to-pdf.js');
  if (!fs.existsSync(moduleSrc)) { console.error('Missing book-to-pdf.js next to patch.js'); process.exit(1); }
  const moduleBuf = fs.readFileSync(moduleSrc);

  const fd = fs.openSync(asarPath, 'r');
  const { tree, dataStart } = readHeader(fd);
  const entries = [];

  // per-file transforms
  const replacements = new Map(); // path -> Buffer
  const errors = [];
  for (const rel of [DOWNLOAD_JS, CONFIG_JS]) {
    const node = getNode(tree, rel);
    if (!node) { errors.push(`${rel} not found in app.asar`); continue; }
    const buf = Buffer.alloc(node.size);
    fs.readSync(fd, buf, 0, node.size, dataStart + Number(node.offset));
    const res = rel === DOWNLOAD_JS ? patchDownloadJs(buf) : patchConfigJs(buf);
    if (res.error) { errors.push(res.error); continue; }
    if (res.skipped) { console.log(`- ${rel}: already patched`); continue; }
    node.size = res.content.length;
    node.integrity = integrity(res.content);
    replacements.set(rel, res.content);
    console.log(`+ ${rel}: patched`);
  }

  const existing = getNode(tree, MODULE_JS);
  if (!existing) {
    addFileNode(tree, MODULE_JS, moduleBuf);
    console.log(`+ ${MODULE_JS}: added`);
  } else {
    existing.size = moduleBuf.length;
    existing.integrity = integrity(moduleBuf);
    console.log(`+ ${MODULE_JS}: updated`);
  }
  replacements.set(MODULE_JS, moduleBuf);

  if (errors.length) {
    fs.closeSync(fd);
    console.error('Patch aborted:');
    errors.forEach(e => console.error(' -', e));
    process.exit(1);
  }

  // collect entries in walk order (new file included) and assign offsets
  (function walk(node, p) {
    for (const k in node.files || {}) {
      const f = node.files[k], fp = p ? p + '/' + k : k;
      if (f.link) continue;
      if (f.files) { walk(f, fp); continue; }
      if (f.unpacked) { delete f.offset; continue; }
      entries.push({ node: f, path: fp, origOffset: Number(f.offset) });
    }
  })(tree, '');

  let off = 0;
  for (const e of entries) { e.node.offset = String(off); off += e.node.size; }

  // write new archive
  const outPath = asarPath + '.new';
  const out = fs.openSync(outPath, 'w');
  const json = Buffer.from(JSON.stringify(tree));
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(json.length + 8, 4);
  head.writeUInt32LE(json.length + 4, 8);
  head.writeUInt32LE(json.length, 12);
  fs.writeSync(out, head);
  fs.writeSync(out, json);

  for (const e of entries) {
    const rep = replacements.get(e.path);
    if (rep) { fs.writeSync(out, rep); continue; }
    const buf = Buffer.alloc(e.node.size);
    fs.readSync(fd, buf, 0, e.node.size, dataStart + e.origOffset);
    fs.writeSync(out, buf);
  }
  fs.closeSync(out);
  fs.closeSync(fd);

  try {
    if (!fs.existsSync(bakPath)) fs.renameSync(asarPath, bakPath);
    fs.renameSync(outPath, asarPath);
  } catch (e) {
    fs.rmSync(outPath, { force: true });
    console.error('Could not replace app.asar - close the Cambridge One app first, then retry.');
    process.exit(1);
  }

  const appdata = process.env.APPDATA || '%APPDATA%';
  console.log('\nDone! Patch applied.');
  console.log('Backup of the original: ' + bakPath);
  console.log('After patching, downloaded books and generated PDFs go to:');
  console.log('  ' + path.join(appdata, 'CambridgeOne', 'books', '<productCode>') + '\\');
}

// ---------- main ----------

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = process.argv.slice(2).filter(a => a.startsWith('--'));
const installDir = findInstallDir(args[0]);

if (!installDir) {
  console.error('Could not find the Cambridge One install. Pass it explicitly:');
  console.error('  node patch.js "C:\\path\\to\\Cambridge One Desktop App"');
  process.exit(1);
}
console.log('Install dir:', installDir);

if (flags.includes('--restore')) restore(installDir);
else patch(installDir);
