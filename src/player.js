'use strict';

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  entersState,
} = require('@discordjs/voice');
const { createAudioStream } = require('./ytdlp');

/**
 * Manages the music queue and voice connection for a single Discord guild.
 */
class GuildPlayer {
  constructor(guildId) {
    this.guildId = guildId;
    this.queue = [];
    this.current = null;
    this.connection = null;
    this.textChannel = null;
    this._procs = null; // { ytdlp, ffmpeg } for the currently playing track

    this._player = createAudioPlayer();

    this._player.on(AudioPlayerStatus.Idle, () => {
      this._killProcs();
      this.current = null;
      this._playNext();
    });

    this._player.on('error', (err) => {
      console.error(`[GuildPlayer ${this.guildId}] Player error:`, err.message);
      this._killProcs();
      this.current = null;
      this._send('Error playing current track, skipping...');
      this._playNext();
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  _killProcs() {
    if (!this._procs) return;
    try { this._procs.ytdlp.kill('SIGKILL'); } catch {}
    try { this._procs.ffmpeg.kill('SIGKILL'); } catch {}
    this._procs = null;
  }

  _send(text) {
    if (this.textChannel) this.textChannel.send(text).catch(() => {});
  }

  _playNext() {
    if (!this.queue.length) {
      // Auto-disconnect after 5 minutes of silence
      this._idleTimer = setTimeout(() => {
        if (!this.current && this.connection) {
          this.connection.destroy();
          this.connection = null;
        }
      }, 5 * 60 * 1000);
      return;
    }

    clearTimeout(this._idleTimer);
    const song = this.queue.shift();
    this.current = song;

    try {
      const { stream, ytdlp, ffmpeg } = createAudioStream(song.url);
      this._procs = { ytdlp, ffmpeg };

      // OggOpus: @discordjs/voice demuxes the Ogg container and sends raw
      // Opus packets to Discord. No JS Opus encoder required.
      const resource = createAudioResource(stream, {
        inputType: StreamType.OggOpus,
        inlineVolume: true,
      });
      resource.volume?.setVolume(0.8);

      this._player.play(resource);
      this._send(
        `Now playing: **${song.title}** (${song.duration}) — requested by ${song.requestedBy}`
      );
    } catch (err) {
      console.error(`[GuildPlayer ${this.guildId}] Failed to start playback:`, err);
      this._send(`Failed to play **${song.title}**: ${err.message}`);
      this._playNext();
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Joins or moves to a voice channel. Safe to call when already connected.
   * @param {import('discord.js').VoiceBasedChannel} voiceChannel
   */
  async connect(voiceChannel) {
    // Already connected to the same channel and not destroyed — nothing to do
    if (
      this.connection &&
      this.connection.state.status !== VoiceConnectionStatus.Destroyed &&
      this.connection.joinConfig.channelId === voiceChannel.id
    ) {
      return;
    }

    // joinVoiceChannel handles both fresh joins and channel moves
    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    // Recover from brief disconnects (e.g. Discord server hiccup)
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Reconnected — keep going
      } catch {
        // Truly disconnected — clean up
        if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
          this.connection.destroy();
        }
        this.connection = null;
        this.queue = [];
        this._killProcs();
        this.current = null;
      }
    });

    // Wait up to 60 s for the connection to be ready
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 60_000);
    } catch (err) {
      if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        this.connection.destroy();
      }
      this.connection = null;
      throw new Error(`Could not connect to voice channel: ${err.message}`);
    }

    this.connection.subscribe(this._player);
  }

  /**
   * Adds a song to the queue and starts playback if the player is idle.
   * @param {{ title: string, url: string, duration: string, requestedBy: string }} song
   */
  enqueue(song) {
    this.queue.push(song);
    if (this._player.state.status === AudioPlayerStatus.Idle && !this.current) {
      this._playNext();
    }
  }

  skip() {
    if (this._player.state.status === AudioPlayerStatus.Idle) return false;
    this._player.stop(true); // triggers Idle → _playNext()
    return true;
  }

  stop() {
    clearTimeout(this._idleTimer);
    this.queue = [];
    this.current = null;
    this._killProcs();
    this._player.stop(true);
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    this.connection = null;
  }

  pause() {
    return this._player.pause(true);
  }

  resume() {
    return this._player.unpause();
  }

  get status() {
    return this._player.state.status;
  }
}

module.exports = GuildPlayer;
