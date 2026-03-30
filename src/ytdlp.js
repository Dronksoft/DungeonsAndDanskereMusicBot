'use strict';

const { spawn } = require('child_process');

function isUrl(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Searches YouTube (or resolves a URL) using yt-dlp and returns the track info.
 * @param {string} query - Song name or YouTube URL
 * @returns {Promise<object>} yt-dlp JSON info object
 */
function getInfo(query) {
  return new Promise((resolve, reject) => {
    const target = isUrl(query) ? query : `ytsearch1:${query}`;

    const proc = spawn('yt-dlp', [
      '--no-playlist',
      '--dump-json',
      '--quiet',
      '--no-warnings',
      target,
    ]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}. Is yt-dlp installed?`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(
          new Error(`yt-dlp exited with code ${code}: ${stderr.trim() || 'no output'}`)
        );
      }

      const lines = stdout.trim().split('\n').filter(Boolean);
      if (!lines.length) {
        return reject(new Error('No results found'));
      }

      try {
        resolve(JSON.parse(lines[0]));
      } catch {
        reject(new Error('Failed to parse yt-dlp JSON output'));
      }
    });
  });
}

/**
 * Creates a PCM audio stream by piping yt-dlp output through ffmpeg.
 * Returns the ffmpeg stdout (raw s16le 48kHz stereo PCM) and the child processes
 * so they can be cleaned up when playback ends.
 *
 * @param {string} url - Direct YouTube (or other) URL to stream
 * @returns {{ stream: Readable, ytdlp: ChildProcess, ffmpeg: ChildProcess }}
 */
function createAudioStream(url) {
  const ytdlp = spawn(
    'yt-dlp',
    [
      '--no-playlist',
      '-f', 'bestaudio/best',
      '-q',
      '--no-warnings',
      '--no-part',
      '-o', '-',
      url,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );

  ytdlp.stdout.pipe(ffmpeg.stdin);

  // Log yt-dlp errors but don't crash
  ytdlp.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error('[yt-dlp]', msg);
  });
  ffmpeg.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error('[ffmpeg]', msg);
  });

  ytdlp.on('close', (code) => {
    if (code !== 0) {
      ffmpeg.stdin.destroy(new Error(`yt-dlp exited with code ${code}`));
    }
  });

  // Swallow broken-pipe errors when the player stops early
  ffmpeg.stdin.on('error', () => {});
  ytdlp.stdout.on('error', () => {});

  return { stream: ffmpeg.stdout, ytdlp, ffmpeg };
}

module.exports = { getInfo, createAudioStream, isUrl };
