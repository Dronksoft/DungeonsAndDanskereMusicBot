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
    this._procs = null; // { ytdlp, ffmpeg } of the currently playing track

    this._player = createAudioPlayer();

    this._player.on(AudioPlayerStatus.Idle, () => {
      this._killProcs();
      this.current = null;
      this._playNext();
    });

    this._player.on('error', (err) => {
      console.error(`[GuildPlayer ${this.guildId}] Audio player error:`, err.message);
      this._killProcs();
      this.current = null;
      this._send(`There was an error playing the current track, skipping...`);
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
    if (this.textChannel) {
      this.textChannel.send(text).catch(() => {});
    }
  }

  _playNext() {
    if (!this.queue.length) {
      // Nothing left – disconnect after a short idle timeout
      this._idleTimeout = setTimeout(() => {
        if (!this.current && this.connection) {
          this.connection.destroy();
          this.connection = null;
        }
      }, 5 * 60 * 1000); // 5 minutes
      return;
    }

    clearTimeout(this._idleTimeout);

    const song = this.queue.shift();
    this.current = song;

    try {
      const { stream, ytdlp, ffmpeg } = createAudioStream(song.url);
      this._procs = { ytdlp, ffmpeg };

      const resource = createAudioResource(stream, {
        inputType: StreamType.Raw, // s16le PCM from our ffmpeg pipeline
        inlineVolume: true,
      });

      resource.volume?.setVolume(0.8);
      this._player.play(resource);
      this._send(`Now playing: **${song.title}** (${song.duration}) — requested by ${song.requestedBy}`);
    } catch (err) {
      console.error(`[GuildPlayer ${this.guildId}] Failed to start playback:`, err);
      this._send(`Failed to play **${song.title}**: ${err.message}`);
      this._playNext();
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Connects to a voice channel (or reuses an existing connection).
   * @param {import('discord.js').VoiceBasedChannel} voiceChannel
   */
  async connect(voiceChannel) {
    // Already connected to the right channel
    if (
      this.connection &&
      this.connection.joinConfig.channelId === voiceChannel.id &&
      this.connection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
      return;
    }

    // Destroy any stale connection first
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }

    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    // Handle unexpected disconnects
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Discord sometimes briefly disconnects – wait for reconnect
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        // Truly disconnected – clean up
        this.connection.destroy();
        this.connection = null;
        this.queue = [];
        this._killProcs();
        this.current = null;
      }
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    this.connection.subscribe(this._player);
  }

  /**
   * Adds a song to the queue and starts playback if idle.
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
    clearTimeout(this._idleTimeout);
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
