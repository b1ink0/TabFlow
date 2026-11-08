# Configuration

## General settings

Settings has a searchable section list. Changes save automatically after validation. Failed saves retain the entered values with Retry. Browser permission requests remain explicit actions.

Side panel reports its native position when the browser exposes it. Change in browser settings opens Appearance. Placement is a browser preference rather than an extension-controlled layout option.

Snapshots to keep defaults to 150, with a range of 10 to 5,000. Old eligible snapshots are pruned when saving or changing retention. Active operation/update recovery points remain protected.

## Models

Enter the OpenAI-compatible base URL and discover or select an exact model ID. Credentials are stored in settings. Grant host access to the intended endpoint. For servers on another computer, use a reachable address and configure its listening interface and firewall.

Roles can use separate endpoints/models:

- Generative orchestrator: conversation, planning and project discovery.
- Small chat model: constrained classification and tag proposals.
- Dedicated decision model: optional System One-compatible decisions. This requires that endpoint's protocol. Ordinary chat-completions support alone is insufficient.

Loaded context tokens must match the server's configured capacity. Output budgets are separate. The chat model menu can adjust these settings for the next request. Changing a UI budget does not load a model or change the server's context capacity.

Image input requires explicitly confirming support for the selected model/endpoint pair. Tags can use chat verification, a compatible decision model or manual review. Attempts per failed analysis request defaults to six and accepts one to ten. Authentication and missing-model errors require corrected settings.

## Suspension and access

Automatic suspension starts disabled. Configure inactivity timing, protected tab types and site exceptions. Page inspection and indexing require host access. Sleeping tabs can still be searched by known metadata without waking.

Optional calendar integration requests authorization separately. Backup downloads also request their browser permission when needed.

## Troubleshooting

| Symptom                         | Check                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| No models or connection refused | Endpoint URL, loaded model, host permission, listening address and firewall              |
| Context exceeded                | Actual server context capacity and configured input/output budgets                       |
| Analysis stopped                | Saved progress and Retry/Resume controls                                                 |
| Uncertain assignments           | Available evidence and editable draft assignments. Inspect a bounded selection if needed |
| Missing tabs after restart      | Saved-session controls and Snapshots & history                                           |
| Old suspender pages blocked     | Keep the old extension installed while recovering original addresses                     |

See [tab workflows](workflows.md) for sessions, migration and updates, and [AI assistance](assistant.md) for draft review and approval.
