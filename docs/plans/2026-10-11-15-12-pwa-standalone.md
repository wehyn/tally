# Tally Standalone PWA Implementation Plan

> **For implementers:** Follow repository instructions and the execution method agreed with the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Tally launch from an iPhone Home Screen icon as a full-screen app across all Tally routes, while continuing to require an internet connection.

**Architecture:** Declare a root-scoped standalone web app with a static manifest and install icons. Add metadata in the root layout and include static `public` assets in the standalone Docker image. Keep the current navigation and server behavior unchanged; do not add a service worker.

**Tech Stack:** Next.js 16.4 App Router Metadata API, static Web App Manifest, PNG assets, Vitest, Docker standalone output.

**Spec:** [docs/specs/2026-10-11-14-57-pwa-design.md](../specs/2026-10-11-14-57-pwa-design.md)

## Global Constraints

- Before editing application code, follow `AGENTS.md`: `node_modules` is currently absent, so run `npm ci` without changing the lockfile, then read the installed Next.js guides for the manifest, metadata, icons, and standalone output from `node_modules/next/dist/docs/`.
- Keep the exact manifest values: `name: "Tally"`, `short_name: "Tally"`, `start_url: "/"`, `scope: "/"`, `display: "standalone"`, `theme_color: "#f5f6f2"`, and `background_color: "#f5f6f2"`.
- Include 192×192 and 512×512 PNG manifest icons plus a 180×180 PNG Apple touch icon. Render the CSS brand mark from `src/app/globals.css` (`t` in white Georgia italic on `#256b51`); there is no existing standalone image asset.
- Add the manifest link, iOS Home Screen title `Tally`, Next.js generic capability metadata, and Apple's `apple-mobile-web-app-capable=yes` tag through the supported Metadata API. Preserve `viewportFit: "cover"` and the existing `themeColor` viewport field.
- The `Dockerfile` currently copies `.next/standalone`, `.next/static`, and scripts, but not `public`. Copy `public` into the runner image so the manifest and PNGs are available in the deployed app.
- Do not add dependencies, a service worker, offline caching, queued writes, push notifications, a native wrapper, or navigation changes.

## Review Focus

- **Standalone Docker assets:** Files in `public` will not be available from the current runner image unless copied there. Verify the manifest and all icon URLs from the built container.
- **Unknown Safari handoff:** Repository navigation uses same-origin paths, so the current trigger is unconfirmed. On iPhone, verify each destination's final scheme, host, and port and confirm it stays in the installed window.
- **Stale Home Screen entry:** Test with a fresh icon; if iOS retains old manifest/icon behavior, remove and add the icon again before judging the result.
- **No offline promise:** Confirm there is no service worker or deferred write path and that the delivered UI makes no offline claim.

---

### Task 1: Add the online-only standalone PWA

**Files:**
- Create: `public/manifest.webmanifest`
- Create: `public/tally-pwa-192.png`
- Create: `public/tally-pwa-512.png`
- Create: `public/apple-touch-icon.png`
- Modify: `src/app/layout.tsx`
- Modify: `Dockerfile`
- Test: `tests/pwa-metadata.test.ts`

**Interfaces:**
- `metadata` in `src/app/layout.tsx` links `/manifest.webmanifest`, sets `appleWebApp.capable` to `true` and its title to `Tally`, sets `other["apple-mobile-web-app-capable"]` to `"yes"`, and references `/apple-touch-icon.png`.
- `public/manifest.webmanifest` is a static JSON document containing the exact values in Global Constraints and icon entries for `/tally-pwa-192.png` and `/tally-pwa-512.png` with matching dimensions and `image/png` types.
- The Docker runner serves all files from `/app/public` at their root-relative URL paths.
- Existing mobile navigation in `src/components/app-shell.tsx` remains the in-app route navigation; no new back button or client-side PWA logic is introduced.

- [ ] **Step 1: Install dependencies if absent and read the installed Next.js guidance**

Run: `npm ci`

Then read the installed guides for App Router metadata, manifest files, app icons, and standalone output under `node_modules/next/dist/docs/`. Keep the feature on the APIs supported by this installed version; do not add an explicit `<head>` implementation if the Metadata API can emit the required tags.

- [ ] **Step 2: Write the failing public manifest contract test**

Create `tests/pwa-metadata.test.ts` with assertions for:

1. The parsed static manifest matching the exact app name, launch URL, scope, display mode, theme color, background color, and two required PNG icon entries.
2. PNG signature and IHDR dimensions of 192×192, 512×512, and 180×180 for the referenced assets.

This test owns the browser-facing static manifest and asset contract. Verify rendered root metadata separately through the built app in Step 11 rather than asserting the internal `metadata` object.

- [ ] **Step 3: Run the focused test to verify RED**

Run: `npm test -- tests/pwa-metadata.test.ts`

Expected: FAIL because the manifest and icon assets do not exist yet; the failure should identify the missing public contract, not a test syntax or import error.

- [ ] **Step 4: Add the root metadata and static manifest**

In `src/app/layout.tsx`, add the manifest URL, Apple web app title and capability metadata, Apple-specific capability tag through `metadata.other`, and Apple icon reference without changing the existing viewport. Create `public/manifest.webmanifest` with `start_url` and `scope` both `/`, `display` `standalone`, Tally names, the pinned colors, and the two specified icon paths.

- [ ] **Step 5: Add the three app icon PNGs**

Render the `.brand-mark` design from `src/app/globals.css` into the 192×192 and 512×512 manifest icons and the 180×180 Apple touch icon. Keep the PNG dimensions and brand colors pinned by Global Constraints; add no runtime image-generation dependency.

- [ ] **Step 6: Include public assets in the standalone runner**

Add a `COPY --from=builder --chown=tally:tally /app/public ./public` instruction to the runner stage in `Dockerfile`, alongside the existing standalone and static asset copies.

- [ ] **Step 7: Run the focused test to verify GREEN**

Run: `npm test -- tests/pwa-metadata.test.ts`

Expected: PASS for manifest values, PNG signatures, and all three icon dimensions.

- [ ] **Step 8: Run the full regression suite**

Run: `npm test`

Expected: PASS for the full Vitest suite.

- [ ] **Step 9: Type-check the application**

Run: `npm run typecheck`

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 10: Build the application**

Run: `npm run build`

Expected: exit 0; Next.js accepts the metadata and produces the standalone server.

- [ ] **Step 11: Verify production metadata and static assets in the container**

Choose unique temporary image/container names and build the image. Start it without mounting host data:

```sh
set -euo pipefail
PWA_CHECK_ID="$(date +%s%N)"
PWA_IMAGE="tally-pwa-check:${PWA_CHECK_ID}"
PWA_CONTAINER="tally-pwa-check-${PWA_CHECK_ID}"
cleanup() {
  docker rm -f "$PWA_CONTAINER" >/dev/null 2>&1 || true
  docker image rm "$PWA_IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker build -t "$PWA_IMAGE" .
docker run --rm -d --name "$PWA_CONTAINER" -p 127.0.0.1::3000 \
  -e SESSION_SECRET=tally-pwa-smoke-secret-1234567890abcdef "$PWA_IMAGE"
docker port "$PWA_CONTAINER" 3000/tcp
PWA_SMOKE_PORT="$(docker port "$PWA_CONTAINER" 3000/tcp | cut -d: -f2)"
for attempt in {1..30}; do
  curl -fsS "http://127.0.0.1:${PWA_SMOKE_PORT}/api/health" >/dev/null && break
  sleep 1
done
curl -fsS "http://127.0.0.1:${PWA_SMOKE_PORT}/manifest.webmanifest"
curl -fsSI "http://127.0.0.1:${PWA_SMOKE_PORT}/tally-pwa-192.png"
curl -fsSI "http://127.0.0.1:${PWA_SMOKE_PORT}/tally-pwa-512.png"
curl -fsSI "http://127.0.0.1:${PWA_SMOKE_PORT}/apple-touch-icon.png"
curl -fsS "http://127.0.0.1:${PWA_SMOKE_PORT}/login" | python3 -c '
from html.parser import HTMLParser
import sys

class Metadata(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []

    def handle_starttag(self, tag, attrs):
        if tag in {"link", "meta"}:
            self.tags.append((tag, dict(attrs)))

parser = Metadata()
parser.feed(sys.stdin.read())
tags = parser.tags
checks = {
    "manifest link": any(tag == "link" and attrs.get("rel") == "manifest" and attrs.get("href") == "/manifest.webmanifest" for tag, attrs in tags),
    "generic capability": any(tag == "meta" and attrs.get("name") == "mobile-web-app-capable" and attrs.get("content") == "yes" for tag, attrs in tags),
    "Apple capability": any(tag == "meta" and attrs.get("name") == "apple-mobile-web-app-capable" and attrs.get("content") == "yes" for tag, attrs in tags),
    "Apple title": any(tag == "meta" and attrs.get("name") == "apple-mobile-web-app-title" and attrs.get("content") == "Tally" for tag, attrs in tags),
    "Apple icon": any(tag == "link" and attrs.get("rel") == "apple-touch-icon" and attrs.get("href") == "/apple-touch-icon.png" for tag, attrs in tags),
    "viewport-fit": any(tag == "meta" and attrs.get("name") == "viewport" and "viewport-fit=cover" in attrs.get("content", "") for tag, attrs in tags),
    "theme color": any(tag == "meta" and attrs.get("name") == "theme-color" and attrs.get("content") == "#f5f6f2" for tag, attrs in tags),
}
missing = [name for name, passed in checks.items() if not passed]
if missing:
    raise SystemExit("Missing rendered metadata: " + ", ".join(missing))
print("All rendered PWA metadata assertions passed")
'
```

Expect successful responses from all asset URLs and `/login` HTML matching the manifest, both standalone capability tags, Apple title, Apple touch icon, and existing viewport metadata. The `EXIT` trap stops and removes only this check's temporary container and image on success or failure.

- [ ] **Step 12: Verify the iPhone acceptance path**

On the owner's iPhone, open the updated Tally origin in Safari, add it to the Home Screen with **Open as Web App** enabled, then launch the icon. Verify signed-in launch reaches `/dashboard`, signed-out launch reaches `/login`, and each visible mobile navigation item stays in the same full-screen app window with no Safari controls. Verify the same origin remains usable when opened in a normal Safari tab. Record the iOS version and final URL for each route. If iOS uses the old appearance, remove and re-add the Home Screen icon before repeating.

- [ ] **Step 13: Confirm online-only scope**

Review the final diff and built output for any service worker, offline cache, queued write, push, or background-sync behavior. Expected: none; Tally continues to require a network connection.

## References

- [Next.js PWA guide](https://nextjs.org/docs/app/guides/progressive-web-apps)
- [Next.js manifest metadata file](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/manifest)
- [Next.js Metadata API](https://nextjs.org/docs/app/api-reference/functions/generate-metadata)
- [Next.js standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
