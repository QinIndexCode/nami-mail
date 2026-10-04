export type MeetingPlatform = "tencent" | "zoom" | "feishu" | "dingtalk" | "teams" | "meet" | "generic";

export type MeetingLinkInfo = {
  url: string;
  platform: MeetingPlatform;
  label: string;
};

/**
 * Extracts online meeting URL and human-friendly platform label from calendar location or description text.
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
    return { url, platform: "tencent", label: "加入腾讯会议" };
  }
  if (lower.includes("zoom.us")) {
    return { url, platform: "zoom", label: "加入 Zoom 会议" };
  }
  if (lower.includes("feishu.cn") || lower.includes("larksuite.com")) {
    return { url, platform: "feishu", label: "加入飞书会议" };
  }
  if (lower.includes("dingtalk.com")) {
    return { url, platform: "dingtalk", label: "加入钉钉会议" };
  }
  if (lower.includes("teams.microsoft.com") || lower.includes("teams.live.com")) {
    return { url, platform: "teams", label: "加入 Teams 会议" };
  }
  if (lower.includes("meet.google.com")) {
    return { url, platform: "meet", label: "加入 Google Meet" };
  }

  // If the location itself was an arbitrary meeting URL
  if (lower.includes("meet") || lower.includes("meeting") || lower.includes("conference")) {
    return { url, platform: "generic", label: "加入线上会议" };
  }

  return null;
}
