import { describe, expect, it } from "vitest";
import { detectMeetingLink } from "./meetingLinks";

describe("detectMeetingLink", () => {
  it("detects Tencent meeting link", () => {
    const res = detectMeetingLink("请准时参会：https://meeting.tencent.com/dm/123456789 会议密码：6666");
    expect(res).not.toBeNull();
    expect(res?.platform).toBe("tencent");
    expect(res?.url).toBe("https://meeting.tencent.com/dm/123456789");
    expect(res?.label).toBe("加入腾讯会议");
  });

  it("detects Zoom link", () => {
    const res = detectMeetingLink("Join Zoom meeting at https://zoom.us/j/987654321");
    expect(res?.platform).toBe("zoom");
    expect(res?.label).toBe("加入 Zoom 会议");
  });

  it("detects Feishu / Lark link", () => {
    const res = detectMeetingLink("会议链接：https://feishu.cn/j/abc-def-ghi");
    expect(res?.platform).toBe("feishu");
    expect(res?.label).toBe("加入飞书会议");
  });

  it("detects Google Meet link", () => {
    const res = detectMeetingLink("Location: https://meet.google.com/abc-defg-hij");
    expect(res?.platform).toBe("meet");
    expect(res?.label).toBe("加入 Google Meet");
  });

  it("returns null for non-meeting URLs or normal text", () => {
    expect(detectMeetingLink("上海市静安区延安中路1000号")).toBeNull();
    expect(detectMeetingLink("https://github.com/QinIndexCode/nami-mail")).toBeNull();
    expect(detectMeetingLink(null)).toBeNull();
    expect(detectMeetingLink("")).toBeNull();
  });
});
