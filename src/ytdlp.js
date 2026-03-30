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
    console.log(`[yt-dlp] Searching: ${target}`);

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
        console.error(`[yt-dlp] Search failed (exit ${code}): ${stderr.trim()}`);
        return reject(
          new Error(`yt-dlp exited with code ${code}: ${stderr.trim() || 'no output'}`)
        );
      }
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (!lines.length) {
        return reject(new Error('No results found'));
      }
      try {
        const info = JSON.parse(lines[0]);
        console.log(`[yt-dlp] Found: "${info.title}" (${info.duration}s) — ${info.webpage_url || info.url}`);
        resolve(info);
      } catch {
        reject(new Error('Failed to parse yt-dlp JSON output'));
      }
    });
  });
}

/**
 * Creates an Ogg/Opus audio stream by piping yt-dlp → ffmpeg.
 *
 * Using Ogg/Opus with StreamType.OggOpus lets @discordjs/voice demux the
 * container and forward Opus packets directly to Discord. ffmpeg handles the
 * transcoding; opusscript satisfies prism-media's module-load requirement.
 *
 * @param {string} url - YouTube (or other) URL to stream
 * @returns {{ stream: Readable, ytdlp: ChildProcess, ffmpeg: ChildProcess }}
 */
function createAudioStream(url) {
  console.log(`[yt-dlp] Spawning download process for: ${url}`);

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

  console.log(`[ffmpeg] Spawning transcode process (→ Ogg/Opus)`);

  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-vn',
      '-f', 'ogg',
      'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );

  ytdlp.stdout.pipe(ffmpeg.stdin);

  ytdlp.on('spawn', () => console.log('[yt-dlp] Process started'));
  ffmpeg.on('spawn', () => console.log('[ffmpeg] Process started'));

  ytdlp.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error('[yt-dlp]', msg);
  });
  ffmpeg.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error('[ffmpeg]', msg);
  });

  ytdlp.on('close', (code) => {
    console.log(`[yt-dlp] Process exited (code ${code})`);
    if (code !== 0) {
      ffmpeg.stdin.destroy(new Error(`yt-dlp exited with code ${code}`));
    }
  });

  ffmpeg.on('close', (code) => {
    console.log(`[ffmpeg] Process exited (code ${code})`);
  });

  // Swallow broken-pipe errors (normal when the player is stopped mid-song)
  ffmpeg.stdin.on('error', (err) => {
    console.warn('[ffmpeg] stdin error (likely stopped early):', err.message);
  });
  ytdlp.stdout.on('error', (err) => {
    console.warn('[yt-dlp] stdout error:', err.message);
  });

  return { stream: ffmpeg.stdout, ytdlp, ffmpeg };
}

module.exports = { getInfo, createAudioStream, isUrl };
