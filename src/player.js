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
    this._procs = null;
    this._idleTimer = null;

    this._player = createAudioPlayer();

    this._player.on(AudioPlayerStatus.Idle, () => {
      console.log(`[Player ${this.guildId}] Track finished, moving to next`);
      this._killProcs();
      this.current = null;
      this._playNext();
    });

    this._player.on('error', (err) => {
      console.error(`[Player ${this.guildId}] Audio player error:`, err.message);
      this._killProcs();
      this.current = null;
      this._send('There was an error playing the current track, skipping...');
      this._playNext();
    });

    this._player.on(AudioPlayerStatus.Playing, () => {
      console.log(`[Player ${this.guildId}] Status → Playing`);
    });

    this._player.on(AudioPlayerStatus.Buffering, () => {
      console.log(`[Player ${this.guildId}] Status → Buffering`);
    });

    this._player.on(AudioPlayerStatus.Paused, () => {
      console.log(`[Player ${this.guildId}] Status → Paused`);
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  _killProcs() {
    if (!this._procs) return;
    console.log(`[Player ${this.guildId}] Killing yt-dlp + ffmpeg processes`);
    try { this._procs.ytdlp.kill('SIGKILL'); } catch {}
    try { this._procs.ffmpeg.kill('SIGKILL'); } catch {}
    this._procs = null;
  }

  _send(text) {
    if (this.textChannel) this.textChannel.send(text).catch(() => {});
  }

  _playNext() {
    if (!this.queue.length) {
      console.log(`[Player ${this.guildId}] Queue empty — will disconnect in 5 min if idle`);
      this._idleTimer = setTimeout(() => {
        if (!this.current && this.connection) {
          console.log(`[Player ${this.guildId}] Idle timeout — disconnecting`);
          this.connection.destroy();
          this.connection = null;
        }
      }, 5 * 60 * 1000);
      return;
    }

    clearTimeout(this._idleTimer);
    const song = this.queue.shift();
    this.current = song;

    console.log(`[Player ${this.guildId}] Starting: "${song.title}" (${song.duration})`);

    try {
      const { stream, ytdlp, ffmpeg } = createAudioStream(song.url);
      this._procs = { ytdlp, ffmpeg };

      // OggOpus: @discordjs/voice demuxes the Ogg container and sends raw
      // Opus packets to Discord directly (no JS re-encoding step).
      const resource = createAudioResource(stream, {
        inputType: StreamType.OggOpus,
        inlineVolume: true,
      });
      resource.volume?.setVolume(0.8);

      this._player.play(resource);
      console.log(`[Player ${this.guildId}] player.play() called`);

      this._send(
        `Now playing: **${song.title}** (${song.duration}) — requested by ${song.requestedBy}`
      );
    } catch (err) {
      console.error(`[Player ${this.guildId}] Failed to create resource:`, err);
      this._send(`Failed to play **${song.title}**: ${err.message}`);
      this.current = null;
      this._playNext();
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Joins or moves to a voice channel. Safe to call when already connected.
   * Uses a local reference throughout to avoid null races with the Disconnected handler.
   *
   * IMPORTANT: the Disconnected handler is only registered AFTER entersState(Ready)
   * resolves. Setting it up earlier causes a race: Discord can briefly send a
   * Disconnected event during the initial handshake; the handler's 5 s inner
   * timeout would then fire, destroy the connection, and abort our own wait.
   */
  async connect(voiceChannel) {
    // Already connected and ready in the same channel — nothing to do
    if (
      this.connection &&
      this.connection.state.status === VoiceConnectionStatus.Ready &&
      this.connection.joinConfig.channelId === voiceChannel.id
    ) {
      console.log(`[Player ${this.guildId}] Already connected to voice channel`);
      return;
    }

    // Destroy any stale connection before creating a new one
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      console.log(`[Player ${this.guildId}] Destroying stale connection`);
      this.connection.destroy();
    }
    this.connection = null;

    console.log(`[Player ${this.guildId}] Joining voice channel: ${voiceChannel.name} (${voiceChannel.id})`);

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    this.connection = connection;

    // Wait up to 30 s for the initial Ready state.
    // Do NOT register the Disconnected handler yet — it would race with this wait
    // if Discord sends a transient Disconnected event during the handshake.
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      console.log(`[Player ${this.guildId}] Voice connection ready`);
    } catch (err) {
      console.error(`[Player ${this.guildId}] Failed to connect to voice:`, err.message);
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
      }
      if (this.connection === connection) this.connection = null;
      throw new Error(`Could not connect to voice channel: ${err.message}`);
    }

    // Connection is confirmed Ready — now it's safe to watch for future disconnects
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.warn(`[Player ${this.guildId}] Voice disconnected — trying to reconnect`);
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        console.log(`[Player ${this.guildId}] Reconnected`);
      } catch {
        console.warn(`[Player ${this.guildId}] Could not reconnect — cleaning up`);
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
          connection.destroy();
        }
        if (this.connection === connection) {
          this.connection = null;
          this.queue = [];
          this._killProcs();
          this.current = null;
        }
      }
    });

    connection.subscribe(this._player);
    console.log(`[Player ${this.guildId}] Subscribed audio player to connection`);
  }

  /**
   * Adds a song to the queue and starts playback if the player is idle.
   * @param {{ title, url, duration, requestedBy }} song
   * @returns {boolean} true if the song started playing immediately, false if queued
   */
  enqueue(song) {
    this.queue.push(song);
    console.log(`[Player ${this.guildId}] Enqueued: "${song.title}" | Queue length: ${this.queue.length}`);

    if (this._player.state.status === AudioPlayerStatus.Idle && !this.current) {
      this._playNext();
      return true; // started playing
    }
    return false; // added to queue
  }

  skip() {
    if (this._player.state.status === AudioPlayerStatus.Idle) return false;
    console.log(`[Player ${this.guildId}] Skipping: "${this.current?.title}"`);
    this._player.stop(true);
    return true;
  }

  stop() {
    console.log(`[Player ${this.guildId}] Stopping`);
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
