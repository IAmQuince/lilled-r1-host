// Dependency-free QR Code encoder (ISO/IEC 18004): Byte mode, error-correction level L,
// versions 1-40, Reed-Solomon over GF(256) (poly 0x11D), mask selection by penalty score.
// Pure JavaScript: no Node built-ins, no I/O, no third-party code.
//
// This is the workbench's own implementation. It has been checked only by tools/qr-selftest.mjs
// (known-answer checks + a round-trip decoder that is also written in this workbench).
// It has NOT been checked against an external scanner.

export const ECC_LEVEL = 'L';
export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

// Level L only. Index = version (index 0 unused).
const ECC_CODEWORDS_PER_BLOCK_L = [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const NUM_BLOCKS_L = [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25];

// Format-information bits for level L are 01 (ISO/IEC 18004 table 12).
const ECC_FORMAT_BITS_L = 1;

function checkVersion(version) {
  if (!Number.isInteger(version) || version < MIN_VERSION || version > MAX_VERSION) {
    throw new RangeError(`QR version out of range: ${version}`);
  }
}

export function blockInfo(version) {
  checkVersion(version);
  return { numBlocks: NUM_BLOCKS_L[version], eccPerBlock: ECC_CODEWORDS_PER_BLOCK_L[version] };
}

export function symbolSize(version) {
  checkVersion(version);
  return version * 4 + 17;
}

export function alignmentPatternPositions(version) {
  checkVersion(version);
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const size = symbolSize(version);
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

export function numRawDataModules(version) {
  checkVersion(version);
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

export function numDataCodewords(version) {
  checkVersion(version);
  return Math.floor(numRawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK_L[version] * NUM_BLOCKS_L[version];
}

function charCountBits(version) {
  return version <= 9 ? 8 : 16;
}

// Maximum number of bytes that fit in Byte mode at level L for this version.
export function byteCapacity(version) {
  const bits = numDataCodewords(version) * 8 - 4 - charCountBits(version);
  return Math.floor(bits / 8);
}

// ---------- GF(256) / Reed-Solomon ----------

export function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xFF;
}

export function rsGeneratorPoly(degree) {
  if (degree < 1 || degree > 255) throw new RangeError('RS degree out of range');
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1; // coefficients, highest power first, leading 1 implicit
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

export function rsRemainder(data, generator) {
  const result = generator.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    generator.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor); });
  }
  return result;
}

// ---------- Format / version information ----------

export function formatBits(mask) {
  if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new RangeError('mask out of range');
  const data = (ECC_FORMAT_BITS_L << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

export function versionBits(version) {
  checkVersion(version);
  if (version < 7) return 0;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
  return (version << 12) | rem;
}

// ---------- Bit stream ----------

function appendBits(bits, value, count) {
  for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

export function utf8Bytes(text) {
  return Array.from(new TextEncoder().encode(String(text)));
}

export function buildDataCodewords(bytes, version) {
  const capacityBits = numDataCodewords(version) * 8;
  const bits = [];
  appendBits(bits, 0b0100, 4); // Byte mode indicator
  appendBits(bits, bytes.length, charCountBits(version));
  for (const b of bytes) appendBits(bits, b, 8);
  if (bits.length > capacityBits) throw new RangeError('Data does not fit in this version');
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length)); // terminator
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) appendBits(bits, pad, 8);
  const out = new Array(bits.length / 8).fill(0);
  bits.forEach((bit, i) => { out[i >>> 3] |= bit << (7 - (i & 7)); });
  return out;
}

export function addEccAndInterleave(data, version) {
  const numBlocks = NUM_BLOCKS_L[version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK_L[version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const generator = rsGeneratorPoly(blockEccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, generator);
    if (i < numShortBlocks) dat.push(0); // placeholder so all blocks line up; skipped when interleaving
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  if (result.length !== rawCodewords) throw new Error('Internal error: codeword count mismatch');
  return result;
}

// ---------- Matrix construction ----------

function makeGrid(size, value) {
  return Array.from({ length: size }, () => new Array(size).fill(value));
}

function drawFunctionPatterns(version, modules, isFunction) {
  const size = modules.length;
  const setFunc = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFunc(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const align = alignmentPatternPositions(version);
  const n = align.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunc(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  drawFormat(0, modules, isFunction); // reserve; real mask written later
  drawVersion(version, modules, isFunction);
}

function drawFormat(mask, modules, isFunction) {
  const size = modules.length;
  const bits = formatBits(mask);
  const bit = (i) => ((bits >>> i) & 1) !== 0;
  const setFunc = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };
  for (let i = 0; i <= 5; i++) setFunc(8, i, bit(i));
  setFunc(8, 7, bit(6));
  setFunc(8, 8, bit(7));
  setFunc(7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFunc(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) setFunc(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFunc(8, size - 15 + i, bit(i));
  setFunc(8, size - 8, true); // always-dark module
}

function drawVersion(version, modules, isFunction) {
  if (version < 7) return;
  const size = modules.length;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[b][a] = dark;
    isFunction[b][a] = true;
    modules[a][b] = dark;
    isFunction[a][b] = true;
  }
}

function drawCodewords(codewords, modules, isFunction) {
  const size = modules.length;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < codewords.length * 8) {
          modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
  if (i !== codewords.length * 8) throw new Error('Internal error: not all codeword bits placed');
}

export function maskCondition(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0;
    case 7: return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
    default: throw new RangeError('mask out of range');
  }
}

function applyMask(mask, modules, isFunction) {
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunction[y][x] && maskCondition(mask, x, y)) modules[y][x] = !modules[y][x];
    }
  }
}

// Penalty score per ISO/IEC 18004 section 7.8.3 (N1=3, N2=3, N3=40, N4=10).
export function penaltyScore(modules) {
  const size = modules.length;
  let result = 0;
  const lines = [];
  for (let y = 0; y < size; y++) lines.push(modules[y]);
  for (let x = 0; x < size; x++) lines.push(modules.map((row) => row[x]));
  // N1: runs of five or more same-colour modules; N3: 1:1:3:1:1 finder-like pattern with 4 light modules on a side.
  const finderA = '10111010000';
  const finderB = '00001011101';
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) result += 3 + (run - 5);
        run = 1;
      }
    }
    const s = line.map((v) => (v ? '1' : '0')).join('');
    for (let i = 0; i + 11 <= size; i++) {
      const w = s.substr(i, 11);
      if (w === finderA) result += 40;
      if (w === finderB) result += 40;
    }
  }
  // N2: 2x2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
    }
  }
  // N4: dark-module proportion.
  let dark = 0;
  for (const row of modules) for (const v of row) if (v) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * 10;
  return result;
}

// Encode text (UTF-8, Byte mode, ECC level L). Picks the smallest version that fits, at or above minVersion.
// Returns { version, size, mask, modules (rows of booleans, true = dark), dataCodewords, codewords, penalties, byteLength }.
export function encodeText(text, options = {}) {
  const minVersion = options.minVersion || MIN_VERSION;
  const maxVersion = options.maxVersion || MAX_VERSION;
  const bytes = utf8Bytes(text);
  let version = minVersion;
  while (version <= maxVersion && byteCapacity(version) < bytes.length) version++;
  if (version > maxVersion) {
    throw new RangeError(`Payload of ${bytes.length} bytes does not fit a QR code at error-correction level L (maximum ${byteCapacity(MAX_VERSION)} bytes at version ${MAX_VERSION}).`);
  }
  const dataCodewords = buildDataCodewords(bytes, version);
  const codewords = addEccAndInterleave(dataCodewords, version);
  const size = symbolSize(version);
  const modules = makeGrid(size, false);
  const isFunction = makeGrid(size, false);
  drawFunctionPatterns(version, modules, isFunction);
  drawCodewords(codewords, modules, isFunction);
  const penalties = [];
  let bestMask = 0;
  let bestPenalty = Infinity;
  const forced = options.mask;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask, modules, isFunction);
    drawFormat(mask, modules, isFunction);
    const p = penaltyScore(modules);
    penalties.push(p);
    if (forced === undefined ? p < bestPenalty : mask === forced) {
      bestMask = mask;
      bestPenalty = p;
    }
    applyMask(mask, modules, isFunction); // XOR again = undo
  }
  applyMask(bestMask, modules, isFunction);
  drawFormat(bestMask, modules, isFunction);
  return { version, size, mask: bestMask, modules, dataCodewords, codewords, penalties, byteLength: bytes.length, ecc: ECC_LEVEL };
}

// ---------- Renderers ----------

// SVG path made of one rectangle per horizontal run of dark modules. Crisp edges, scales freely.
export function toSvg(qr, options = {}) {
  const quiet = options.quietZone === undefined ? 4 : options.quietZone;
  const title = options.title ? String(options.title) : '';
  const total = qr.size + quiet * 2;
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (qr.modules[y][x]) {
        let end = x;
        while (end < qr.size && qr.modules[y][end]) end++;
        d += `M${x + quiet} ${y + quiet}h${end - x}v1h${-(end - x)}z`;
        x = end;
      } else {
        x++;
      }
    }
  }
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img"${title ? ` aria-label="${esc(title)}"` : ''}>`,
    title ? `<title>${esc(title)}</title>` : '',
    `<rect width="${total}" height="${total}" fill="#ffffff"/>`,
    `<path d="${d}" fill="#000000"/>`,
    '</svg>',
    ''
  ].filter((line, i, arr) => line !== '' || i === arr.length - 1).join('\n');
}


// Console rendering with a 2-module quiet zone.
// style 'block' (default): Unicode half blocks, two module rows per text row (compact). Light modules are
//   drawn as filled blocks, which gives the correct dark-on-light polarity on a dark console (the usual case).
// style 'plain': two characters per module ('##' dark, spaces light); wide but safe on any code page.
//   Its polarity is correct on a light console only.
// options.invert=true (block style) prints dark modules as filled blocks, for a light console.
export function toAscii(qr, options = {}) {
  const quiet = options.quietZone === undefined ? 2 : options.quietZone;
  const style = options.style || 'block';
  const total = qr.size + quiet * 2;
  const at = (x, y) => {
    const xx = x - quiet;
    const yy = y - quiet;
    return xx >= 0 && yy >= 0 && xx < qr.size && yy < qr.size && qr.modules[yy][xx];
  };
  const lines = [];
  if (style === 'plain') {
    for (let y = 0; y < total; y++) {
      let line = '';
      for (let x = 0; x < total; x++) line += at(x, y) ? '##' : '  ';
      lines.push(line);
    }
    return lines;
  }
  const lit = options.invert ? (x, y) => at(x, y) : (x, y) => !at(x, y);
  for (let y = 0; y < total; y += 2) {
    let line = '';
    for (let x = 0; x < total; x++) {
      const top = lit(x, y);
      const bottom = lit(x, y + 1);
      line += top && bottom ? '\u2588' : top ? '\u2580' : bottom ? '\u2584' : ' ';
    }
    lines.push(line);
  }
  return lines;
}
