import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bot,
  Check,
  CircleAlert,
  CircleHelp,
  ClipboardList,
  Clock,
  Info,
  Link2,
  LoaderCircle,
  Play,
  ShieldAlert,
  X,
} from "lucide-react";
import { api } from "../api";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useDismissTransition } from "../hooks/useDismissTransition";
import { useTypewriter } from "../hooks/useTypewriter";
import { recordAgentTiming } from "../perfTelemetry";
import type { Translate } from "../i18n";
import type { AutoReplySimulateInput, AutoReplySimulateResult } from "../agentTypes";

export type AutoReplySandboxDialogProps = {
  t: Translate;
  onClose: () => void;
  fallbackFocusRef?: React.RefObject<HTMLElement | null>;
  overlayHostRef?: React.RefObject<HTMLElement | null>;
};

type Preset = {
  name: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  textBody: string;
};

const SAMPLE_PRESETS: Preset[] = [
  {
    name: "商务合作咨询",
    fromName: "陈经理",
    fromAddress: "chen@partner-tech.com",
    subject: "关于下季度深度产品合作与对接方案探讨",
    textBody: "你好！我们在评估贵团队的产品与技术方案，希望下周二下午组织一次线上电话会议，探讨双方系统集成的具体细节。请问你们方便吗？附上我们团队的介绍：https://partner-tech.com/about/company-profile",
  },
  {
    name: "带退订的推广周报",
    fromName: "Marketing Team",
    fromAddress: "newsletter@cloud-service.com",
    subject: "【9月特别推荐】本周云原生技术最新趋势与优惠活动",
    textBody: "尊敬的用户，我们为您整理了本周云服务限时特惠，点击查看详情：https://cloud-service.com/campaign/promo?utm_source=email&utm_campaign=september_sale&track_id=8923481023\n\n如您不希望再接收此类推广邮件，请点击这里 [退订链接]：https://cloud-service.com/notifications/unsubscribe?token=abcdef123456",
  },
  {
    name: "账户安全凭证通知",
    fromName: "安全团队",
    fromAddress: "security@pay-notify.com",
    subject: "安全提醒：您的账户密码在新的设备上被修改并绑定银行卡",
    textBody: "您的账户安全中心检测到一笔异常登录。若非您本人操作，请立即重置登录密码并核验银行卡支付凭证。",
  },
  {
    name: "垃圾推销邮件",
    fromName: "商务拓展",
    fromAddress: "spammer@unverified-marketing.xyz",
    subject: "低价推广代发邮件短信高回报投资理财",
    textBody: "大额贷款，快速到账，无需抵押，点击链接即刻申请：https://unverified-marketing.xyz/apply?id=9999",
  },
];

function SandboxDraftPreview({ text, t }: { text: string; t: Translate }) {
  const { displayedText, isTyping, complete } = useTypewriter({
    text,
    speedMs: 14,
    maxDurationMs: 1500,
  });

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
          {t("settings.agent.sandbox.draftPreview")}
        </span>
        {isTyping && (
          <button
            type="button"
            className="sandbox-typewriter-skip-btn"
            onClick={complete}
            title={t("settings.agent.sandbox.skipTypewriter")}
          >
            {t("settings.agent.sandbox.skipTypewriter")}
          </button>
        )}
      </div>
      <div className="sandbox-quote-preview" data-testid="sandbox-draft-preview">
        {displayedText}
        {isTyping && <span className="typewriter-cursor" aria-hidden="true" />}
      </div>
    </div>
  );
}

export default function AutoReplySandboxDialog({
  t,
  onClose,
  fallbackFocusRef,
  overlayHostRef,
}: AutoReplySandboxDialogProps) {
  const panelRef = useRef<HTMLElement>(null);
  const { closing, requestClose } = useDismissTransition(onClose);
  useDialogFocus(true, panelRef, { fallbackFocusRef });

  const [fromAddress, setFromAddress] = useState(SAMPLE_PRESETS[0]!.fromAddress);
  const [fromName, setFromName] = useState(SAMPLE_PRESETS[0]!.fromName);
  const [subject, setSubject] = useState(SAMPLE_PRESETS[0]!.subject);
  const [textBody, setTextBody] = useState(SAMPLE_PRESETS[0]!.textBody);
  const [simulateAsContact, setSimulateAsContact] = useState(false);
  const [forceLlm, setForceLlm] = useState(false);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AutoReplySimulateResult | null>(null);

  const resultRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (result && resultRef.current) {
      resultRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [result]);

  useEffect(() => {
    if (running && loadingRef.current) {
      loadingRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [running]);

  const loadPreset = (preset: Preset) => {
    setFromAddress(preset.fromAddress);
    setFromName(preset.fromName);
    setSubject(preset.subject);
    setTextBody(preset.textBody);
    setResult(null);
    setError(null);
  };

  const handleRun = async () => {
    if (!fromAddress.trim() || !subject.trim() || !textBody.trim()) {
      setError(t("settings.agent.sandbox.validationError"));
      return;
    }

    setRunning(true);
    setError(null);
    try {
      const payload: AutoReplySimulateInput = {
        fromAddress: fromAddress.trim(),
        fromName: fromName.trim() || undefined,
        subject: subject.trim(),
        textBody: textBody.trim(),
        simulateAsContact,
        forceLlm,
      };
      const response = await api.autoReplySimulate(payload);
      setResult(response.result);
      if (response.result.timings) {
        recordAgentTiming("auto-reply-simulate", response.result.timings.totalMs, {
          llmMs: response.result.timings.llmMs,
          finalAction: response.result.finalAction,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) {
        requestClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [running, requestClose]);

  const renderActionBadge = (action: AutoReplySimulateResult["finalAction"]) => {
    switch (action) {
      case "would_reply":
        return <span className="sandbox-stat-badge status-badge-success"><Check size={13} /> {t("settings.agent.sandbox.badge.repliedDirectly")}</span>;
      case "ignored_offline_rule":
        return <span className="sandbox-stat-badge status-badge-neutral"><X size={13} /> {t("settings.agent.sandbox.badge.ignoredScreening")}</span>;
      case "ignored_scope":
        return <span className="sandbox-stat-badge status-badge-warning"><ShieldAlert size={13} /> {t("settings.agent.sandbox.badge.ignoredScope")}</span>;
      case "ignored_low_value":
        return <span className="sandbox-stat-badge status-badge-info"><CircleHelp size={13} /> {t("settings.agent.sandbox.badge.ignoredLowValue")}</span>;
      case "sensitive_requires_confirmation":
        return <span className="sandbox-stat-badge status-badge-danger"><CircleAlert size={13} /> {t("settings.agent.sandbox.badge.sensitiveRequiresConfirmation")}</span>;
      default:
        return null;
    }
  };

  const modalContent = (
    <div
      className={`modal-backdrop contact-editor-backdrop auto-reply-sandbox-backdrop${closing ? " closing" : ""}`}
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && !running && requestClose()}
    >
      <section
        ref={panelRef}
        className={`contact-editor-modal settings-model-modal sandbox-modal${closing ? " closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sandbox-dialog-title"
        tabIndex={-1}
      >
        <div className="contact-editor settings-model-form">
          <div className="contact-editor-head settings-model-head">
            <div>
              <h3 id="sandbox-dialog-title" className="contact-editor-title settings-model-title">
                {t("settings.agent.sandbox.title")}
              </h3>
            </div>
            <button
              className="icon-button settings-model-close-btn"
              type="button"
              aria-label={t("common.close") ?? "Close"}
              disabled={running}
              onClick={requestClose}
            >
              <X size={16} />
            </button>
          </div>

          <div className="settings-model-fields" style={{ gap: 12 }}>
            <div>
              <div className="sandbox-presets-label" style={{ fontSize: 11, color: "var(--text-soft)", marginBottom: 6 }}>
                {t("settings.agent.sandbox.loadPreset")}
              </div>
              <div className="auto-reply-sandbox-presets">
                {SAMPLE_PRESETS.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    className="auto-reply-sandbox-preset-chip"
                    onClick={() => loadPreset(p)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="calendar-field-grid">
              <label className="settings-field calendar-field" htmlFor="sandbox-from-email">
                <span className="settings-field-label">
                  <span className="settings-field-label-text">{t("settings.agent.sandbox.fromEmail")}</span>
                </span>
                <input
                  id="sandbox-from-email"
                  type="email"
                  value={fromAddress}
                  placeholder="sender@example.com"
                  disabled={running}
                  onChange={(e) => setFromAddress(e.target.value)}
                />
              </label>

              <label className="settings-field calendar-field" htmlFor="sandbox-from-name">
                <span className="settings-field-label">
                  <span className="settings-field-label-text">{t("settings.agent.sandbox.fromName")}</span>
                </span>
                <input
                  id="sandbox-from-name"
                  type="text"
                  value={fromName}
                  placeholder="例如：张三"
                  disabled={running}
                  onChange={(e) => setFromName(e.target.value)}
                />
              </label>
            </div>

            <label className="settings-field calendar-field" htmlFor="sandbox-subject">
              <span className="settings-field-label">
                <span className="settings-field-label-text">{t("settings.agent.sandbox.subject")}</span>
              </span>
              <input
                id="sandbox-subject"
                type="text"
                value={subject}
                placeholder="邮件主题..."
                disabled={running}
                onChange={(e) => setSubject(e.target.value)}
              />
            </label>

            <label className="settings-field calendar-field" htmlFor="sandbox-body">
              <span className="settings-field-label">
                <span className="settings-field-label-text">{t("settings.agent.sandbox.body")}</span>
              </span>
              <textarea
                id="sandbox-body"
                value={textBody}
                rows={4}
                className="settings-model-textarea"
                placeholder="输入邮件正文..."
                disabled={running}
                onChange={(e) => setTextBody(e.target.value)}
              />
            </label>

            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, marginTop: 2 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  id="sandbox-simulate-contact"
                  checked={simulateAsContact}
                  disabled={running}
                  onChange={(e) => setSimulateAsContact(e.target.checked)}
                />
                <label htmlFor="sandbox-simulate-contact" style={{ fontSize: 12, color: "var(--text-soft)", cursor: "pointer" }}>
                  {t("settings.agent.sandbox.simulateAsContact")}
                </label>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  id="sandbox-force-llm"
                  checked={forceLlm}
                  disabled={running}
                  onChange={(e) => setForceLlm(e.target.checked)}
                />
                <label htmlFor="sandbox-force-llm" style={{ fontSize: 12, color: "var(--text-soft)", cursor: "pointer" }}>
                  {t("settings.agent.sandbox.forceLlm")}
                </label>
              </div>
            </div>

            {error && (
              <p className="settings-model-feedback error" role="alert">
                <CircleAlert size={14} />
                <span>{error}</span>
              </p>
            )}

            {running && (
              <div className="sandbox-loading-card" role="status" ref={loadingRef}>
                <LoaderCircle className="spin" size={14} />
                <span>{t("settings.agent.sandbox.runningHint")}</span>
              </div>
            )}

            {result && (
              <div ref={resultRef} className="sandbox-result-card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 650, color: "var(--text)" }}>
                      {t("settings.agent.sandbox.results")}
                    </span>
                    {result.timings && (
                      <span
                        className="sandbox-latency-pill"
                        data-testid="sandbox-latency-pill"
                        title={`初筛 ${result.timings.screeningMs}ms · 范围 ${result.timings.scopeMs}ms${result.timings.llmMs !== undefined ? ` · 模型 ${result.timings.llmMs}ms` : ""}`}
                      >
                        <Clock size={11} />
                        <span>{result.timings.totalMs}ms</span>
                        {result.timings.llmMs !== undefined && (
                          <span style={{ opacity: 0.75 }}>
                            ({t("settings.agent.sandbox.llmTime", { ms: result.timings.llmMs })})
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                  {renderActionBadge(result.finalAction)}
                </div>

                <div className="sandbox-grid-stats">
                  <div className="sandbox-stat-item">
                    <div style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--text-soft)", marginBottom: 4, fontWeight: 600 }}>
                      <Link2 size={13} />
                      <span>{t("settings.agent.sandbox.links")}</span>
                    </div>
                    <div>{t("settings.agent.sandbox.linksReplaced")}<strong>{result.linkStats.replacedCount}</strong></div>
                    <div>{t("settings.agent.sandbox.lengthReduced")}{result.linkStats.originalLength} → {result.linkStats.sanitizedLength}</div>
                    <div style={{ color: "var(--accent)", fontWeight: 600 }}>
                      {t("settings.agent.sandbox.tokensSaved", { count: result.linkStats.estimatedTokensSaved })}
                    </div>
                  </div>

                  <div className="sandbox-stat-item">
                    <div style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--text-soft)", marginBottom: 4, fontWeight: 600 }}>
                      <ClipboardList size={13} />
                      <span>{t("settings.agent.sandbox.rules")}</span>
                    </div>
                    <div>{t("settings.agent.sandbox.offlineScreening")}{result.screening.passed ? t("settings.agent.sandbox.passed") : (result.screening.details || result.screening.reason)}</div>
                    <div>{t("settings.agent.sandbox.scopeRule")}{result.scope.passed ? t("settings.agent.sandbox.allowed") : (result.scope.details || result.scope.reason)}</div>
                    <div>{t("settings.agent.sandbox.sensitiveKeywords")}{result.sensitiveKeywords.length > 0 ? result.sensitiveKeywords.join(", ") : t("settings.agent.sandbox.none")}</div>
                  </div>
                </div>

                {result.decision?.evaluated && (
                  <div className="sandbox-stat-item" style={{ marginTop: 2 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--text-soft)", marginBottom: 4, fontWeight: 600 }}>
                      <Bot size={13} />
                      <span>{t("settings.agent.sandbox.llmDecision")}</span>
                    </div>
                    <div>{t("settings.agent.sandbox.replyValue")}<strong>{result.decision.replyValue === "high" ? t("settings.agent.sandbox.highValue") : t("settings.agent.sandbox.lowValue")}</strong></div>
                    <div>{t("settings.agent.sandbox.sensitiveKeywords")}{result.decision.sensitive ? t("settings.agent.sandbox.sensitive") : t("settings.agent.sandbox.safe")}</div>
                    {result.decision.reply && (
                      <SandboxDraftPreview text={result.decision.reply} t={t} />
                    )}
                  </div>
                )}

                {result.decision && !result.decision.evaluated && (
                  <div className="sandbox-stat-item" style={{ marginTop: 2, borderColor: "var(--danger, #ef4444)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--danger, #ef4444)", marginBottom: 4, fontWeight: 600 }}>
                      <CircleAlert size={13} />
                      <span>{t("settings.agent.sandbox.llmEvaluationFailed")}</span>
                    </div>
                    <div style={{ color: "var(--text-soft)", fontSize: 11 }}>{result.decision.error}</div>
                  </div>
                )}

                {!result.decision && (
                  <div className="sandbox-stat-item" style={{ marginTop: 2, background: "transparent", borderStyle: "dashed" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--text-soft)", fontSize: 11 }}>
                      <Info size={13} />
                      <span>{t("settings.agent.sandbox.llmSkippedNotice")}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="contact-editor-actions settings-model-actions">
            <button className="secondary-button" type="button" disabled={running} onClick={requestClose}>
              <X size={15} /> {t("common.close") ?? "Close"}
            </button>
            <button className="primary-button" type="button" disabled={running} onClick={handleRun}>
              {running ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
              {running ? t("settings.agent.sandbox.running") : t("settings.agent.sandbox.start")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );

  if (overlayHostRef?.current) {
    return createPortal(modalContent, overlayHostRef.current);
  }
  return modalContent;
}
