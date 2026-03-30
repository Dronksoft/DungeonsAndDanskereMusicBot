'use strict';

/**
 * Thin logger that mirrors output to the console and keeps a rolling buffer
 * of the last MAX_LINES entries so they can be shown in !debug.
 */

const MAX_LINES = 30;
const _buffer = [];

function _ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function _record(level, ...args) {
  const text = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const line = `[${_ts()}] ${level} ${text}`;
  _buffer.push(line);
  if (_buffer.length > MAX_LINES) _buffer.shift();
  return line;
}

const log = (...args) => {
  const line = _record('INF', ...args);
  process.stdout.write(line + '\n');
};

const warn = (...args) => {
  const line = _record('WRN', ...args);
  process.stderr.write(line + '\n');
};

const error = (...args) => {
  // args may include an Error object — extract its message + stack
  const parts = args.map((a) => {
    if (a instanceof Error) return `${a.message}\n${a.stack}`;
    if (typeof a === 'object') return JSON.stringify(a);
    return String(a);
  });
  const line = _record('ERR', ...parts);
  process.stderr.write(line + '\n');
};

/** Returns a copy of the recent log buffer (oldest first). */
const recent = () => [..._buffer];

module.exports = { log, warn, error, recent };
