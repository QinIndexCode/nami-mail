import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CalendarPlus, Clock, LoaderCircle, MapPin } from "lucide-react";
import { parseIcs, type ParsedIcsEvent } from "@nami/agent-contracts";
import { api } from "../api";
import { useI18n } from "../i18n";
import type { MessageAttachment } from "../types";
import { formatEventTimeSpan, isIcsAttachment } from "./calendarUtils";

// Parse-content cache keyed by "messageId:partId". Selecting back and forth
// between mails re-runs this effect; without the cache each visit re-downloads
// the whole attachment just to re-parse identical bytes. Cleared by tests via
// clearIcsParseCache. Attachment content is immutable once stored, so no TTL.
//
// Bounded LRU. Without eviction the ceiling was 10MB × however many invites a
// session happened to open, and a desktop long session never releases it.
// Recency is the only useful policy here: the cache exists for going back to a
// mail you just looked at, which is exactly what LRU preserves.
//
// Two caps, because either alone is wrong. Bytes bound the damage when the
// entries are huge; the count bounds the per-entry Map/iterator overhead when
// they are tiny (a 64MB byte budget alone would admit ~13k one-line invites).
// 64MB is the binding constraint in practice: it holds 6 worst-case 10MB
// invites, or tens of thousands of typical 2-10KB ones.
const icsContentCache = new Map<string, string>();
let icsContentCacheBytes = 0;
const maximumBannerIcsBytes = 10_000_000;
const maximumIcsCacheBytes = 64_000_000;
const maximumIcsCacheEntries = 512;

/**
 * Heap cost of a cached string. JS strings are UTF-16, and V8 stores anything
 * outside Latin-1 as two bytes per code unit, so `length * 2` is the upper
 * bound of what the entry actually occupies. Measuring the decoded text (rather
 * than the Blob's byte length) keeps the accounting consistent with what is
 * retained after the Blob is dropped.
 */
function icsContentBytes(text: string): number {
  return text.length * 2;
}

function readIcsContent(cacheKey: string): string | undefined {
  const cached = icsContentCache.get(cacheKey);
  if (cached === undefined) return undefined;
  // Map preserves insertion order, so delete+set re-inserts at the newest
  // position — that is the whole "refresh on hit" operation.
  icsContentCache.delete(cacheKey);
  icsContentCache.set(cacheKey, cached);
  return cached;
}

function writeIcsContent(cacheKey: string, text: string): void {
  icsContentCache.set(cacheKey, text);
  icsContentCacheBytes += icsContentBytes(text);
  // Evict oldest-first until both caps hold. A single entry can exceed the
  // byte budget only if maximumBannerIcsBytes > maximumIcsCacheBytes, which the
  // current constants (10MB < 64MB) rule out; the `size > 0` guard keeps the
  // loop terminating regardless of how the two are retuned.
  while (icsContentCache.size > 0
    && (icsContentCacheBytes > maximumIcsCacheBytes || icsContentCache.size > maximumIcsCacheEntries)) {
    const oldest = icsContentCache.keys().next();
    if (oldest.done) break;
    const evicted = icsContentCache.get(oldest.value);
    icsContentCache.delete(oldest.value);
    if (evicted !== undefined) icsContentCacheBytes -= icsContentBytes(evicted);
  }
}

export function clearIcsParseCache(): void {
  icsContentCache.clear();
  icsContentCacheBytes = 0;
}

export type MailCalendarInviteBannerProps = {
  messageId: string;
  attachments?: MessageAttachment[];
  onImportClick: (content: string, filename: string) => void;
  onViewCalendar?: () => void;
  demoMode?: boolean;
};

export default function MailCalendarInviteBanner({
  messageId,
  attachments,
  onImportClick,
  onViewCalendar,
}: MailCalendarInviteBannerProps) {
  const { locale, t } = useI18n();
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  // false | "error" | "oversized"; surfaced in the banner body below.
  const [failure, setFailure] = useState<null | "error" | "oversized">(null);

  const icsAttachment = useMemo(() => {
    return attachments?.find((att) => !att.related && isIcsAttachment(att));
  }, [attachments]);

  useEffect(() => {
    if (!icsAttachment) {
      setContent("");
      setLoading(false);
      setFailure(null);
      return;
    }
    const cacheKey = `${messageId}:${icsAttachment.partId}`;
    // Reject oversized payloads before the network round-trip when the
    // attachment metadata carries the size, mirroring the server's import cap.
    if (icsAttachment.size > maximumBannerIcsBytes) {
      setContent("");
      setLoading(false);
      setFailure("oversized");
      return;
    }
    const cached = readIcsContent(cacheKey);
    if (cached !== undefined) {
      setContent(cached);
      setLoading(false);
      setFailure(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailure(null);
    api.downloadAttachment(messageId, icsAttachment.partId)
      .then(async (blob) => {
        if (blob.size > maximumBannerIcsBytes) {
          if (!cancelled) {
            setFailure("oversized");
            setLoading(false);
          }
          return;
        }
        const text = await blob.text();
        if (!cancelled) {
          writeIcsContent(cacheKey, text);
          setContent(text);
          setFailure(null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailure("error");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [messageId, icsAttachment]);

  const parsedEvents = useMemo<ParsedIcsEvent[]>(() => {
    if (!content.trim()) return [];
    try {
      return parseIcs(content);
    } catch {
      return [];
    }
  }, [content]);

  if (!icsAttachment) return null;

  const firstEvent = parsedEvents[0];
  const timeSpanText = firstEvent
    ? formatEventTimeSpan(firstEvent.startAt, firstEvent.endAt, firstEvent.allDay, locale)
    : "";

  return (
    <section className="mail-calendar-invite-banner" aria-label={t("calendar.inviteBannerTitle")}>
      <div className="mail-calendar-invite-badge" aria-hidden="true">
        <CalendarDays size={18} className="mail-calendar-invite-icon" />
      </div>

      <div className="mail-calendar-invite-content">
        <div className="mail-calendar-invite-header">
          <span className="mail-calendar-invite-tag">{t("calendar.inviteBannerTitle")}</span>
          {parsedEvents.length > 1 && (
            <span className="mail-calendar-invite-count">
              {t("calendar.importSummary", { count: parsedEvents.length })}
            </span>
          )}
        </div>

        <strong className="mail-calendar-invite-title">
          {firstEvent?.title || icsAttachment.filename}
        </strong>

        {failure && (
          <div className="mail-calendar-invite-error" role="status">
            {failure === "oversized"
              ? t("calendar.inviteBannerOversized")
              : t("calendar.inviteBannerError")}
          </div>
        )}

        {firstEvent && (
          <div className="mail-calendar-invite-details">
            {timeSpanText && (
              <span className="mail-calendar-invite-time">
                <Clock size={12} aria-hidden="true" />
                <span>{timeSpanText}</span>
              </span>
            )}
            {firstEvent.location && (
              <span className="mail-calendar-invite-loc">
                <MapPin size={12} aria-hidden="true" />
                <span>{firstEvent.location}</span>
              </span>
            )}
          </div>
        )}
      </div>

      <div className="mail-calendar-invite-actions">
        {onViewCalendar && (
          <button
            type="button"
            className="secondary-button mail-calendar-view-btn"
            onClick={onViewCalendar}
          >
            <CalendarDays size={14} aria-hidden="true" />
            <span>{t("calendar.inviteBannerViewInCalendar")}</span>
          </button>
        )}
        <button
          type="button"
          className="primary-button mail-calendar-import-btn"
          disabled={loading || !content}
          onClick={() => onImportClick(content, icsAttachment.filename)}
        >
          {loading ? (
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
          ) : (
            <CalendarPlus size={14} aria-hidden="true" />
          )}
          <span>{t("calendar.inviteBannerAddToCalendar")}</span>
        </button>
      </div>
    </section>
  );
}
