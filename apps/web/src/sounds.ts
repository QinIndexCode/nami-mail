import type { NotificationSound } from "./types";

let audioContext: AudioContext | undefined;

function getAudioContext(): AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  const audioWindow = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  const Constructor = window.AudioContext ?? audioWindow.webkitAudioContext;
  if (!Constructor) return undefined;
  audioContext ??= new Constructor();
  return audioContext;
}

function isAudioContextRunning(context: AudioContext): boolean {
  return context.state === "running";
}

function tone(context: AudioContext, start: number, frequency: number, duration: number, volume: number): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
}

/**
 * Must be called from a user gesture. A running AudioContext is the only
 * renderer-side state we treat as dependable enough to mute the Windows sound.
 */
export async function primeNotificationSound(): Promise<boolean> {
  const context = getAudioContext();
  if (!context) return false;
  if (isAudioContextRunning(context)) return true;
  try {
    await context.resume();
  } catch {
    return false;
  }
  return isAudioContextRunning(context);
}

export function canPlayCustomNotificationSound(): boolean {
  return typeof document !== "undefined" && document.hasFocus() && Boolean(audioContext && isAudioContextRunning(audioContext));
}

/** Returns false instead of attempting a suspended-context playback. */
export function playNotificationSound(sound: NotificationSound): boolean {
  if (sound === "none" || sound === "system") return false;
  const context = audioContext;
  if (!context || !isAudioContextRunning(context)) return false;
  try {
    const start = context.currentTime + 0.025;
    if (sound === "soft") {
      tone(context, start, 659.25, 0.23, 0.055);
      tone(context, start + 0.12, 783.99, 0.34, 0.042);
    } else {
      tone(context, start, 880, 0.14, 0.06);
      tone(context, start + 0.1, 1174.66, 0.18, 0.052);
      tone(context, start + 0.22, 1567.98, 0.28, 0.04);
    }
    return true;
  } catch {
    return false;
  }
}
