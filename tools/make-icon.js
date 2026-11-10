'use strict';
/**
 * 生成应用图标 build/icon.png（1024x1024，纯 Node zlib 编码 PNG，无第三方依赖）。
 * 图形：圆角方形渐变底 + 白色播放三角，MediaHub 的媒体工具意象。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;

// ---------- PNG 编码 ----------
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 几何 ----------
function roundedRectSDF(x, y, halfW, halfH, r) {
  const qx = Math.abs(x) - (halfW - r);
  const qy = Math.abs(y) - (halfH - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function edge(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function inTriangle(px, py, a, b, c) {
  const d1 = edge(px, py, a[0], a[1], b[0], b[1]);
  const d2 = edge(px, py, b[0], b[1], c[0], c[1]);
  const d3 = edge(px, py, c[0], c[1], a[0], a[1]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// ---------- 绘制 ----------
const TOP = [0x4F, 0x7C, 0xFF];   // #4F7CFF
const BOT = [0x8B, 0x5C, 0xF6];   // #8B5CF6

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const half = SIZE / 2;
  const rectHalf = SIZE * 0.455;
  const radius = SIZE * 0.225;

  // 播放三角形（尖端朝右 = 标准播放符号，视觉重心居中）
  const t = SIZE * 0.30;
  const triEdgeX = half - SIZE * 0.115;
  const triA = [triEdgeX, half - t * 0.78];
  const triB = [triEdgeX, half + t * 0.78];
  const triC = [triEdgeX + t * 1.18, half];

  const SS = 3; // 每像素 3x3 超采样抗锯齿
  const step = 1 / SS;

  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) * step - half;
          const y = py + (sy + 0.5) * step - half;

          const d = roundedRectSDF(x, y, rectHalf, rectHalf, radius);
          if (d > 0.6) continue; // 圆角外

          // 垂直渐变 + 轻微径向高光
          const k = Math.min(1, Math.max(0, (py / SIZE) * 0.85 + 0.15));
          let r = TOP[0] + (BOT[0] - TOP[0]) * k;
          let g = TOP[1] + (BOT[1] - TOP[1]) * k;
          let b = TOP[2] + (BOT[2] - TOP[2]) * k;
          const hl = Math.max(0, 1 - Math.hypot(x + SIZE * 0.16, y + SIZE * 0.2) / (SIZE * 0.72));
          const boost = hl * hl * 46;
          r = Math.min(255, r + boost);
          g = Math.min(255, g + boost);
          b = Math.min(255, b + boost);

          // 白色播放三角
          if (inTriangle(px + (sx + 0.5) * step, py + (sy + 0.5) * step, triA, triB, triC)) {
            r = 255; g = 255; b = 255;
          }

          rSum += r; gSum += g; bSum += b; aSum += 255;
        }
      }
      const n = SS * SS;
      const off = (py * SIZE + px) * 4;
      const alpha = aSum / n;
      if (alpha === 0) { rgba[off + 3] = 0; continue; }
      const cov = aSum / 255 / n;
      rgba[off] = Math.round(rSum / (n * cov));
      rgba[off + 1] = Math.round(gSum / (n * cov));
      rgba[off + 2] = Math.round(bSum / (n * cov));
      rgba[off + 3] = Math.round(alpha);
    }
  }
  return rgba;
}

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePng(SIZE, SIZE, render()));
console.log('已生成 ' + out + ' (' + fs.statSync(out).size + ' bytes)');
