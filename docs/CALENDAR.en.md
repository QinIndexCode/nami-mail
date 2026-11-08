# Calendar and Mail Invitations
<!-- shipped-as: v0.6.0 -->

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

Imported events retain their original UID. Locally created events use their stable internal ID as UID; legacy rows with a NULL UID are also matched by that ID. Exporting and appending local events therefore updates the original row instead of creating duplicates.

Valid `TZID` values use IANA time zones and seasonal offsets. Floating times without a zone use local wall time. Invalid dates, unknown zones and nonexistent DST times produce an explicit error rather than the current time; replacement imports parse before deleting existing events. Full RRULE, recurrence exception and invitation cancellation semantics remain unsupported.

The UI follows calendar cursors to load all events. Reminders query a separate recent time window, so the oldest 1,000 historical events cannot hide current reminders.

## Event Reminders

While the app is running, a reminder toast fires 15 minutes before a timed event starts; for all-day events, the reminder fires at 09:00 on the day of the event. Clicking it opens the calendar. The same event is never reminded twice, and reminders more than 30 minutes stale are ignored. Reminders respect the notification toggle — turning off notifications silences calendar reminders too. The deduplication record (up to 200 entries) is kept in local browser storage.

## Agent Calendar Tools

The Agent registers `calendar.list`, `calendar.create`, `calendar.update` and `calendar.delete`. Writes follow the Agent access level: the default send-confirmed level requires visible approval; full-access follows its explicit authorization. The calendar service does not sync to a cloud calendar. When an authorized cloud Agent is used, selected events can be included in its conversation context.

## Local Storage and Boundaries

- Event title, description and location use a master-key-derived AES-256-GCM envelope; UTC fields support time-range queries. Since 0.6.0 the database file is also encrypted at rest. A field representation in an unlocked database is not plaintext on disk.
- Field lengths are bounded: title 300 characters, description 10,000 characters, location 500 characters; a single import accepts at most 5,000 events.
- ICS parsing stays local, and the invite banner reads attachments through the local service. The calendar service does not sync to third parties; cloud Agent context follows separate Provider consent.

