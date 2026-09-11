import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import test from "node:test";
import { generateNotificationSoundWav, getNotificationSoundFile } from "../src/desktop-notification-sound.mts";

/** Minimal RIFF/WAVE reader so the assertions describe the container, not offsets. */
function readWavHeader(buffer: Buffer) {
  return {
    riff: buffer.toString("ascii", 0, 4),
    riffSize: buffer.readUInt32LE(4),
    wave: buffer.toString("ascii", 8, 12),
    format: buffer.toString("ascii", 12, 16),
    formatSize: buffer.readUInt32LE(16),
    audioFormat: buffer.readUInt16LE(20),
    channels: buffer.readUInt16LE(22),
    sampleRate: buffer.readUInt32LE(24),
    byteRate: buffer.readUInt32LE(28),
    blockAlign: buffer.readUInt16LE(32),
    bitsPerSample: buffer.readUInt16LE(34),
    data: buffer.toString("ascii", 36, 40),
    dataSize: buffer.readUInt32LE(40),
  };
}

test("generates a valid 16-bit mono PCM WAV container", () => {
  const buffer = generateNotificationSoundWav("soft");
  const { riffSize, dataSize, ...fields } = readWavHeader(buffer);
  assert.deepEqual(fields, {
    riff: "RIFF",
    wave: "WAVE",
    format: "fmt ",
    formatSize: 16,
    audioFormat: 1,
    channels: 1,
    sampleRate: 44100,
    byteRate: 88200,
    blockAlign: 2,
    bitsPerSample: 16,
    data: "data",
  });
  // Sizes must agree with each other and with the buffer that was allocated.
  assert.equal(riffSize, 36 + dataSize);
  assert.equal(buffer.length, 44 + dataSize);
  assert.equal(dataSize, buffer.length - 44);
});

test("renders distinct, non-silent audio for each sound", () => {
  const soft = generateNotificationSoundWav("soft");
  const bright = generateNotificationSoundWav("bright");
  assert.notEqual(soft.length, bright.length);

  const peak = (buffer: Buffer) => {
    let max = 0;
    for (let offset = 44; offset < buffer.length; offset += 2) {
      max = Math.max(max, Math.abs(buffer.readInt16LE(offset)));
    }
    return max;
  };
  // Both stay inside int16 and actually contain signal.
  assert.ok(peak(soft) > 500 && peak(soft) <= 32767);
  assert.ok(peak(bright) > 500 && peak(bright) <= 32767);

  // The envelope must start and end at silence, so the tone never clicks.
  assert.equal(soft.readInt16LE(44), 0);
  assert.equal(soft.readInt16LE(soft.length - 2), 0);
});

test("caches the generated file and reuses it across calls", () => {
  const first = getNotificationSoundFile("bright");
  assert.ok(first, "expected a generated sound file path");
  assert.ok(existsSync(first));
  assert.ok(statSync(first).size > 44);
  assert.equal(getNotificationSoundFile("bright"), first);
  assert.notEqual(getNotificationSoundFile("soft"), first);
});
