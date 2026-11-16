# Forma Studio

Forma Studio is a single-user local web app for turning a brand kit and a marketing brief into a square animated ad. A designer can explore several directions with the same brand assets, choose one, and review a working creative in the browser.

## Creative workflow

1. **Upload the brand kit.** Drag in files or a folder. The app preserves nested paths so the creative can reference supplied logos, fonts, images, and other assets.
2. **Develop the brief.** Enter a scenario and visual style, or ask the selected model to draft them. The style picker proposes three distinct visual directions with square SVG previews. The user can choose a direction and edit its description before generating the ad.
3. **Build the creative.** The model generates one responsive HTML document that recomposes for every selected format (1:1, 4:5, 9:16, 16:9, 5:4, 1.91:1) and plays a deterministic `window.renderFrame(t)` timeline of the chosen length. With an OpenRouter key it can generate and self-check images and video clips. The runtime provides Three.js and its addons, GSAP, and Lottie alongside browser-native SVG and Canvas.
4. **Review the result.** The app scales the composition into a square, sandboxed preview on a separate origin. Each build saves its HTML and assets locally, and the browser can restore the last preview.

## Generation modes

Claude uses the Claude Agent SDK. Codex uses a locally installed Codex CLI. The interface supports model and reasoning-effort selection, with API-key or local subscription authentication. During live generation, the provider can receive the brief and brand material the model reads. Demo mode uses a bundled animation to exercise uploads and preview rendering without a model call.

## Working on the app

- Start with `public/` for upload interactions, brief editing, style selection, and preview controls.
- Use `server.mjs` for request handling, project storage, and serving preview assets. `generator.mjs` and `codex.mjs` handle the respective provider integrations.
- Look in `creative.mjs` for shared creative instructions and style generation, `motion.mjs` for formats, the in-creative `window.FORMA` runtime and the postMessage playback controller, `media.mjs` for OpenRouter image/video tools (`media-mcp.mjs` exposes them to Codex over stdio MCP), and `models.mjs` for model choices.
- Use Node.js 22.9 or newer. From this directory, run `npm ci` on first setup, then `npm start`. Open `http://127.0.0.1:4317`. The preview server defaults to port 4318.
- `pricing.mjs` holds API list prices for cost estimates. The revision chat lives in `POST /api/history/:id/revise`: Claude edits a temp working copy (`generator.mjs` `revise`), and Codex returns full HTML.
- Storage goes through `store/index.mjs`, selected by `FORMA_STORE`: `file` (default; one JSON per entry in `DATA_DIR/history/`, files on disk), `supabase` (Postgres entries + asset index + runs, all bytes and logs in Cloudflare R2), or `memory` (test-only fake of the supabase driver). `history.mjs` re-exports `store.history`, and **every history call is async**. `jobs.mjs` holds the live journal and flushes events to `runs`/`run_events` in cloud mode.
- Cloud sync happens at the edges, not in writers: `store.sync.down(project)` before a model job, `store.sync.up(project)` after it, and the entry is recorded only after the upload. The preview origin reads through to R2 on a cache miss. Local `DATA_DIR/<project>/<rel>` maps to the R2 key `projects/<project>/<rel>`; logs live at `logs/<entryId>.json`.
- Campaigns hold style variants (`variants[]`, `activeVariant`) that share one scenario. `upgradeCampaign` converts old single-style docs.
- Schema changes go in a new file in `supabase/migrations/`; bump `schema_meta.forma_schema` only for breaking changes. `scripts/migrate-to-cloud.mjs` / `scripts/pull-from-cloud.mjs` (core in `scripts/lib/cloud-migrate.mjs`) move data between local and cloud; both are idempotent, and neither deletes local files. Owner-facing steps live in `docs/cloud-runbook.md`.
- Keep credentials in the environment or the ignored `.env` file. Generated projects live under `data/` by default. Set `DATA_DIR` to place them on a persistent volume when running in a container.
