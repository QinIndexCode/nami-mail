import { useEffect, useSyncExternalStore } from "react";
import { getBimiAvatar } from "./api";

/**
 * Web-side cache for BIMI brand logos, keyed by lowercase sender domain.
 * Values: undefined = not resolved yet, null = resolved negative (no logo),
 * string = SVG data URL served by the local service (which applies SSRF
 * guards, size/type limits and its own DNS-level positive/negative cache).
 */
const logoCache = new Map<string, string | null>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeBimiLogos(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function requestLogo(domain: string): void {
  if (!domain || logoCache.has(domain) || inflight.has(domain)) return;
  const promise = getBimiAvatar(domain)
    .then((logo) => {
      logoCache.set(domain, logo);
      emit();
    })
    .catch(() => {
      // Service unreachable: fall back to initials/Gravatar for this session
      // instead of retrying the request on every row render.
      logoCache.set(domain, null);
      emit();
    })
    .finally(() => {
      inflight.delete(domain);
    });
  inflight.set(domain, promise);
}

export function peekBimiLogo(domain: string): string | null | undefined {
  return domain ? logoCache.get(domain.trim().toLowerCase()) : undefined;
}

export function resetBimiLogosForTests(): void {
  logoCache.clear();
  inflight.clear();
}

/** Reactive read of the BIMI logo for a sender domain (undefined while loading). */
export function useBimiLogo(domain: string): string | null | undefined {
  const normalized = domain.trim().toLowerCase();
  useEffect(() => {
    requestLogo(normalized);
  }, [normalized]);
  return useSyncExternalStore(
    subscribeBimiLogos,
    () => peekBimiLogo(normalized),
    () => undefined,
  );
}
