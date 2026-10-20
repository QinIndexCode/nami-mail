export type MeetingPlatform = "tencent" | "zoom" | "feishu" | "dingtalk" | "teams" | "meet" | "generic";

export type MeetingLinkInfo = {
  url: string;
  platform: MeetingPlatform;
};

/**
 * Translation keys for the "join meeting" action. Kept next to the detector so a
 * new platform cannot be added without also naming the string it renders.
 */
export const MEETING_LABEL_KEYS: Record<MeetingPlatform, string> = {
  tencent: "calendar.meeting.join.tencent",
  zoom: "calendar.meeting.join.zoom",
  feishu: "calendar.meeting.join.feishu",
  dingtalk: "calendar.meeting.join.dingtalk",
  teams: "calendar.meeting.join.teams",
  meet: "calendar.meeting.join.meet",
  generic: "calendar.meeting.join.generic",
};

/**
 * Extracts an online meeting URL and its platform from calendar location or
 * description text. The label is not baked in here: callers resolve
 * `MEETING_LABEL_KEYS[platform]` in the active locale, so detection stays a pure
 * function and the same link reads correctly in every language.
 */
export function detectMeetingLink(text?: string | null): MeetingLinkInfo | null {
  if (!text || typeof text !== "string") return null;

  // Match URLs starting with http:// or https://
  const urlMatch = text.match(/https?:\/\/[^\s<>"')]+/i);
  if (!urlMatch) return null;

  // Clean trailing punctuation that might have adhered from sentence text
  let url = urlMatch[0];
  url = url.replace(/[,;。，；]+$/, "");

  const lower = url.toLowerCase();

  if (lower.includes("meeting.tencent.com") || lower.includes("voovmeeting.com")) {
    return { url, platform: "tencent" };
  }
  if (lower.includes("zoom.us")) {
    return { url, platform: "zoom" };
  }
  if (lower.includes("feishu.cn") || lower.includes("larksuite.com")) {
    return { url, platform: "feishu" };
  }
  if (lower.includes("dingtalk.com")) {
    return { url, platform: "dingtalk" };
  }
  if (lower.includes("teams.microsoft.com") || lower.includes("teams.live.com")) {
    return { url, platform: "teams" };
  }
  if (lower.includes("meet.google.com")) {
    return { url, platform: "meet" };
  }

  // If the location itself was an arbitrary meeting URL
  if (lower.includes("meet") || lower.includes("meeting") || lower.includes("conference")) {
    return { url, platform: "generic" };
  }

  return null;
}
