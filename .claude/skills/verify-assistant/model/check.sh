#!/bin/sh
# Replays the facts Assistant.tla assumes against the real store, route and runAssistantPrompt.
# Run from anywhere; needs the repo's node_modules (npm ci) and Node.
set -e
cd "$(dirname "$0")/../../../.."
exec npx vitest run --config .claude/skills/verify-assistant/model/vitest.config.ts "$@"
