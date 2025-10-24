
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node tools/anchorPatch.js <manifest.json> [--dry|--revert]');
  process.exit(1);
}
const manifestPath = args[0];
const DRY = args.includes('--dry');
const REVERT = args.includes('--revert');

function read(p){ return fs.readFileSync(p, 'utf8'); }
function write(p,s){ fs.writeFileSync(p,s,'utf8'); }
function backupPath(p){ return `${p}.bak`; }

function ensureBackup(file){
  const bak = backupPath(file);
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
}
function revertFile(file){
  const bak = backupPath(file);
  if (!fs.existsSync(bak)) throw new Error(`No backup for ${file}`);
  const src = read(bak);
  if (!DRY) write(file, src);
  return {file, reverted:true};
}

// ----- spacing & EOL helpers -----
function detectEOL(text){
  return text.includes('\r\n') ? '\r\n' : '\n';
}
function getLineStartIndex(text, idx){
  const i = text.lastIndexOf('\n', idx - 1);
  if (i === -1) return 0;
  return i + 1;
}
function currentIndent(text, atIndex){
  const start = getLineStartIndex(text, atIndex);
  let i = start;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return text.slice(start, i);
}
function autoIndent(payload, indent, eol){
  if (!payload.includes('\n')) return payload;
  const lines = payload.split(/\r?\n/);
  return lines.map((ln, idx) => (idx === 0 ? ln : indent + ln)).join(eol);
}

// ----- operations -----
function insertAfter(src, anchor, insert, {auto=false}={}){
  const idx = src.indexOf(anchor);
  if (idx === -1) throw new Error('anchor not found (insertAfter)');
  const cut = idx + anchor.length;
  const eol = detectEOL(src);
  const indent = currentIndent(src, cut);
  const payload = auto ? autoIndent(insert, indent, eol) : insert;
  return src.slice(0, cut) + payload + src.slice(cut);
}
function insertBefore(src, anchor, insert, {auto=false}={}){
  const idx = src.indexOf(anchor);
  if (idx === -1) throw new Error('anchor not found (insertBefore)');
  const eol = detectEOL(src);
  const indent = currentIndent(src, idx);
  const payload = auto ? autoIndent(insert, indent, eol) : insert;
  return src.slice(0, idx) + payload + src.slice(idx);
}
function replaceOnce(src, before, after){
  const idx = src.indexOf(before);
  if (idx === -1) throw new Error('before block not found (replaceOnce)');
  return src.slice(0, idx) + after + src.slice(idx + before.length);
}
// regex-based replacement (spacing-insensitive)
function replaceBlockRx(src, beforeRx, after, flags='m'){
  const rx = new RegExp(beforeRx, flags);
  if (!rx.test(src)) throw new Error('beforeRx not found (replaceBlockRx)');
  return src.replace(rx, after);
}
function replaceBetween(src, startAnchor, endAnchor, replacement){
  const a = src.indexOf(startAnchor);
  if (a === -1) throw new Error('startAnchor not found (replaceBetween)');
  const b = src.indexOf(endAnchor, a + startAnchor.length);
  if (b === -1) throw new Error('endAnchor not found (replaceBetween)');
  return src.slice(0, a + startAnchor.length) + replacement + src.slice(b);
}

function applyOp(src, op){
  const {type} = op;
  if (type === 'insertAfter')    return insertAfter(src, op.anchor, op.payload, {auto: !!op.autoIndent});
  if (type === 'insertBefore')   return insertBefore(src, op.anchor, op.payload, {auto: !!op.autoIndent});
  if (type === 'replaceBlock')   return replaceOnce(src, op.before, op.after);
  if (type === 'replaceBlockRx') return replaceBlockRx(src, op.beforeRx, op.after, op.flags || 'm');
  if (type === 'replaceBetween') return replaceBetween(src, op.startAnchor, op.endAnchor, op.payload);
  if (type === 'append')         return src + op.payload;
  throw new Error(`Unknown op type: ${type}`);
}

// ----- main -----
function run(){
  const manifest = JSON.parse(read(manifestPath));
  const results = [];

  // files patching
  for (const filePatch of (manifest.files || [])){
    const file = path.resolve(filePatch.path);
    if (REVERT){
      try {
        results.push(revertFile(file));
      } catch (e){
        results.push({file, status:'error', msg:e.message});
        throw e;
      }
      continue;
    }

    if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
    const original = read(file);
    let src = original;

    for (const [i,op] of (filePatch.ops || []).entries()){
      try{
        src = applyOp(src, op);
        results.push({file, op:i, status:'ok', type:op.type});
      }catch(e){
        results.push({file, op:i, status:'error', type:op.type, msg:e.message});
        throw e;
      }
    }

    if (!DRY){
      ensureBackup(file);
      write(file, src);
    }
  }

  // cssOps (optional)
  for (const cssOp of (manifest.cssOps || [])){
    const file = path.resolve(cssOp.path);
    if (REVERT){
      try {
        results.push(revertFile(file));
      } catch (e){
        results.push({file, status:'error', msg:e.message});
        throw e;
      }
      continue;
    }
    const original = fs.existsSync(file) ? read(file) : '';
    let src = original;
    if (cssOp.type === 'append') src = original + cssOp.payload;
    else throw new Error(`Unknown cssOp type: ${cssOp.type}`);
    if (!DRY){
      ensureBackup(file);
      write(file, src);
    }
    results.push({file, status:'ok', type:'css-append'});
  }

  console.log(JSON.stringify({ok:true, dry:DRY, revert:REVERT, results}, null, 2));
}

try { run(); }
catch(e){
  console.error(JSON.stringify({ok:false, error:e.message}, null, 2));
  process.exit(1);
}