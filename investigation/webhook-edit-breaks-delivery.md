# Bug: Editing a Webhook Breaks Automatic Delivery

## Status
Confirmed. Reproduced by user on 2026-06-12.

## Symptom
After editing an existing webhook (changing URL, field mappings, etc.), the webhook shows "No deliveries yet" and never fires automatically on form submission. Manual "Send Test Payload" still works. Removing and re-adding the webhook as new fixes it.

## Root Cause

When `submitWebhookModal` runs for an **existing** webhook (`editingWebhookId` is set), it does:

```
1. DELETE /api/workspaces/[id]/integrations?integrationId=OLD_ID
2. POST  /api/workspaces/[id]/integrations  → returns NEW_ID
3. POST  /api/tests/[testId]/integrations   → saves mapping with NEW_ID
```

**Step 1** deletes the `workspace_integrations` row. If the DB has `ON DELETE CASCADE` on `test_integration_mappings.workspace_integration_id`, the old mapping is wiped.

**Step 3** inserts a new mapping with `NEW_ID` and `enabled: true` — this part looks correct.

However, subsequent edits to the same webhook in the same UI session use `editingWebhookId` which was set to `OLD_ID` at modal open time. The local state update in step 2 updates `webhooks` array with `NEW_ID`, but `editingWebhookId` is not refreshed — so the next edit targets a non-existent ID.

More critically: the UI's `webhookMappings` state is keyed by integration ID. After edit, the old key (`OLD_ID`) is replaced with `NEW_ID`. But if anything in the dispatch path caches or references the old ID, it breaks silently.

## Affected Files
- `src/app/(dashboard)/clients/[id]/tests/[testId]/AnalyticsClient.tsx` — `submitWebhookModal()` lines ~1457-1468
- `src/app/api/workspaces/[id]/integrations/route.ts` — DELETE + POST instead of PATCH

## Fix
Add a `PATCH /api/workspaces/[id]/integrations?integrationId=X` endpoint that updates the `config` field in place, preserving the row ID. In `submitWebhookModal`, when `editingWebhookId` is set, call PATCH instead of DELETE+POST. The `workspace_integration_id` stays the same, so the `test_integration_mappings` row remains valid and the dispatch finds it correctly.

## Why Manual Test Payload Works
"Send Test Payload" calls `/api/workspaces/[id]/integrations/test-webhook` directly with the URL from the modal form state — it does not go through `dispatchIntegrationsBackground` or look up `test_integration_mappings` at all. So it always works regardless of mapping state.

## Verified Workaround
Remove the broken webhook entirely and add it fresh as a new webhook. This creates a clean `workspace_integrations` row and a clean `test_integration_mappings` row with matching IDs.
