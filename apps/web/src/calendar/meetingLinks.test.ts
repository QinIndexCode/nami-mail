import { describe, expect, it } from "vitest";
import { hasTranslation, translate } from "../i18n";
import { detectMeetingLink, MEETING_LABEL_KEYS, type MeetingPlatform } from "./meetingLinks";

/**
 * One row per detectable platform (and one per alternate domain), so a detector
 * branch that stops matching is visible as a named failure rather than as "the
 * generic fallback happened to return something".
 */
const cases: Array<{ label: string; text: string; platform: MeetingPlatform; url: string }> = [
  {
    label: "Tencent",
    text: "请准时参会：https://meeting.tencent.com/dm/123456789 会议密码：6666",
    platform: "tencent",
    url: "https://meeting.tencent.com/dm/123456789",
  },
  {
    label: "Tencent's VooV domain",
    text: "https://voovmeeting.com/dm/123456789",
    platform: "tencent",
    url: "https://voovmeeting.com/dm/123456789",
  },
  {
    label: "Zoom",
    text: "Join Zoom meeting at https://zoom.us/j/987654321",
    platform: "zoom",
    url: "https://zoom.us/j/987654321",
  },
  {
    label: "Feishu",
    text: "会议链接：https://feishu.cn/j/abc-def-ghi",
    platform: "feishu",
    url: "https://feishu.cn/j/abc-def-ghi",
  },
  {
    label: "Lark",
    text: "https://larksuite.com/j/abc-def-ghi",
    platform: "feishu",
    url: "https://larksuite.com/j/abc-def-ghi",
  },
  {
    label: "DingTalk",
    text: "点击入会 https://meeting.dingtalk.com/j/abcdef",
    platform: "dingtalk",
    url: "https://meeting.dingtalk.com/j/abcdef",
  },
  {
    label: "Microsoft Teams",
    text: "https://teams.microsoft.com/l/meetup-join/19%3ameeting",
    platform: "teams",
    url: "https://teams.microsoft.com/l/meetup-join/19%3ameeting",
  },
  {
    label: "Teams live",
    text: "https://teams.live.com/meet/123456789",
    platform: "teams",
    url: "https://teams.live.com/meet/123456789",
  },
  {
    label: "Google Meet",
    text: "Location: https://meet.google.com/abc-defg-hij",
    platform: "meet",
    url: "https://meet.google.com/abc-defg-hij",
  },
  {
    label: "an unlisted conference host",
    text: "https://conference.example.com/room/1",
    platform: "generic",
    url: "https://conference.example.com/room/1",
  },
];

describe("detectMeetingLink", () => {
  it.each(cases)("detects $label", ({ text, platform, url }) => {
    const res = detectMeetingLink(text);
    expect(res).toEqual({ url, platform });
  });

  it("strips sentence punctuation that adhered to the URL", () => {
    const res = detectMeetingLink("Join at https://zoom.us/j/987654321，");
    expect(res?.url).toBe("https://zoom.us/j/987654321");
  });

  it("returns null for non-meeting URLs or normal text", () => {
    expect(detectMeetingLink("上海市静安区延安中路1000号")).toBeNull();
    expect(detectMeetingLink("https://github.com/QinIndexCode/nami-mail")).toBeNull();
    expect(detectMeetingLink(null)).toBeNull();
    expect(detectMeetingLink("")).toBeNull();
  });

  it("has a localized join label for every platform in both locales", () => {
    for (const key of Object.values(MEETING_LABEL_KEYS)) {
      expect(hasTranslation("zh-CN", key), key).toBe(true);
      expect(hasTranslation("en-US", key), key).toBe(true);
      expect(translate("zh-CN", key)).not.toBe(key);
    }
  });
});
