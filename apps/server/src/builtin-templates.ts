/**
 * Built-in mail templates shipped with the app.
 *
 * These are seeded into the local template library on first run with the
 * `builtin` flag set. The user can edit or delete them like any other template;
 * editing clears the flag (it becomes a normal user template) and deleting
 * never re-seeds it. Seeding is idempotent: a template id already present is
 * left untouched so user edits/deletions survive restarts.
 */

export type BuiltinTemplateSeed = {
  id: string;
  name: string;
  subject: string;
  body: string;
};

export const BUILTIN_TEMPLATES: readonly BuiltinTemplateSeed[] = [
  {
    id: "builtin-welcome",
    name: "欢迎新客户",
    subject: "欢迎加入{{company}}！",
    body: "您好，\n\n欢迎加入{{company}}！很高兴能与您合作。\n\n如需任何帮助，请随时与我们联系。\n\n此致\n敬礼",
  },
  {
    id: "builtin-thanks",
    name: "感谢信",
    subject: "感谢您的支持",
    body: "您好，\n\n非常感谢您一直以来的支持与信任。您的反馈对我们非常重要。\n\n期待与您继续保持合作。\n\n此致\n敬礼",
  },
  {
    id: "builtin-followup",
    name: "跟进邮件",
    subject: "关于{{topic}}的跟进",
    body: "您好，\n\n我想跟进一下关于{{topic}}的事宜。请问您那边是否有任何进展或更新？\n\n期待您的回复。\n\n此致\n敬礼",
  },
  {
    id: "builtin-leave",
    name: "请假通知",
    subject: "请假通知（{{dates}}）",
    body: "您好，\n\n我将于{{dates}}请假，期间如有紧急事项，请联系{{contact}}。\n\n假期结束后我会尽快处理相关事务。\n\n感谢理解。",
  },
  {
    id: "builtin-meeting",
    name: "会议邀请",
    subject: "会议邀请：{{topic}}",
    body: "您好，\n\n我们计划在{{datetime}}召开关于{{topic}}的会议，地点：{{location}}。\n\n请确认您能否参加。\n\n此致\n敬礼",
  },
  {
    id: "builtin-receipt",
    name: "发送收据",
    subject: "您的收据",
    body: "您好，\n\n附件是您本次交易的收据（编号：{{reference}}）。\n\n如有疑问，请随时与我们联系。\n\n此致\n敬礼",
  },
  {
    id: "builtin-introduction",
    name: "自我介绍",
    subject: "自我介绍：{{role}}",
    body: "您好，\n\n我是{{name}}，担任{{role}}。很高兴有机会与您联系。\n\n期待与您的交流与合作。\n\n此致\n敬礼",
  },
  {
    id: "builtin-weekly-report",
    name: "周报",
    subject: "本周工作周报",
    body: "您好，\n\n以下是本周工作总结：\n\n1. {{item1}}\n2. {{item2}}\n3. {{item3}}\n\n下周计划：\n{{plan}}\n\n此致\n敬礼",
  },
];
