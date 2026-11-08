# Data storage and sharing

TabFlow stores workspace data locally in extension storage. Depending on enabled features, this includes titles, original addresses, memberships, notes, tags, cached text, previews, image attachments, conversations, drafts, sessions, snapshots and operation records.

## External access

AI features send relevant titles, addresses, notes, available page excerpts, attachments and draft context to the configured model endpoint. A server on another computer receives that data remotely. Its retention policy is separate from TabFlow's local storage.

Page indexing and inspection require host access. Optional calendar integration contacts Google's authorization and Calendar APIs when connected. Site favicons come from the browser. The extension does not collect application telemetry.

## Portable data

Manual backups contain saved workspace and assistant history, including saved image attachments and draft revisions. Cached page text, screenshot previews, model credentials and executable approvals are excluded. Scheduled backups omit the expanded assistant archive. Proposal exports are a separate, smaller interchange format.

Exports and screenshots can expose addresses, query parameters, titles, projects and notes. Imported assistant history is read-only, permissions reset, and transient browser handles are not reused.

## Permissions and cleanup

Chat approval mode controls application actions separately from browser permissions. Automatic approval never grants host access or bypasses protected targets. Action history can contain previous notes, tags and project details.

Settings / Data management provides selective deletion and a local reset. Removing the extension removes its local storage. Independent exported backups are outside that cleanup.

For reports, use a minimal fictional example and remove credentials, private URLs and browsing data from shared files.
