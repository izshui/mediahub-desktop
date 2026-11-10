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
    const timer = setTimeout(() => {
      killTree(child);
      resolve({ code: 124, stdout: '', stderr: '超时', timed_out: true });
    }, timeout * 1000);

    const handle = (data, stream) => {
      buffer += data.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        onLine(line, stream);
      }
    };
    child.stdout.on('data', (d) => handle(d, 'stdout'));
    child.stderr.on('data', (d) => handle(d, 'stderr'));
    child.on('error', (e) => onLine(String(e.message), 'stderr'));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buffer.trim() !== '') onLine(buffer.replace(/\r$/, ''), 'stderr');
      resolve({ code: code === null ? 1 : code, stdout: '', stderr: '', timed_out: false });
    });
  });
}

module.exports = { which, run, stream, killTree };
