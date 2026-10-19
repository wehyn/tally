# Page card entry animation design

- **Status:** Awaiting review
- **Date:** 2026-10-19
- **Scope:** Add a short entrance animation to visible page cards when a user enters an app route.

## Goal

Give each screen a calm entrance that draws attention to its content cards without delaying access to the ledger. Keep route views and their local state unchanged.

## Decisions

- Trigger the animation from the pathname that `AppShell` already reads with `usePathname()`.
- Capture one `RouteEntrySnapshot` per committed pathname. It contains the pathname and the visible card elements present in `main.page-content` at that time.
- Select `.panel`, `.stat-card`, `.account-card`, `.goal-card`, `.admin-card`, `.debt-summary-card`, and `.section-destination` elements inside `.page-stack`. Animate only the outer card when matching cards nest.
- Leave the `.archived-disclosure` and `.category-manager-collapsible` cards still because users can expand them in place. Exclude cards inside `.modal-backdrop` and `.modal-card`. The assistant drawer stays outside the selection root.
- Use the Web Animations API for a 220 ms fade from 0.88 opacity and a 5 px vertical offset. Stagger cards by 28 ms in document order, with a maximum delay of 112 ms.
- Skip the animation when the user requests reduced motion or the browser does not support `Element.animate()`.
- Cancel unfinished animations when the pathname changes or `AppShell` unmounts. Do not hide server-rendered content before client code runs.
- Keep the selector, snapshot, and animation policy in `src/components/app-shell.tsx`. Do not add a dependency or change route-view markup.

## Design

`AppShell` owns a ref to `main.page-content`. A private `usePageCardEntry` hook runs a `useLayoutEffect` when the current pathname changes. The effect queries the current route's `.page-stack` descendants, filters out hidden cards, modal content, and expandable cards, then keeps only outermost card elements.

The snapshot shape is:

```ts
type RouteEntrySnapshot = {
  pathname: string;
  cards: HTMLElement[];
};
```

The hook applies this Web Animations keyframe pair to each selected card:

```ts
[
  { opacity: 0.88, transform: "translateY(5px)" },
  { opacity: 1, transform: "translateY(0)" },
]
```

Use `cubic-bezier(.22,.8,.2,1)` and `fill: "none"`. The delay for card index `i` is `Math.min(i * 28, 112)` milliseconds. A pathname change cancels the previous snapshot's unfinished animations before taking a new snapshot. A data refresh or interaction on the same pathname does not run the effect again. Cards inserted after the snapshot stay still.

The hook does not key or remount `children`. Route views keep their existing state behavior. If the installed Next.js App Router commits the pathname before it commits destination content, browser verification will reveal that mismatch before the change ships.

## Alternatives considered

| Design | Decision |
| --- | --- |
| CSS selectors animate matching cards when they mount | Rejected because a card inserted by a same-route interaction could animate like a new screen. |
| Fade the whole `.page-content` region | Rejected because headings and controls move with the cards, and individual cards do not enter in sequence. |
| Take one pathname-scoped card snapshot and animate it with Web Animations | Chosen because it leaves route state alone and ignores cards added by later same-route updates. |

## Compatibility and failure handling

- If reduced motion is enabled, do not create animations. The content remains visible in its normal position.
- If `Element.animate()` is unavailable, leave the cards visible and skip motion.
- If navigation interrupts the entrance, cancel each unfinished animation so it cannot affect the next route.
- If an expandable card appears in the selector, add an explicit exclusion and verify the expanded flow in the browser.
- Cards added after route entry stay still by design. This keeps search, loading, and local interaction updates from replaying the screen entrance.

## Open questions and risks

- Does the installed Next.js 16.4 App Router commit the destination cards before the `AppShell` layout effect runs on client-side navigation? The browser check must answer this. If the effect sees the outgoing page, move the snapshot to the right route boundary without keying or remounting `children`.
- Do the app's server-rendered route views include all initial cards in their first client commit? A card that arrives later stays still by design. Confirm that behavior in the browser for each card group.

## Acceptance criteria

1. Directly loading an app route leaves every card visible and starts the entrance for eligible cards.
2. Navigating to a different pathname starts one entrance for the destination route's eligible cards.
3. A same-route data refresh or interaction does not restart the entrance.
4. Archived bills and collapsible categories do not move when the route loads or when users expand them.
5. Reduced-motion users receive no card movement or stagger.
6. The animation changes only opacity and transform. It does not shift layout or change focus order.

## Verification

Before implementation, read the installed Next.js 16.4 documentation referenced by `AGENTS.md`. Verify the entrance in a browser on direct load and client-side navigation. Check a same-route update and the reduced-motion setting. Inspect the page during navigation to confirm the snapshot targets destination cards.

## Delivery

After implementation, open a pull request and babysit its checks and review comments until it is ready for the user. Do not merge it.
