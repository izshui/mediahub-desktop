'use strict';
/**
 * 从 build/icon-source.jpg 生成各平台应用图标（Vido 黑翼下载图标）。
 *  - build/icon.png  : 1024x1024 透明底 PNG
 *  - build/icon.icns : macOS 图标（iconutil）
 *  - build/icon.ico  : Windows 图标（PIL）
 * 需要 python3 + Pillow（pip install pillow）；icns 使用 macOS 自带 iconutil。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const SRC = path.join(BUILD, 'icon-source.jpg');
const OUT_PNG = path.join(BUILD, 'icon.png');
const OUT_ICNS = path.join(BUILD, 'icon.icns');
const OUT_ICO = path.join(BUILD, 'icon.ico');

if (!fs.existsSync(SRC)) {
  console.error('✗ 缺少图标源文件：' + SRC);
  process.exit(1);
}

const py = `
from PIL import Image
import sys
src, out_png, out_ico = sys.argv[1], sys.argv[2], sys.argv[3]
S = 1024
img = Image.open(src).convert('RGBA')
w, h = img.size
px = img.load()
# 1) 近白背景转透明（保留主体）
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        mn = min(r, g, b)
        if mn >= 246: alpha = 0
        elif mn <= 225: alpha = 255
        else:
            t = (mn - 225) / (246 - 225)
            alpha = int(255 * (1 - t))
        if alpha < a: px[x, y] = (r, g, b, alpha)
bbox = img.getbbox()
if bbox: img = img.crop(bbox)
cw, ch = img.size
target = int(S * 0.86)
scale = min(target / cw, target / ch)
nw, nh = int(cw * scale), int(ch * scale)
img = img.resize((nw, nh), Image.LANCZOS)
canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))
canvas.alpha_composite(img, ((S - nw) // 2, (S - nh) // 2))
canvas.save(out_png)
# Windows ico：多尺寸
canvas.save(out_ico, sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
print('PNG + ICO ready')
`;

const tmpPy = path.join(os.tmpdir(), 'vido_icon_gen_' + process.pid + '.py');
fs.writeFileSync(tmpPy, py);
try {
  execFileSync('python3', [tmpPy, SRC, OUT_PNG, OUT_ICO], { stdio: 'inherit' });

  if (process.platform === 'darwin') {
    // iconutil 要求目录名以 .iconset 结尾
    const iconDir = path.join(os.tmpdir(), 'vido-' + process.pid + '.iconset');
    fs.rmSync(iconDir, { recursive: true, force: true });
    fs.mkdirSync(iconDir, { recursive: true });
    const sizes = {
      'icon_16x16.png': 16, 'icon_16x16@2x.png': 32,
      'icon_32x32.png': 32, 'icon_32x32@2x.png': 64,
      'icon_128x128.png': 128, 'icon_128x128@2x.png': 256,
      'icon_256x256.png': 256, 'icon_256x256@2x.png': 512,
      'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024,
    };
    const py2 = `
from PIL import Image
import sys
im = Image.open(sys.argv[1]).convert('RGBA')
d = sys.argv[2]
for name, s in ${JSON.stringify(sizes)}.items():
    im.resize((s, s), Image.LANCZOS).save(d + '/' + name)
`;
    const tmpPy2 = path.join(os.tmpdir(), 'vido_iconset_' + process.pid + '.py');
    fs.writeFileSync(tmpPy2, py2);
    execFileSync('python3', [tmpPy2, OUT_PNG, iconDir], { stdio: 'inherit' });
    execFileSync('iconutil', ['-c', 'icns', iconDir, '-o', OUT_ICNS], { stdio: 'inherit' });
    fs.rmSync(iconDir, { recursive: true, force: true });
  }
  console.log('✓ 图标已生成：');
  for (const f of [OUT_PNG, OUT_ICNS, OUT_ICO]) {
    if (fs.existsSync(f)) console.log('  ' + path.relative(ROOT, f) + ' (' + fs.statSync(f).size + ' bytes)');
  }
} finally {
  try { fs.unlinkSync(tmpPy); } catch (e) {}
}
