# Shortcut Assistant Implementation Plan

> **For implementers:** Follow repository instructions and the execution method agreed with the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Apple Shortcuts send a typed prompt to Tally's existing assistant with a per-user revocable bearer credential.

**Architecture:** Keep assistant actions in one shared server function used by the existing session route and the new Shortcut route. Store one SHA-256 credential hash per user, authenticate only from the Authorization header, and expose create/rotate/revoke controls in Settings.

**Tech Stack:** Next.js 16.4 App Router, TypeScript, Zod, SQLite, Vitest.

**Spec:** This user request (2026-10-12).

## Global Constraints

- Keep `/api/assistant` session authentication and response behavior unchanged.
- Preserve provider, transaction, debt, repayment, finance-question, and clarification logic; do not modify debt behavior.
- Require current user enabled status, assistant opt-in for the current provider disclosure, and server provider configuration for every Shortcut assistant request.
- Store only a high-entropy credential hash. Return the raw value only when creating or rotating it.
- Accept the credential only from `Authorization: Bearer …`; add no wildcard CORS.
- Limit JSON bodies with the existing `requestJson` helper and rate-limit Shortcut calls.
- Do not build dictation or a native iOS app, create/configure a Shortcut, commit, or push.

## Review Focus

- Invalid, revoked, disabled-owner, and cross-user credentials must not reach the provider or another user's conversation.
- Stale consent or missing provider configuration must block the request before any assistant action.
- Empty, oversized, malformed, and oversized prompts must be rejected without creating a conversation.
- Existing session requests must keep their current response shape and assistant actions.
- The one-time credential must not be returned by Settings reads or persisted in plaintext.

---

### Task 1: Credential storage and management

**Files:**
- Modify: `src/lib/store.ts`
- Create: `src/lib/shortcut-credential.ts`
- Create: `src/app/api/settings/shortcut-credential/route.ts`
- Modify: `src/app/api/settings/route.ts`
- Test: `tests/store.test.ts`
- Test: `tests/shortcut-credential.test.ts`

**Interfaces:**
- `hashShortcutCredential(secret: string): string`
- Store operations: `setShortcutCredentialHash(userId, hash | null)`, `findEnabledUserByShortcutCredentialHash(hash)`, and `hasShortcutCredential(userId)`.
- `POST /api/settings/shortcut-credential` creates or rotates a 32-byte base64url secret and returns `{ credential }`; `DELETE` revokes it.
- `GET /api/settings` reports only `shortcutCredentialActive: boolean`.

- [x] Write tests for owner-scoped lookup, disabled users, plaintext absence, one-time create/rotate response, and revocation.
- [x] Run the focused tests and confirm failure because credential storage and routes do not exist.
- [x] Add the nullable user hash column and migration, store methods, crypto helper, management routes, and status field.
- [x] Run the focused tests and confirm the secret works once issued, its hash is stored, and revoked/disabled values no longer authenticate.

### Task 2: Shared assistant orchestration

**Files:**
- Create: `src/lib/assistant.ts`
- Modify: `src/app/api/assistant/route.ts`
- Test: `tests/assistant-route.test.ts`

**Interfaces:**
- `assistantPromptSchema` retains the current prompt (trimmed, 1–2000 characters) and optional UUID `conversationId` shape.
- `assertAssistantAccess(store, userId)` checks current disclosure consent and provider configuration.
- `runAssistantPrompt(store, user: { id: string }, input)` contains the existing orchestration and returns the existing full session response object.

- [x] Add a regression assertion for the existing session response contract.
- [x] Run it and confirm the current route already passes before extraction.
- [x] Move the route's assistant orchestration into the shared function without changing its decisions; keep session origin/auth/body/error handling in the route.
- [x] Run all `tests/assistant-route.test.ts` cases, including transaction, debt, repayment, clarification, and finance behavior.

### Task 3: Shortcut assistant endpoint

**Files:**
- Create: `src/app/api/shortcuts/assistant/route.ts`
- Create: `tests/shortcuts-assistant.test.ts`

**Interfaces:**
- `POST /api/shortcuts/assistant` accepts the shared `AssistantPromptInput` after resolving an enabled credential owner from the bearer header.
- It rate-limits by owner, calls the shared access check and assistant function, and returns only `{ answer, conversationId }`.

- [x] Add tests for valid, invalid, revoked, disabled, and cross-user credentials; query-string credentials; opt-in/disclosure/provider checks; prompt validation; rate limiting; and Shortcut response shape.
- [x] Run the focused tests and confirm expected failures before implementation.
- [x] Add the header-only bearer route with existing JSON/error helpers, owner rate limit, and shared orchestration.
- [x] Run the focused tests and verify no provider call or write occurs on rejected requests.

### Task 4: Settings controls and final verification

**Files:**
- Modify: `src/components/settings-view.tsx`

- [x] Add the smallest Settings panel to create/rotate, display once, copy, and revoke the credential.
- [x] Run focused route/store tests, the complete Vitest suite, TypeScript checking, and lint; report each result and any limitation.
