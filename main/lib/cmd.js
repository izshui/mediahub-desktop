'use strict';
/**
 * 外部命令执行器（忠实移植 PHP CommandRunner）。
 * 统一处理：超时、退出码、stdout/stderr 捕获、实时逐行进度回调。
 * 不使用 shell，避免注入。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function which(bin) {
  if (!bin) return null;
  if (bin.includes(path.sep)) {
    return fs.existsSync(bin) && fs.statSync(bin).isFile() ? bin : null;
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, bin + ext);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
  }
  return null;
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
    } else if (child.pid) {
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch (e) { /* ignore */ }
}

/**
 * 执行命令并返回结果（捕获全部输出）。
 * @param {string[]} args
 * @param {object} opts {timeout, cwd, env, input, maxBuffer}
 */
function run(args, opts = {}) {
  const timeout = opts.timeout || 3600;
  const start = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(args[0], args.slice(1), {
        cwd: opts.cwd || undefined,
        env: opts.env || process.env,
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ code: 127, stdout: '', stderr: String(e.message || e), timed_out: false });
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      killTree(child);
      resolve({ code: 124, stdout, stderr: stderr + '\n[超时] 命令超过 ' + timeout + ' 秒被终止', timed_out: true });
    }, timeout * 1000);

    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }

    const maxBuffer = opts.maxBuffer || 200 * 1024 * 1024;
    let bufSize = 0;
    child.stdout.on('data', (d) => {
      bufSize += d.length;
      if (bufSize <= maxBuffer) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (e) => { stderr += '\n' + e.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code === null ? 1 : code, stdout, stderr, timed_out: false });
    });
  });
}

/**
 * 逐行流式执行，常用于进度回调。onLine(line, stream)。
 * @param {function} onLine fn(string line)
 */
function stream(args, onLine, opts = {}) {
  const timeout = opts.timeout || 3600;
  const start = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(args[0], args.slice(1), {
        cwd: opts.cwd || undefined,
        env: opts.env || process.env,
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ code: 127, stdout: '', stderr: String(e.message || e), timed_out: false });
    }

    let buffer = '';
    let stdoutBuf = '';
    let stderrBuf = '';
    let timer = null;
    let settled = false;
    let paused = false;

    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const armTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        killTree(child);
        finish({ code: 124, stdout: stdoutBuf, stderr: stderrBuf + '\n[超时] 命令超过 ' + timeout + ' 秒被终止', timed_out: true });
      }, timeout * 1000);
    };
    armTimer();

    // ---- 暂停 / 继续控制 ----
    // Unix/macOS：用进程组信号冻结整个进程组（含 yt-dlp 拉起的 ffmpeg 子进程）；
    // Windows：向 stdin 写入 yt-dlp 的交互指令（P 暂停 / R 继续）。
    if (opts.control) {
      const c = opts.control;
      c.pid = child.pid;
      c.paused = false;
      c.pause = () => {
        if (paused || settled) return false;
        try {
          if (process.platform === 'win32') {
            if (!child.stdin || !child.stdin.writable) return false;
            child.stdin.write('P');
          } else {
            process.kill(-child.pid, 'SIGSTOP');
            if (timer) { clearTimeout(timer); timer = null; }
          }
          paused = true;
          c.paused = true;
          return true;
        } catch (e) { return false; }
      };
      c.resume = () => {
        if (!paused || settled) return false;
        try {
          if (process.platform === 'win32') {
            if (!child.stdin || !child.stdin.writable) return false;
            child.stdin.write('R');
          } else {
            process.kill(-child.pid, 'SIGCONT');
            armTimer();
          }
          paused = false;
          c.paused = false;
          return true;
        } catch (e) { return false; }
      };
      c.stop = () => { try { killTree(child); } catch (e) {} };
    }

    const handle = (data, streamName) => {
      const text = data.toString('utf8');
      if (streamName === 'stdout') stdoutBuf += text; else stderrBuf += text;
      buffer += text;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        onLine(line, streamName);
      }
    };
    child.stdout.on('data', (d) => handle(d, 'stdout'));
    child.stderr.on('data', (d) => handle(d, 'stderr'));
    child.on('error', (e) => onLine(String(e.message), 'stderr'));
    child.on('close', (code) => {
      if (buffer.trim() !== '') onLine(buffer.replace(/\r$/, ''), 'stderr');
      finish({ code: code === null ? 1 : code, stdout: stdoutBuf, stderr: stderrBuf, timed_out: false });
    });
  });
}

module.exports = { which, run, stream, killTree };
