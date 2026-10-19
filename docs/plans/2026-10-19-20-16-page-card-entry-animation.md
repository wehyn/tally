# Page Card Entry Animation Implementation Plan

> **For implementers:** Follow repository instructions and the execution method agreed with the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Animate eligible page cards briefly when a user enters a new app route.

**Architecture:** `AppShell` owns a private `usePageCardEntry` hook and a route-entry snapshot containing the committed pathname and eligible card elements under `main.page-content`. The hook animates the snapshot once per pathname with the Web Animations API, while canceling prior animations on navigation or unmount.

**Tech Stack:** Next.js 16.4 App Router, React 19, TypeScript, Web Animations API.

**Spec:** `docs/specs/2026-10-19-20-03-page-card-entry-animation-design.md`

## Global Constraints

- Keep the change in `src/components/app-shell.tsx`; add no dependency and do not change route markup.
- Use `RouteEntrySnapshot = { pathname: string; cards: HTMLElement[] }`.
- Select visible outermost `.panel`, `.stat-card`, `.account-card`, `.goal-card`, `.admin-card`, `.debt-summary-card`, and `.section-destination` descendants of `.page-stack`.
- Exclude `.archived-disclosure`, `.category-manager-collapsible`, hidden cards, and modal content.
- Animate from opacity `0.88` and `translateY(5px)` to opacity `1` and `translateY(0)` over `220ms`, using `cubic-bezier(.22,.8,.2,1)`, `fill: "backwards"`, and a `28ms` stagger capped at `112ms`.
- Apply the first keyframe during each delay. The client layout effect preserves server-rendered visibility before hydration.
- Skip reduced-motion users and browsers without `Element.animate()`. Leave server-rendered content visible before hydration.
- Cancel in-flight animations when the pathname changes or the component unmounts. Same-route updates do not replay.
- The design spec was approved by the user. Do not expand its scope.

## Review Focus

- The pathname effect may run before destination content commits. Browser verification must confirm the snapshot contains destination cards on navigation.
- Nested matching card classes may cause duplicate animation. Keep only outermost matches.
- Expandable and modal cards must stay outside the route-entry animation, including after local interaction.

---

### Task 1: Implement route-scoped page card entry

**Files:**
- Modify: `src/components/app-shell.tsx`

**Interfaces:**
- Consumes: `usePathname()` in `AppShell` and existing page-card class names in route views.
- Produces: private `RouteEntrySnapshot` type and `usePageCardEntry(pathname: string): RefObject<HTMLElement | null>` hook attached to `main.page-content`.

- [x] **Step 1: Read the installed Next.js App Router documentation**

Read the installed `usePathname`, client components, and layouts guides under `node_modules/next/dist/docs/`. Confirm the pathname hook and layout effect behavior used by the spec.

- [x] **Step 2: Implement the pathname snapshot and animation lifecycle**

In `src/components/app-shell.tsx`, query visible eligible cards under `.page-stack`, exclude expandable and modal content, reduce nested matches to the outermost card, and animate each snapshot card with the pinned timing and easing. Cancel prior animations on pathname changes and on unmount. Skip animation for reduced motion or unsupported browsers.

- [x] **Step 3: Verify route entry on the real browser surface**

T3 browser access was disabled for this thread, so use the local Playwright CLI. Check direct load, client-side navigation, a same-route update, reduced motion, unsupported `Element.animate()`, interrupted navigation, and expandable cards. Capture before and after screenshots if the review gate allows a PR.

**Result:** A full direct load of `/dashboard` captured the `Income` card at a 28 ms delay with `fill: "backwards"`, progress `0`, opacity `0.88`, and `translateY(5px)`. Clicking “View accounts” navigated to `/accounts` without changing the document and captured a destination panel at the same delayed values. A same-pathname query update from `/dashboard` to `/dashboard?motion=verify` left all seven completed animation counts at `0`, so it did not replay the entrance. After the fill-mode fix, navigating away changed two active animation states to `idle`.

With reduced motion enabled, the route created no animations. With `Element.animate()` unavailable, it reached `/dashboard` without route errors or active animations. Expanding the archived-bills and category disclosures made no `Element.animate()` calls. Their existing CSS transitions did run on the disclosure chevron and category content. Those styles were present in `src/app/globals.css` before this change and are separate from route entry.

- [x] **Step 4: Run non-test project checks**

Run `npm run typecheck`, `npm run lint`, and `npm run build`. Record each result. Do not add or run tests unless the user asks.

**Result:** `npm run typecheck`, `npm run lint`, and `npm run build` all passed after the fill-mode fix. No application tests were added or run.

### Task 2: Review and deliver

**Files:**
- Modify: approved design spec status and this plan.
- PR: page card entry animation.

**Interfaces:**
- Consumes: verified implementation and browser evidence from Task 1.
- Produces: a reviewed pull request linked to this T3 thread and watched until the PR's blocking review or forge verdict is reached.

- [x] **Step 1: Run the required independent review panel**

Review the complete feature diff before opening the PR. If no reviewer from a different model family is available, record `BLOCKED: independent review` and keep the PR gate closed.

**Result:** Reviewer A (`codex/gpt-6.1-sol`) found no issues. Reviewer B (`codex/gpt-6-luna`) found that `fill: "none"` made delayed cards jump to their starting frame and that this plan lacked verification results. The implementation now uses `fill: "backwards"`. In round two, Reviewer A found no issues. Reviewer B found that the spec and plan disagreed about post-fix cancellation verification. This plan and the spec now record the post-fix browser evidence. Both reviewers are from the GPT family. The live T3 capability catalog lists Claude and Grok as disabled, so a different-family verdict is unavailable. The user explicitly requested PR creation after that limitation was reported.

- [x] **Step 2: Prepare and open the pull request**

Run the repository's required diff cleanup and comment checks, write the title and description using the PR playbook, open the PR after review or explicit user direction, and link it to this T3 thread.

- [ ] **Step 3: Babysit the pull request**

Declare babysit mode and forge before polling. Monitor checks and review threads using the selected forge workflow. Fix actionable findings in one push wave, rerun the required checks, and stop at merge-ready. Do not merge.
