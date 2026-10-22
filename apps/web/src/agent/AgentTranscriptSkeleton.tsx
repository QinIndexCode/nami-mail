/**
 * Placeholder transcript shown while a conversation record is being fetched
 * (an optimistic switch or the initial restore after reopening the panel).
 * Mirrors the real message layout: right-aligned user bubble, left-aligned
 * assistant lines, timestamp rows.
 */
export function AgentTranscriptSkeleton() {
  return (
    <div className="agent-transcript-loading" aria-hidden="true">
      <article className="agent-message skeleton user">
        <div className="agent-skeleton-bubble">
          <div className="agent-skeleton-content">
            <div className="agent-skeleton-line" style={{ width: "74%" }} />
            <div className="agent-skeleton-line" style={{ width: "46%" }} />
          </div>
        </div>
        <div className="agent-message-meta"><span className="agent-skeleton-chrome" /></div>
      </article>
      <article className="agent-message skeleton assistant">
        <div className="agent-skeleton-content">
          <div className="agent-skeleton-line" style={{ width: "88%" }} />
          <div className="agent-skeleton-line" style={{ width: "70%" }} />
          <div className="agent-skeleton-line" style={{ width: "78%" }} />
          <div className="agent-skeleton-line" style={{ width: "42%" }} />
        </div>
        <div className="agent-message-meta"><span className="agent-skeleton-chrome" /></div>
      </article>
    </div>
  );
}
