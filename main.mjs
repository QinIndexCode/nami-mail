/**
 * Compatibility entry point for direct `electron main.mjs` launches.
 * Keep every launch path on the production desktop process so the window
 * icon, tray lifecycle, close prompt, and IPC security policy cannot drift.
 */
import "./apps/desktop/dist/main.mjs";
