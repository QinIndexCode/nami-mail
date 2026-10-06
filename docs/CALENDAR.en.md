# Calendar and Mail Invitations

[简体中文](CALENDAR.zh-CN.md) | [English](CALENDAR.en.md)

Nami Mail includes a local calendar: a month view with event creation, editing, deletion, search, and ICS import/export. Calendar data lives only in the local database and never synchronizes with provider calendars (Google Calendar, CalDAV, or similar).

## Mail Invite Banner

When you read a message with an `.ics` attachment, a calendar invite banner appears at the top of the reading pane showing the first event's title, time, and location. It recognizes common online-meeting links (Tencent Meeting, Zoom, Feishu, DingTalk, Microsoft Teams, Google Meet) and links straight to the meeting.

The banner offers two actions: **Import into the calendar** (feeds the attachment content into the import modal) and **View calendar**. Parsed attachment content is cached per message + attachment part, so revisiting the same message never re-downloads it; attachments above 10 MB are rejected before download with a clear message.

## ICS Import

The import modal accepts a local `.ics` file (or attachment content carried over from the invite banner). Events are parsed and previewed locally before import; a parse failure is reported explicitly.

- **Size limits**: files above 10 MB are rejected before reading, and the parser enforces a 50,000-line cap as a decompression-bomb guard.
- **Append mode (default)**: adds events to the existing calendar. Events are deduplicated by their ICS UID — re-importing the same calendar never double-books; matching events are updated in place (reported as "updated").
- **Replace mode**: clears all existing events first, then imports the new content.

Manually created events carry no UID and do not participate in import deduplication. Exports emit the stored UID verbatim, so an import → export → re-import round trip is lossless.

## Event Reminders

While the app is running, a reminder toast fires 15 minutes before an event starts; clicking it opens the calendar. The same event is never reminded twice, and reminders more than 30 minutes stale are ignored. Reminders respect the notification toggle — turning off notifications silences calendar reminders too. The deduplication record (up to 200 entries) is kept in local browser storage.

## Local Storage and Boundaries

- Event title, description, and location are encrypted at rest with a master-key-derived AES-256-GCM envelope; start/end timestamps stay plaintext in UTC to serve the month view's date-range queries. This matches the mail-cache encryption boundary — it is not whole-database SQLite encryption.
- Field lengths are bounded: title 300 characters, description 10,000 characters, location 500 characters; a single import accepts at most 5,000 events.
- The calendar sends nothing to third parties. ICS parsing happens entirely on your machine; the invite banner only downloads the attachment itself from the local service.
