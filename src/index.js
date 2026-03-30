'use strict';

require('dotenv').config();

const { Client, GatewayIntentBits, Events, ActivityType } = require('discord.js');
const { getInfo, isUrl } = require('./ytdlp');
const GuildPlayer = require('./player');

// ─── Config ────────────────────────────────────────────────────────────────

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.PREFIX || '!';

if (!TOKEN) {
  console.error('ERROR: DISCORD_TOKEN is not set in environment / .env file');
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

// ─── Bot events ────────────────────────────────────────────────────────────

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity(`music | ${PREFIX}play`, { type: ActivityType.Listening });
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();

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
      player.enqueue(song);

      // If the player was idle, _playNext() already picked it up — show "Now playing"
      // If there were already songs queued, show "Added to queue"
      const isPlayingAlready = player.current && player.current !== song;
      if (isPlayingAlready) {
        await statusMsg.edit(
          `Added to queue: **${song.title}** (${song.duration}) — position ${player.queue.length}`
        );
      } else {
        // The "Now playing" message is sent by the player itself; just clean up the search msg
        await statusMsg.delete().catch(() => {});
      }
    } catch (err) {
      console.error('[!play]', err);
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
        `\`${PREFIX}help\` — Show this help message`,
      ].join('\n')
    );
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

client.login(TOKEN);
