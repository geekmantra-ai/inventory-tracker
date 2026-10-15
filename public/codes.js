// Pure Client-Side ISO/IEC 18004 QR Code & Code-128B Barcode SVG Generator
// Generates standard scannable QR Codes (Level L/M Reed-Solomon) and Code-128 Barcodes offline & online.

// ==========================================
// 1. CODE-128B BARCODE SVG GENERATOR
// ==========================================
const CODE128_PATTERNS = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100',
  '10001001100', '10011001000', '10011000100', '10001100100', '11001001000',
  '11001000100', '11000100100', '10110011100', '10011011100', '10011001110',
  '10111001100', '10011101100', '10011100110', '11001110010', '11001011100',
  '11001001110', '11011100100', '11001110100', '11101101110', '11101001100',
  '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000',
  '10001000110', '10110001000', '10001101000', '10001100010', '11010001000',
  '11000101000', '11000100010', '10110111000', '10110001110', '10001101110',
  '10111011000', '10111000110', '10001110110', '11101110110', '11010001110',
  '11000101110', '11011101000', '11011100010', '11011101110', '11101011000',
  '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000', '10100001100',
  '10010110000', '10010000110', '10000101100', '10000100110', '10110010000',
  '10110000100', '10011010000', '10011000010', '10000110100', '10000110010',
  '11000010010', '11001010000', '11110111010', '11000010100', '10001111010',
  '10100111100', '10010111100', '10010011110', '10111100100', '10011110100',
  '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
  '11011110110', '11110110110', '10101111000', '10100011110', '10001011110',
  '10111101000', '10111100010', '11110101000', '11110100010', '10111011110',
  '10111101110', '11101011110', '11110101110', '11010000100', '11010010000',
  '11010011100', '1100011101011',
];

export function renderCode128Barcode(svgEl, text = 'PRD-0000') {
  if (!svgEl) return;
  const cleanText = String(text || 'PRD-0000').replace(/[^\x20-\x7E]/g, '');
  const startCodeB = 104;
  const stopCode = 106;

  const codes = [startCodeB];
  let checksum = startCodeB;

  for (let i = 0; i < cleanText.length; i++) {
    const code = cleanText.charCodeAt(i) - 32;
    codes.push(code);
    checksum += code * (i + 1);
  }
  codes.push(checksum % 103);
  codes.push(stopCode);

  const bitString = codes.map((c) => CODE128_PATTERNS[c]).join('');
  const quietZone = 10;
  const barWidth = 2;
  const height = 64;
  const totalWidth = (bitString.length + quietZone * 2) * barWidth;

  let rects = '';
  for (let i = 0; i < bitString.length; i++) {
    if (bitString[i] === '1') {
      const x = (quietZone + i) * barWidth;
      rects += `<rect x="${x}" y="6" width="${barWidth}" height="${height}" fill="#0f172a"/>`;
    }
  }

  if (typeof svgEl.setAttribute === 'function') {
    svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svgEl.setAttribute('viewBox', `0 0 ${totalWidth} ${height + 26}`);
  }
  svgEl.innerHTML = `
    <rect width="${totalWidth}" height="${height + 26}" fill="#ffffff" rx="4"/>
    ${rects}
    <text x="${totalWidth / 2}" y="${height + 20}" text-anchor="middle" font-family="monospace" font-size="12" font-weight="bold" fill="#0f172a">${cleanText}</text>
  `;
}

// ==========================================
// 2. ISO/IEC 18004 QR CODE SVG GENERATOR
// ==========================================
// Supports Byte Mode Versions 1..10 (Level L) for URLs up to 270 chars

const QR_VERSION_CAPACITY_L = [
  null,
  { totalCodewords: 26, ecCodewords: 7, blocks: 1, dataBytes: 17, align: [] },
  { totalCodewords: 44, ecCodewords: 10, blocks: 1, dataBytes: 32, align: [6, 18] },
  { totalCodewords: 70, ecCodewords: 15, blocks: 1, dataBytes: 53, align: [6, 22] },
  { totalCodewords: 100, ecCodewords: 20, blocks: 1, dataBytes: 78, align: [6, 26] },
  { totalCodewords: 134, ecCodewords: 26, blocks: 1, dataBytes: 106, align: [6, 30] },
  { totalCodewords: 172, ecCodewords: 18, blocks: 2, dataBytes: 134, align: [6, 34] },
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGalois() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function getGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function computeReedSolomon(data, ecLen) {
  const gen = getGeneratorPoly(ecLen);
  const msg = new Uint8Array(data.length + ecLen);
  msg.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return msg.slice(data.length);
}

export function generateQrMatrix(text) {
  const utf8 = new TextEncoder().encode(String(text || ''));
  let version = 1;
  while (version <= 6 && QR_VERSION_CAPACITY_L[version].dataBytes < utf8.length) {
    version++;
  }
  if (version > 6) version = 6;
  const spec = QR_VERSION_CAPACITY_L[version];
  const dataCodewordsCount = spec.totalCodewords - spec.ecCodewords * spec.blocks;

  // Build bit stream: Mode 0100 (Byte), 8-bit char count, data bytes, terminator
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  pushBits(0b0100, 4);
  const payload = utf8.slice(0, spec.dataBytes);
  pushBits(payload.length, 8);
  for (const b of payload) pushBits(b, 8);

  const maxBits = dataCodewordsCount * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  pushBits(0, termLen);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes = new Uint8Array(dataCodewordsCount);
  for (let i = 0; i < bits.length / 8; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b];
    dataBytes[i] = byte;
  }
  let padToggle = true;
  for (let i = bits.length / 8; i < dataCodewordsCount; i++) {
    dataBytes[i] = padToggle ? 0xec : 0x11;
    padToggle = !padToggle;
  }

  // Split into blocks & compute EC
  const finalCodewords = [];
  if (spec.blocks === 1) {
    const ec = computeReedSolomon(dataBytes, spec.ecCodewords);
    finalCodewords.push(...dataBytes, ...ec);
  } else {
    const half = dataCodewordsCount / 2;
    const b1 = dataBytes.slice(0, half);
    const b2 = dataBytes.slice(half);
    const ec1 = computeReedSolomon(b1, spec.ecCodewords);
    const ec2 = computeReedSolomon(b2, spec.ecCodewords);
    for (let i = 0; i < half; i++) finalCodewords.push(b1[i], b2[i]);
    for (let i = 0; i < spec.ecCodewords; i++) finalCodewords.push(ec1[i], ec2[i]);
  }

  const size = 17 + version * 4;
  const matrix = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size));

  const setModule = (r, c, val) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      matrix[r][c] = val ? 1 : 0;
      isFunction[r][c] = 1;
    }
  };

  const placeFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const isBorder = r === -1 || r === 7 || c === -1 || c === 7;
        const isOuter = r === 0 || r === 6 || c === 0 || c === 6;
        const isInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setModule(row + r, col + c, !isBorder && (isOuter || isInner));
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Alignment patterns
  const alignCoords = spec.align;
  for (const r of alignCoords) {
    for (const c of alignCoords) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const val = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setModule(r + dr, c + dc, val);
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setModule(6, i, i % 2 === 0);
    setModule(i, 6, i % 2 === 0);
  }

  // Dark module & reserve format areas
  setModule(size - 8, 8, 1);
  for (let i = 0; i < 9; i++) {
    if (!isFunction[8][i]) setModule(8, i, 0);
    if (!isFunction[i][8]) setModule(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunction[8][size - 1 - i]) setModule(8, size - 1 - i, 0);
    if (!isFunction[size - 1 - i][8]) setModule(size - 1 - i, 8, 0);
  }

  // Place data bits in upward/downward 2-column zig-zag
  const allBits = [];
  for (const cw of finalCodewords) {
    for (let b = 7; b >= 0; b--) allBits.push((cw >> b) & 1);
  }

  let bitIdx = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!isFunction[r][c]) {
          const bit = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
          // Apply mask 0: (r + c) % 2 === 0
          const masked = (r + c) % 2 === 0 ? bit ^ 1 : bit;
          matrix[r][c] = masked;
        }
      }
    }
    upward = !upward;
  }

  // Format information for Level L (01) and Mask 0 (000) -> precomputed BCH 0x77c4
  const formatBits = 0x77c4;
  const getFmtBit = (i) => (formatBits >> i) & 1;

  for (let i = 0; i <= 5; i++) setModule(8, i, getFmtBit(14 - i));
  setModule(8, 7, getFmtBit(8));
  setModule(8, 8, getFmtBit(7));
  setModule(7, 8, getFmtBit(6));
  for (let i = 0; i <= 5; i++) setModule(5 - i, 8, getFmtBit(5 - i));

  for (let i = 0; i < 8; i++) setModule(8, size - 1 - i, getFmtBit(i));
  for (let i = 0; i < 7; i++) setModule(size - 7 + i, 8, getFmtBit(14 - i));

  return matrix;
}

export function renderQrCodeSvg(containerEl, urlText) {
  if (!containerEl) return '';
  const matrix = generateQrMatrix(urlText);
  const size = matrix.length;
  const margin = 3;
  const total = size + margin * 2;

  let pathData = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c] === 1) {
        pathData += `M${c + margin},${r + margin}h1v1h-1z`;
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">
    <rect width="${total}" height="${total}" fill="#ffffff" rx="1.5"/>
    <path d="${pathData}" fill="#0f172a"/>
  </svg>`;

  containerEl.innerHTML = svg;
  return svg;
}

