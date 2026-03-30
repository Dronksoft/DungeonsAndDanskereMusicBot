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
 * Searches YouTube (or resolves a URL) using yt-dlp and returns track info.
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
 * Creates an Ogg/Opus audio stream by piping yt-dlp → ffmpeg.
 *
 * Using Ogg/Opus lets @discordjs/voice demux the container and send Opus
 * packets directly to Discord — no JS-side Opus encoder (opusscript /
 * @discordjs/opus) is needed. ffmpeg handles all transcoding.
 *
 * @param {string} url - Direct YouTube (or other) URL
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

  // Transcode to Ogg/Opus so @discordjs/voice can use StreamType.OggOpus,
  // which bypasses the need for a JS Opus encoder entirely.
  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-vn',          // drop video
      '-f', 'ogg',
      'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );

  ytdlp.stdout.pipe(ffmpeg.stdin);

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

  // Swallow broken-pipe errors (normal when the player is stopped mid-song)
  ffmpeg.stdin.on('error', () => {});
  ytdlp.stdout.on('error', () => {});

  return { stream: ffmpeg.stdout, ytdlp, ffmpeg };
}

module.exports = { getInfo, createAudioStream, isUrl };
