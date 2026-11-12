# Registration

## Sub-features

Create a private owner ledger. The first registered user becomes the instance admin.

## How to get to it (user POV)

Open `/register`, or follow **Create an account** from `/login`.

## Driving it with Playwright

The `drive` command fills **Username** and **Password**, clicks **Create account**, and waits for `/dashboard`. A subsequent account creation must belong to this signed-in owner. The journey uses the direct registration URL. The login link and admin behavior are not covered.

## Gotchas

Use a fresh verification database. Usernames must be 3 to 32 characters and passwords at least 12 characters. Never reuse personal credentials in evidence.
