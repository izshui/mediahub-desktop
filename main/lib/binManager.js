'use strict';
/**
 * 二进制依赖管理：探测 yt-dlp / ffmpeg / ffprobe，缺失时自动下载到用户数据目录。
 * 保证桌面版"安装即用"，不再要求用户手动配置 PATH。
 *
 * 可靠性要点：
 *  1) 下载后校验文件类型（magic bytes），防止把 HTML 错误页当成二进制；
 *  2) 解压命令检查退出码，失败立即报错（不静默吞掉）；
 *  3) ffmpeg 与 ffprobe 独立安装，互不影响（ffprobe 为可选依赖）。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { which, run } = require('./cmd');

const FFMPEG_STATIC_BASE = 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/';

function resolveBinary(name, settings) {
  const explicit = settings && settings[name];
  if (explicit && explicit.trim() !== '') {
    if (fs.existsSync(explicit) && fs.statSync(explicit).isFile()) return explicit;
  }
  if (which(name)) return which(name);
  return null;
}

function checkBinaries(settings) {
  return {
    ytDlp: resolveBinary('yt_dlp', settings) || resolveBinary('yt-dlp', settings) || which('yt-dlp'),
    ffmpeg: resolveBinary('ffmpeg', settings) || which('ffmpeg'),
    ffprobe: resolveBinary('ffprobe', settings) || which('ffprobe'),
  };
}

// ---------------- 文件类型校验 ----------------
function readHead(file, n) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return read === n ? buf : buf.slice(0, read);
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

const EXEC_MAGIC = ['cffaedfe', 'cefaedfe', 'cafebabe', 'feedfacf', 'feedface', '7f454c46', '4d5a'];

/** 是否为可执行文件（Mach-O / ELF / PE） */
function isExecutableFile(file) {
  const b = readHead(file, 4);
  return !!b && EXEC_MAGIC.includes(b.toString('hex'));
}

/** 是否为 zip（PK 头） */
function isZipFile(file) {
  const b = readHead(file, 4);
  return !!b && b.toString('hex') === '504b0304';
}

/** 是否为 gzip（tar.gz） */
function isGzipFile(file) {
  const b = readHead(file, 2);
  return !!b && b.toString('hex') === '1f8b';
}

// ---------------- 下载 ----------------
function curlPath() {
  const w = which('curl');
  if (w) return w;
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/curl')) return '/usr/bin/curl';
  if (process.platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\curl.exe')) return 'C:\\Windows\\System32\\curl.exe';
  return null;
}

function downloadFile(url, dest, onProgress, proxy) {
  // 优先用 curl：自动读取环境变量代理，也支持显式 -x 代理；无 curl 时回退 Node https（不走代理）
  proxy = proxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  return new Promise((resolve, reject) => {
    const curl = curlPath();
    if (curl) {
      const args = ['-L', '--fail', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20', '-o', dest];
      if (proxy) args.push('-x', proxy);
      args.push(url);
      let stderr = '';
      const p = spawn(curl, args);
      p.stderr.on('data', (d) => { stderr += d.toString(); });
      p.on('error', (e) => reject(e));
      p.on('close', (code) => {
        if (code === 0) { if (onProgress) onProgress(100, 1, 1); resolve(dest); }
        else reject(new Error('curl 下载失败（exit ' + code + '）：' + stderr.slice(-300)));
      });
      return;
    }
    // 回退：Node https（不支持代理）
    const doGet = (u, redirects) => {
      if (redirects > 6) return reject(new Error('重定向过多'));
      https.get(u, { headers: { 'User-Agent': 'MediaHub/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return doGet(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('下载失败，HTTP ' + res.statusCode));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total && onProgress) onProgress(Math.min(99, Math.round(received / total * 100)), received, total);
        });
        res.pipe(out);
        out.on('finish', () => { out.close(() => resolve(dest)); });
      }).on('error', reject);
    };
    doGet(url, 0);
  });
}

// ---------------- 安装 ----------------
function platformKey() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return 'win32-x64';
  if (process.platform === 'darwin') return 'darwin-' + arch;
  return 'linux-' + arch;
}

function findBinary(dir, names) {
  let found = null;
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (!found && names.includes(f)) found = p;
    }
  };
  try { walk(dir); } catch (e) {}
  return found;
}

/**
 * 按候选源列表安装单个二进制，逐个尝试直到成功。
 * source.kind: 'binary' | 'tgz' | 'zip'
 */
async function installOne(dest, sources, proxy, onProgress, opts = {}) {
  const errors = [];
  for (const s of sources) {
    const tmp = dest + '.part';
    try {
      await downloadFile(s.url, tmp, onProgress, proxy);

      if (s.kind === 'binary') {
        // yt-dlp_macos 是 zipapp（PK 头），其余为原生可执行文件
        const ok = opts.acceptZipApp ? (isExecutableFile(tmp) || isZipFile(tmp)) : isExecutableFile(tmp);
        if (!ok) throw new Error('下载内容不是可执行文件（疑似错误页面）');
        fs.renameSync(tmp, dest);
      } else if (s.kind === 'tgz') {
        if (!isGzipFile(tmp)) throw new Error('下载内容不是有效的 tar.gz');
        const dir = dest + '_x';
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        const r = await run(['tar', '-xzf', tmp, '-C', dir], { timeout: 180 });
        if (r.code !== 0) throw new Error('解压失败：' + (r.stderr || '').trim().slice(0, 200));
        const inner = path.join(dir, 'package', s.inner);
        if (!fs.existsSync(inner)) throw new Error('压缩包内未找到 ' + s.inner);
        fs.copyFileSync(inner, dest);
        fs.rmSync(dir, { recursive: true, force: true });
      } else if (s.kind === 'zip') {
        if (!isZipFile(tmp)) throw new Error('下载内容不是有效的 zip');
        const dir = dest + '_x';
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        if (process.platform === 'win32') {
          await new Promise((resolve, reject) => {
            const p = spawn('powershell', ['-NoProfile', '-Command',
              `Expand-Archive -Force -Path "${tmp}" -DestinationPath "${dir}"`], { windowsHide: true });
            p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('解压失败'))));
          });
        } else {
          const r = await run(['unzip', '-o', tmp, '-d', dir], { timeout: 180 });
          if (r.code !== 0) throw new Error('解压失败：' + (r.stderr || '').trim().slice(0, 200));
        }
        const hit = findBinary(dir, opts.names || []);
        if (!hit) throw new Error('压缩包内未找到 ' + (opts.names || []).join('/'));
        fs.copyFileSync(hit, dest);
        fs.rmSync(dir, { recursive: true, force: true });
      }

      if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
      return dest;
    } catch (e) {
      errors.push(s.url + ' → ' + (e.message || e));
      try { fs.unlinkSync(tmp); } catch (x) {}
      try { fs.rmSync(dest + '_x', { recursive: true, force: true }); } catch (x) {}
    }
  }
  throw new Error(errors.join('\n'));
}

// ---------------- yt-dlp ----------------
function platformYtDlpUrl() {
  if (process.platform === 'win32') return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
}

async function installYtDlp(userDataDir, onProgress, proxy) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const dest = path.join(userDataDir, binName);
  const sources = [
    { kind: 'binary', url: platformYtDlpUrl() },
    { kind: 'binary', url: 'https://ghproxy.com/' + platformYtDlpUrl() },
  ];
  try {
    return await installOne(dest, sources, proxy, onProgress, { acceptZipApp: true });
  } catch (e) {
    throw new Error('yt-dlp 下载失败：\n' + (e.message || e));
  }
}

// ---------------- ffmpeg / ffprobe ----------------
function ffmpegSources(file) {
  const plat = platformKey();
  const winExe = process.platform === 'win32' ? '.exe' : '';
  const list = [{ kind: 'binary', url: FFMPEG_STATIC_BASE + file + '-' + plat + winExe }];

  if (process.platform === 'darwin') {
    const a = process.arch === 'arm64' ? 'arm64' : 'x64';
    list.push({
      kind: 'tgz',
      url: `https://registry.npmmirror.com/@${file}-installer/darwin-${a}/-/darwin-${a}-4.1.0.tgz`,
      inner: file,
    });
  }
  if (process.platform === 'win32') {
    list.push({
      kind: 'zip',
      url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
      names: [file + '.exe'],
    });
  }
  return list;
}

/**
 * 安装 ffmpeg 与 ffprobe。两者独立：ffprobe 失败不影响 ffmpeg（ffprobe 为可选依赖）。
 * 返回 { installed: [...], failed: [...] }
 */
async function installFFmpeg(userDataDir, onProgress, proxy) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const winExe = process.platform === 'win32' ? '.exe' : '';
  const installed = [];
  const failed = [];
  for (const file of ['ffmpeg', 'ffprobe']) {
    const dest = path.join(userDataDir, file + winExe);
    try {
      await installOne(dest, ffmpegSources(file), proxy, onProgress);
      installed.push(file);
    } catch (e) {
      failed.push(file + '：' + (e.message || e));
    }
  }
  if (installed.length === 0) {
    throw new Error('ffmpeg / ffprobe 安装失败（所有下载源均不可用）：\n' + failed.join('\n'));
  }
  return { installed, failed };
}

module.exports = {
  checkBinaries, resolveBinary,
  installYtDlp, installFFmpeg,
  platformYtDlpUrl, platformKey,
  isExecutableFile, isZipFile, isGzipFile,
};
