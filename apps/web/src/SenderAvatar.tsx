import { useState } from "react";
import { useCustomAvatar } from "./avatarStore";

export function initials(name: string, address: string): string {
  const value = name.trim() || address.split("@")[0] || "?";
  return [...value].slice(0, 2).join("").toUpperCase();
}

export function accountTone(value: string): number {
  return [...value].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4;
}

/**
 * MD5 (RFC 1321) — tiny dependency-free implementation used only to key the
 * Gravatar lookup (Gravatar hashes the lowercased email with md5). This is a
 * hashing convenience, not a security primitive.
 */
function md5(input: string): string {
  const rotateLeft = (value: number, shift: number) => (value << shift) | (value >>> (32 - shift));
  const bytes = Array.from(new TextEncoder().encode(input));
  const originalLength = bytes.length;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const bitLength = originalLength * 8;
  for (let i = 0; i < 8; i += 1) bytes.push((bitLength >>> (i * 8)) & 0xff);
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const constants: number[] = [];
  for (let i = 0; i < 64; i += 1) constants.push(Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) & 0xffffffff);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words: number[] = [];
    for (let i = 0; i < 16; i += 1) {
      words.push(
        bytes[offset + i * 4]!
        | (bytes[offset + i * 4 + 1]! << 8)
        | (bytes[offset + i * 4 + 2]! << 16)
        | (bytes[offset + i * 4 + 3]! << 24),
      );
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const previousD = d;
      d = c;
      c = b;
      b = (b + rotateLeft((a + f + constants[i]! + words[g]!) >>> 0, shifts[i]!)) >>> 0;
      a = previousD;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const hex = (value: number) => value.toString(16).padStart(8, "0");
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

// Module-level cache of addresses that returned 404, so a long message list
// never re-requests Gravatar for senders known to have no photo.
const missingGravatarEmails = new Set<string>();

type SenderAvatarProps = {
  name: string;
  address: string;
  /** 0-3, drives the fallback letter background tone (stable per address). */
  tone: number;
  size?: "small" | "large";
  /** When true, tries Gravatar first and falls back to initials on 404/error. */
  gravatarEnabled: boolean;
};

/**
 * Sender avatar: a locally configured picture wins, then (when enabled)
 * Gravatar, then colored initials (Gmail/QQ/163/custom domains uniformly).
 * Gravatar sends the md5(email) to a third party only when gravatarEnabled
 * is true; locally stored avatars never leave the machine.
 */
export function SenderAvatar({ name, address, tone, size, gravatarEnabled }: SenderAvatarProps) {
  const [failed, setFailed] = useState(false);
  const email = address.trim().toLowerCase();
  const customAvatar = useCustomAvatar(email);
  const className = `sender-avatar${size ? ` ${size}` : ""} tone-${tone}`;
  if (customAvatar) {
    return <span className={className}><img src={customAvatar} alt="" /></span>;
  }
  const showGravatar = gravatarEnabled && !failed && !missingGravatarEmails.has(email);
  if (!showGravatar) {
    return <span className={className}>{initials(name, address)}</span>;
  }
  return (
    <span className={className}>
      <img
        src={`https://www.gravatar.com/avatar/${md5(email)}?d=404&s=96`}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => { missingGravatarEmails.add(email); setFailed(true); }}
      />
    </span>
  );
}

type CustomAvatarProps = {
  name: string;
  address: string;
  /** 0-3, drives the fallback letter background tone (stable per address). */
  tone: number;
  size?: "small" | "large";
  /** Base element class; defaults to the sender-avatar style. */
  className?: string;
};

/**
 * Avatar for an address without Gravatar resolution: shows the locally
 * configured picture when one exists (own accounts included), colored
 * initials otherwise.
 */
export function CustomAvatar({ name, address, tone, size, className }: CustomAvatarProps) {
  const customAvatar = useCustomAvatar(address);
  const classes = `${className ?? "sender-avatar"}${size ? ` ${size}` : ""} tone-${tone}`;
  if (!customAvatar) {
    return <span className={classes}>{initials(name, address)}</span>;
  }
  return <span className={classes}><img src={customAvatar} alt="" /></span>;
}
