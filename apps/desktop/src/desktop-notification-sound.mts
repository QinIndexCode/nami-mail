import { exec } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { minimalSpawnEnvironment } from "./spawn-environment.mjs";

/**
 * Main-process notification sound playback.
 *
 * The renderer's Web Audio API can only play when the window is focused and the
 * AudioContext has been unlocked by a user gesture. New-mail notifications
 * almost always arrive when the window is NOT focused, so a renderer-side sound
 * never plays and Windows falls back to its default. Generating WAV data here
 * and playing it through a system command works regardless of window focus or
 * AudioContext state — and it removes any need to ship audio assets.
 */

export type CustomNotificationSound = "soft" | "bright";

type ToneSpec = { freq: number; start: number; duration: number; volume: number };

const softTones: ToneSpec[] = [
  { freq: 659.25, start: 0.025, duration: 0.23, volume: 0.055 },
  { freq: 783.99, start: 0.145, duration: 0.34, volume: 0.042 },
];

const brightTones: ToneSpec[] = [
  { freq: 880, start: 0.025, duration: 0.14, volume: 0.06 },
  { freq: 1174.66, start: 0.125, duration: 0.18, volume: 0.052 },
  { freq: 1567.98, start: 0.245, duration: 0.28, volume: 0.04 },
];

/** Generates a 16-bit PCM mono WAV buffer for the given tone specification. */
export function generateNotificationSoundWav(sound: CustomNotificationSound): Buffer {
  const sampleRate = 44100;
  const tones = sound === "soft" ? softTones : brightTones;
  const totalDuration = Math.max(...tones.map((t) => t.start + t.duration)) + 0.03;
  const totalSamples = Math.ceil(totalDuration * sampleRate);
  const dataSize = totalSamples * 2; // 16-bit mono

  const samples = new Float32Array(totalSamples);
  for (const tone of tones) {
    const startSample = Math.floor(tone.start * sampleRate);
    const durationSamples = Math.floor(tone.duration * sampleRate);
    const fadeSamples = Math.floor(0.015 * sampleRate);
    for (let i = 0; i < durationSamples; i++) {
      const idx = startSample + i;
      if (idx >= totalSamples) break;
      const t = i / sampleRate;
      // Exponential envelope: ramp up over 15ms, then ramp down to silence.
      let envelope: number;
      if (i < fadeSamples) {
        envelope = 0.0001 * Math.pow(tone.volume / 0.0001, i / fadeSamples);
      } else {
        const progress = (i - fadeSamples) / (durationSamples - fadeSamples);
        envelope = tone.volume * Math.pow(0.0001 / tone.volume, progress);
      }
      samples[idx] = (samples[idx] ?? 0) + Math.sin(2 * Math.PI * tone.freq * t) * envelope;
    }
  }

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < totalSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buffer;
}

const soundFilePathCache: Partial<Record<CustomNotificationSound, string>> = {};

/** Lazily generates and caches the WAV file for the given sound. */
export function getNotificationSoundFile(sound: CustomNotificationSound): string | undefined {
  const cached = soundFilePathCache[sound];
  if (cached) return cached;
  try {
    const filePath = path.join(tmpdir(), `nami-notification-${sound}.wav`);
    if (!existsSync(filePath)) {
      const wav = generateNotificationSoundWav(sound);
      writeFileSync(filePath, wav);
    }
    soundFilePathCache[sound] = filePath;
    return filePath;
  } catch {
    return undefined;
  }
}

/** Injectable player command runner (defaults to child_process.exec). */
export type PlayerRunner = (
  command: string,
  options: { env?: NodeJS.ProcessEnv; timeout?: number },
  callback: (error: Error | null) => void,
) => unknown;

/** Plays a notification sound from the main process using a system command.
 * Resolves true when the playback command completed successfully, false when
 * the file could not be written or the player command failed — the caller must
 * fall back to the OS notification sound instead of staying silent. */
export function playCustomNotificationSound(
  sound: CustomNotificationSound,
  runExec: PlayerRunner = exec,
): Promise<boolean> {
  return new Promise((resolve) => {
    const filePath = getNotificationSoundFile(sound);
    if (!filePath) {
      resolve(false);
      return;
    }
    // Escape single quotes for shell safety.
    const safePath = filePath.replace(/'/g, `'\\''`);
    let command: string;
    if (process.platform === "win32") {
      // PowerShell SoundPlayer.PlaySync blocks until the sound finishes, but
      // exec runs it in a child process so the main process is not blocked.
      command = `powershell -NoProfile -NonInteractive -Command "(New-Object Media.SoundPlayer '${safePath}').PlaySync()"`;
    } else if (process.platform === "darwin") {
      command = `afplay '${safePath}'`;
    } else {
      command = `aplay '${safePath}' 2>/dev/null || paplay '${safePath}' 2>/dev/null`;
    }
    // Hard cap so a wedged player process can never delay the notification
    // indefinitely; the caller shows the notification once this settles.
    runExec(command, { env: minimalSpawnEnvironment(), timeout: 4000 }, (error) => {
      resolve(!error);
    });
  });
}

const WIN32_PLAYER_WARMUP_MS = 10_000;

/** Prepares the sound pipeline before the first real notification arrives:
 * generates both WAV files up front (so a later tmp-dir failure surfaces in
 * the diagnostics log immediately instead of silently at notification time)
 * and, on Windows, pre-starts PowerShell once so the first real playback
 * skips its ~1.5s cold start. Best effort — failures are ignored because the
 * caller logs them again when an actual notification needs the sound. */
export function warmUpNotificationSoundPlayer(runExec: PlayerRunner = exec): void {
  for (const sound of ["soft", "bright"] as const) {
    getNotificationSoundFile(sound);
  }
  if (process.platform !== "win32") return;
  runExec(
    "powershell -NoProfile -NonInteractive -Command \"exit 0\"",
    { env: minimalSpawnEnvironment(), timeout: WIN32_PLAYER_WARMUP_MS },
    () => undefined,
  );
}
