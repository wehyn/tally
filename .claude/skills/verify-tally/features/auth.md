# Sign in and registration

People create an account at `/register` (the first account on an instance becomes the admin), sign in at `/login`, sign out from the account menu, and recover access at `/reset` with a one-time credential issued by the admin.

## Sub-features

- `auth-register` creates a user and lands on `/dashboard`.
- `auth-login` signs in an existing user.
- `auth-logout` ends the session.
- `auth-reset` sets a new password with an admin-issued one-time credential.
- `auth-guard` redirects signed-out visitors away from app pages.

## How to get to it (user POV)

- Open `/` or any app page while signed out. You are sent to sign in.
- On `/login`, choose `Create an account` (to `/register`) or `Use a one-time password reset` (to `/reset`).
- Sign out from the `<username> account menu` button in the sidebar.

## Driving it with Playwright (bin/driver.mjs)

Preconditions: the seeded `verifier` exists. For `auth-reset`, an admin must first issue a reset credential on `/admin`.

- **Sign in.** `t.login()` fills `getByLabel("Username")` and `getByLabel("Password", { exact: true })`, clicks the `Sign in` button, and waits for the URL `**/dashboard`.
- **Register a second user.** Go to `/register` and fill `Username` with `user-${t.nonce}`. Usernames are 3–32 characters, so keep the nonce short or slice it. Fill a password of at least 12 characters and click `Create account`. Expect `/dashboard`. Prove it with `t.db("SELECT role FROM users WHERE username = ?", name)`, which should be `user`, not `admin`.
- **Wrong password.** On `/login`, submit a bad password. A `role="alert"` box appears with the error, and the URL stays `/login`.
- **Guard.** In a fresh context (no cookies), `page.goto("/transactions")` ends on `/login`.

## Gotchas

- `getByLabel("Password")` without `exact` also matches the `Show password` toggle button.
- Login, register, and reset are throttled per server-wide bucket in direct (non-proxy) mode. Many failed attempts in one run can lock further attempts. Relaunch rather than wait.
- The first registered user is admin. The seed already took that slot, so `auth-register` always creates a regular user.
