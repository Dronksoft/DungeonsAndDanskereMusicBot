'use strict';

require('dotenv').config();

const { execFile } = require('child_process');
const { Client, GatewayIntentBits, Events, ActivityType } = require('discord.js');
const { AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const { getInfo, isUrl } = require('./ytdlp');
const GuildPlayer = require('./player');
const logger = require('./logger');

// ─── Config ────────────────────────────────────────────────────────────────

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.PREFIX || '!';

if (!TOKEN) {
  logger.error('ERROR: DISCORD_TOKEN is not set in environment / .env file');
  process.exit(1);
}

// ─── Discord client ────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const START_TIME = Date.now();

// One GuildPlayer per guild
const players = new Map();

function getPlayer(guildId) {
  if (!players.has(guildId)) {
    players.set(guildId, new GuildPlayer(guildId));
  }
  return players.get(guildId);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return 'live';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

/** Runs a command and returns its trimmed stdout, or '?' on failure. */
function getVersion(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve('?');
      resolve(stdout.trim().split('\n')[0]);
    });
  });
}

// ─── Bot events ────────────────────────────────────────────────────────────

client.once(Events.ClientReady, () => {
  logger.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity(`music | ${PREFIX}play`, { type: ActivityType.Listening });
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();

  logger.log(`[CMD] ${message.author.username}: ${PREFIX}${cmd} ${args.join(' ')}`.trimEnd());

  const player = getPlayer(message.guild.id);
  player.textChannel = message.channel;

  // ── !play ──────────────────────────────────────────────────────────────
  if (cmd === 'play' || cmd === 'p') {
    if (!args.length) {
      return message.reply(`Usage: \`${PREFIX}play <song name or YouTube URL>\``);
    }

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      return message.reply('You need to join a voice channel first!');
    }

    const query = args.join(' ');
    let statusMsg;

    try {
      statusMsg = await message.reply(`Searching for \`${query}\`...`);

      const info = await getInfo(query);

      const song = {
        title: info.title,
        url: info.webpage_url || info.url,
        duration: formatDuration(info.duration),
        requestedBy: message.author.username,
      };

      await player.connect(voiceChannel);

      const queuePositionBefore = player.queue.length + (player.current ? 1 : 0);
      const startedNow = player.enqueue(song);

      if (startedNow) {
        await statusMsg.delete().catch(() => {});
      } else {
        await statusMsg.edit(
          `Added to queue: **${song.title}** (${song.duration}) — position ${queuePositionBefore + 1}`
        );
      }
    } catch (err) {
      logger.error('[!play]', err);
      const errText = `Failed to find or play \`${query}\`: ${err.message}`;
      if (statusMsg) await statusMsg.edit(errText).catch(() => {});
      else await message.reply(errText).catch(() => {});
    }

  // ── !skip ──────────────────────────────────────────────────────────────
  } else if (cmd === 'skip' || cmd === 's') {
    if (!player.current) return message.reply('Nothing is playing right now.');
    const title = player.current.title;
    const skipped = player.skip();
    if (skipped) message.reply(`Skipped: **${title}**`);

  // ── !stop ──────────────────────────────────────────────────────────────
  } else if (cmd === 'stop') {
    player.stop();
    message.reply('Stopped playback and left the voice channel.');

  // ── !pause ─────────────────────────────────────────────────────────────
  } else if (cmd === 'pause') {
    if (player.pause()) message.reply('Paused.');
    else message.reply('Nothing to pause.');

  // ── !resume ────────────────────────────────────────────────────────────
  } else if (cmd === 'resume' || cmd === 'r') {
    if (player.resume()) message.reply('Resumed.');
    else message.reply('Nothing to resume.');

  // ── !queue ─────────────────────────────────────────────────────────────
  } else if (cmd === 'queue' || cmd === 'q') {
    if (!player.current && !player.queue.length) {
      return message.reply('The queue is empty. Use `!play` to add songs!');
    }

    const lines = [];
    if (player.current) {
      lines.push(`**Now Playing:** ${player.current.title} (${player.current.duration})`);
    }
    if (player.queue.length) {
      lines.push('');
      lines.push('**Up Next:**');
      player.queue.slice(0, 10).forEach((s, i) => {
        lines.push(`\`${i + 1}.\` ${s.title} (${s.duration}) — ${s.requestedBy}`);
      });
      if (player.queue.length > 10) {
        lines.push(`*…and ${player.queue.length - 10} more*`);
      }
    }

    message.reply(lines.join('\n'));

  // ── !np ────────────────────────────────────────────────────────────────
  } else if (cmd === 'np' || cmd === 'nowplaying') {
    if (!player.current) return message.reply('Nothing is playing right now.');
    message.reply(
      `Now Playing: **${player.current.title}** (${player.current.duration}) — requested by ${player.current.requestedBy}`
    );

  // ── !debug ─────────────────────────────────────────────────────────────
  } else if (cmd === 'debug') {
    const [ytdlpVer, ffmpegVer] = await Promise.all([
      getVersion('yt-dlp', ['--version']),
      getVersion('ffmpeg', ['-version']),
    ]);

    // Voice connection status
    let voiceStatus = 'Not connected';
    if (player.connection) {
      const s = player.connection.state.status;
      const channelId = player.connection.joinConfig?.channelId;
      const channel = channelId ? message.guild.channels.cache.get(channelId) : null;
      const channelName = channel ? `#${channel.name}` : channelId ?? 'unknown';
      const statusEmoji = {
        [VoiceConnectionStatus.Ready]: '✅',
        [VoiceConnectionStatus.Connecting]: '🔄',
        [VoiceConnectionStatus.Signalling]: '📡',
        [VoiceConnectionStatus.Disconnected]: '❌',
        [VoiceConnectionStatus.Destroyed]: '💀',
      }[s] ?? '❓';
      voiceStatus = `${statusEmoji} ${s} in ${channelName}`;
    }

    // Player status
    const playerStatusEmoji = {
      [AudioPlayerStatus.Idle]: '⏹',
      [AudioPlayerStatus.Buffering]: '⏳',
      [AudioPlayerStatus.Playing]: '▶️',
      [AudioPlayerStatus.Paused]: '⏸',
      [AudioPlayerStatus.AutoPaused]: '⏸ (auto)',
    }[player.status] ?? '❓';

    // Recent log lines — format as a code block, trimmed to fit Discord's 2000 char limit
    const recentLogs = logger.recent();
    const logBlock = recentLogs.length
      ? '```\n' + recentLogs.slice(-15).join('\n') + '\n```'
      : '*No log entries yet*';

    const lines = [
      '**Debug Info**',
      `Uptime: \`${formatUptime(Date.now() - START_TIME)}\``,
      `Node: \`${process.version}\``,
      `yt-dlp: \`${ytdlpVer}\``,
      `ffmpeg: \`${ffmpegVer}\``,
      '',
      `Voice: ${voiceStatus}`,
      `Player: ${playerStatusEmoji} ${player.status}`,
      player.current
        ? `Now playing: **${player.current.title}** (${player.current.duration}) — ${player.current.requestedBy}`
        : 'Now playing: *nothing*',
      `Queue: ${player.queue.length} song(s)`,
      '',
      '**Recent logs (last 15):**',
      logBlock,
    ];

    // Discord messages max out at 2000 chars — truncate log block if needed
    let reply = lines.join('\n');
    if (reply.length > 1990) {
      reply = reply.slice(0, 1987) + '…';
    }

    message.reply(reply);

  // ── !help ──────────────────────────────────────────────────────────────
  } else if (cmd === 'help') {
    message.reply(
      [
        '**Music Bot Commands:**',
        `\`${PREFIX}play <song>\` — Search and play a song or YouTube URL (alias: \`${PREFIX}p\`)`,
        `\`${PREFIX}skip\` — Skip the current song (alias: \`${PREFIX}s\`)`,
        `\`${PREFIX}stop\` — Stop playback and disconnect`,
        `\`${PREFIX}pause\` — Pause playback`,
        `\`${PREFIX}resume\` — Resume playback (alias: \`${PREFIX}r\`)`,
        `\`${PREFIX}queue\` — Show the current queue (alias: \`${PREFIX}q\`)`,
        `\`${PREFIX}np\` — Show what's currently playing`,
        `\`${PREFIX}debug\` — Show bot state, versions, and recent logs`,
        `\`${PREFIX}help\` — Show this help message`,
      ].join('\n')
    );
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

client.login(TOKEN);
