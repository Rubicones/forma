# Forma Studio — Shared cloud store (Supabase + Cloudflare R2) and style variants

You are extending **Forma Studio** (repo `outputs/forma`). Flow v2 (campaigns, `campaigns.mjs`, the stepper UI) is already implemented. Read `AGENTS.md`, `README.md`, `docs/flow-v2-prompt.md`, `history.mjs`, `campaigns.mjs`, `server.mjs`, `media.mjs`, `media-mcp.mjs` and `public/player.js` before writing code.

There are two goals:
1. **Shared store.** All metadata and history live in **Supabase Postgres**. All bytes (brand assets, generated images and videos, attachments, creative HTML, logs) live in **Cloudflare R2**. Two people each run the app locally against the same Supabase + R2, and each sees the other's campaigns, runs and files. Existing local data, including every current run, must be migrated with a safe, resumable script. You also write the owner a complete runbook.
2. **Style variants.** Rebuilding the visual style must never replace the previous one. A campaign holds several style variants that share one scenario. The player gets a **«Стиль»** switcher next to «Формат» / «Язык» / «Длина», because the beats are identical across variants.

---

## 0. Ground rules
- UI strings are in Russian. Code, comments, identifiers and prompts are in English.
- Allowed new dependencies: **only** `@supabase/supabase-js` and `@aws-sdk/client-s3`. Update `package-lock.json` with `npm install`. Use the Supabase CLI through `npx supabase` for migrations; do not add it as a dependency.
- **Default behaviour must not change.** `FORMA_STORE=file` (the default) keeps everything on local disk exactly as today. `FORMA_STORE=supabase` switches to the cloud.
- Secrets stay on the server. The Supabase service-role key and the R2 keys never reach the browser, logs or the journal.
- Verify with code only: `node --check`, `npm test`, a server boot with curl. No screenshots and no browser automation; the owner checks visuals.
- Never delete local `data/`. After migration it remains a backup, and in cloud mode it becomes a cache.
- Implement the milestones in §9 in order. After each one, run its checks, report what changed and the test results, and wait for "go".

---

## 1. Target architecture

```
Browser ──► local Express app (4317) ──► Store driver ──┬─► Supabase Postgres  (entries, campaigns, projects, asset index, runs, run events)
                │                                       └─► Cloudflare R2      (all bytes, key = projects/<project>/<relative path>, logs/<entryId>.json)
                └─► preview origin (4318) /p/*  ──► local cache (DATA_DIR) ──miss──► R2 (read-through)
Agent tools (Read, Codex, media-mcp) keep working on local files; the cache is synced down before a job and up after it.
```

**Key decisions (follow them):**
1. **Local disk is a cache, R2 is the source of truth.** The mirror layout is identical: the local file `DATA_DIR/<project>/<rel>` corresponds to the R2 key `projects/<project>/<rel>`. Every existing URL (`/p/<project>/<rev>.html`, the relative `assets/...` inside creatives) keeps working unchanged.
2. **Sync at the edges, not inside every writer.** Do not rewrite every `fs.writeFile`. Use:
   - `syncDown(project)` before any model job, so tools see every asset locally;
   - `syncUp(project)` after any job or upload: walk the project dir, upload new or changed files and upsert the asset index;
   - a read-through cache on the preview origin.
   An entry is recorded **only after** `syncUp` succeeds, so a colleague never sees an entry whose files are missing.
3. **Entries keep their JSON shape.** Postgres stores the whole entry (minus `log`) in a `doc jsonb` column, plus indexed columns derived from it. The `history.mjs` interface (open, record, update, get, list, thread, findBy, importExisting) stays the same, but **becomes async everywhere**.
4. **Logs move to R2** (`logs/<entryId>.json`). The DB keeps only `log_size`. `get(id)` loads the log lazily, only when the caller asks for it.
5. **Cross-instance correctness.** The in-process `runningJob` map is not enough with two machines. Use a DB-backed run lock (§3.3) and optimistic concurrency on campaign updates (`version`).

---

## 2. Store abstraction (`store/`)

Create `store/index.mjs`, which exports a driver chosen by `FORMA_STORE`:
```js
export const store = {
  history: { open, record, update, get, list, thread, findBy, importExisting },   // all async
  blobs:   { put(key, bufOrStream, {contentType, sha256}), get(key) /* stream */, head(key), list(prefix), url?(key) },
  assets:  { index(project) /* [{path,size,sha256,kind}] */, upsert(project, rows), remove(project, path) },
  runs:    { start({id, campaignId, projectId, task, author}), heartbeat(id, patch), events(id, batch), finish(id, status), active(), get(id, since) },
  sync:    { down(project), up(project, {kind}) },
};
```
- **`store/file.mjs`:** today's behaviour. `history` is the current `history.mjs` logic, made async. `blobs` is the local fs. `sync` does nothing. `runs` is in memory (today's `jobs.mjs` and `runningJob`).
- **`store/supabase.mjs`:** Postgres through `@supabase/supabase-js` (service-role key; `persistSession:false`) plus R2 through `@aws-sdk/client-s3` (`region:'auto'`, `endpoint: https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).
- **`history.mjs`** becomes a thin re-export of `store.history`. **Update every call site to `await`.** Known synchronous uses today: `history.list(...)` in `server.mjs` (`GET /api/history`) and `campaigns.mjs` (`GET /api/campaigns`), and `history.findBy(...)` in `server.mjs` (`import-local`). Grep for all of them.
- `history.get(id, {withLog:true})` loads the log. Without the option it returns `log: []` and `logSize`. Endpoints that show a journal (`GET /api/history/:id`, the «Журнал» button) pass `withLog:true`.

### 2.1 Sync rules
- **Classifying a file** (stored in `assets.kind`): `assets/generated/**` → `generated`; `assets/revisions/**` → `attachment`; any other `assets/**` → `upload`; `<uuid>.src.html` → `source`; `<uuid>.html` → `creative`. **Excluded:** `draft.html`, `*.tmp`, dotfiles, anything outside `DATA_DIR/<project>/`.
- **`up(project)`:** walk the project dir. For each file not in the index, or whose size differs, compute sha256 and compare with the index; when it differs, `PutObject` (with a `ContentType` from the extension and metadata `sha256`) and upsert the row. Run up to 4 uploads in parallel and retry 3 times with backoff.
- **`down(project)`:** for each indexed row, download it when the local file is missing or its size differs; write to `.part`, then rename. Run up to 6 downloads in parallel.
- **Where to call them:**
  - `PUT /api/projects/:id/file` → after the local write, `up` that one file.
  - Every model job (legacy render, revise, every campaign step) → `down` before, `up` after the model returns and the files are written, then `record`/`update` the entry.
  - `media.mjs` and `media-mcp.mjs` keep writing locally; the post-job `up` covers them.
- **Preview origin read-through:** replace `preview.use('/p', express.static(data…))` with middleware that serves the local file when it exists. Otherwise it fetches `projects/<rest>` from R2, streams it to the response **and** to the cache (atomic rename), then serves it with the same security headers and the same `Content-Type` logic. It returns 404 when the object is missing. Keep the `/p/history` 404 guard.

---

## 3. Database schema (Supabase migrations)

Create `supabase/config.toml` (run `npx supabase init` and commit it) and `supabase/migrations/20261116000001_forma_init.sql`:

```sql
-- Forma Studio shared store. Server-side access only (service role). RLS is on with no policies, so anon and authenticated roles are denied.
create table if not exists projects (
  id uuid primary key,
  created_at timestamptz not null default now(),
  author text,
  name text
);

create table if not exists assets (
  project_id uuid not null references projects(id) on delete cascade,
  path text not null,                         -- relative to the project dir, e.g. 'assets/logo.svg', 'f3…e1.html'
  kind text not null check (kind in ('upload','generated','attachment','creative','source')),
  size bigint not null,
  sha256 text not null,
  content_type text,
  author text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, path)
);

create table if not exists entries (
  id uuid primary key,
  type text not null check (type in ('scenario','style','preview','creative','campaign')),
  status text,
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  version integer not null default 1,         -- optimistic concurrency for mutable docs (campaigns)
  author text,
  project_id uuid,                            -- no FK: legacy entries may reference projects created before the index
  campaign_id uuid,
  parent_id uuid,                             -- input.revision.parent
  output_path text,                           -- output.path, for lookups by preview URL
  log_size integer not null default 0,
  doc jsonb not null                          -- the full entry minus log, exactly as history.mjs returns it
);
create index if not exists entries_type_created on entries (type, created_at desc);
create index if not exists entries_campaign on entries (campaign_id, created_at);
create index if not exists entries_project on entries (project_id);
create index if not exists entries_parent on entries (parent_id);
create index if not exists entries_output_path on entries (output_path);
create index if not exists entries_author on entries (author);

create table if not exists runs (
  id uuid primary key,                        -- requestId
  campaign_id uuid,
  project_id uuid,
  entry_id uuid,                              -- set when the run produced an entry
  task text not null,
  author text,
  status text not null check (status in ('running','done','error','cancelled')),
  status_text text,
  costs jsonb,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists runs_one_active_per_campaign on runs (campaign_id) where status = 'running' and campaign_id is not null;
create index if not exists runs_active on runs (status, heartbeat_at desc);

create table if not exists run_events (
  run_id uuid not null references runs(id) on delete cascade,
  i integer not null,
  at_ms integer not null,
  level text not null,
  msg text not null,
  detail text,
  media jsonb,
  cost jsonb,
  primary key (run_id, i)
);

create table if not exists schema_meta (key text primary key, value text);
insert into schema_meta(key, value) values ('forma_schema', '1') on conflict (key) do update set value = excluded.value;

alter table projects   enable row level security;
alter table assets     enable row level security;
alter table entries    enable row level security;
alter table runs       enable row level security;
alter table run_events enable row level security;
alter table schema_meta enable row level security;
```
Add an RPC for safe campaign updates (`supabase/migrations/20261116000002_forma_rpc.sql`):
```sql
-- Compare-and-set update of a mutable entry. Returns the new row, or nothing if the version moved.
create or replace function forma_update_entry(p_id uuid, p_expected integer, p_doc jsonb, p_campaign uuid, p_parent uuid, p_output_path text, p_status text)
returns setof entries language sql as $$
  update entries
     set doc = p_doc, version = version + 1, updated_at = now(),
         campaign_id = p_campaign, parent_id = p_parent, output_path = p_output_path, status = p_status
   where id = p_id and version = p_expected
  returning *;
$$;
```
On startup, `store/supabase.mjs` checks `schema_meta.forma_schema === '1'`. If not, it fails fast with: «База Supabase не подготовлена — выполните npx supabase db push (см. docs/cloud-runbook.md)».

### 3.1 Column mapping (`entryToRow` / `rowToEntry`)
- `id`, `type`, `status`, `created_at` ← `createdAt`, `author`;
- `project_id` ← `project`;
- `campaign_id` ← `campaign` (or `id` itself for a campaign row);
- `parent_id` ← `input.revision.parent`;
- `output_path` ← `output.path`;
- `log_size` ← `log.length`;
- `doc` ← the entry without `log`.

`rowToEntry` returns `{...doc, logSize, version}`. Round-tripping must be lossless; unit-test it on every fixture and on a sample of real entries.

### 3.2 `list` and `thread` in Postgres
- **`list({type, project, path, before, limit, author})`:** filter on the indexed columns, order `created_at desc`, page with `before`. It returns `{items, next, total}`; `total` comes from a `count: 'exact', head: true` query on the same filter.
- **`thread(id)`:** walk `parent_id` with a recursive CTE through an RPC `forma_thread(p_id uuid)` (add it to migration 2), up to 50 steps, oldest first.

### 3.3 Runs: locking and live view across machines
- **Starting a run:** `runs.start` inserts a row with `status='running'`. The partial unique index makes a second active run on the same campaign fail; map that error to 409 «Дождитесь окончания текущего шага (запущен <author>).» This replaces `acquireJob` / `ensureIdle` in cloud mode. `ensureIdle` becomes async.
- **Heartbeat:** every 10 s, plus a status-text update. A run whose `heartbeat_at` is older than 120 s is dead: the next `start` on that campaign first marks it `error` with «Процесс прервался» and then proceeds.
- **Events:** batch the job journal events (`jobs.mjs` logger) into `run_events` every 1 s, up to 100 rows per insert. Logs are always kept locally first; DB flushing is best effort and never fails the job.
- **Finish:** `finish` sets status, `finished_at`, `costs` and `entry_id`, then uploads the full log to R2 as `logs/<entryId>.json`.
- **`GET /api/render-progress/:id`:** reads the local job when it exists; otherwise (a colleague's run) `runs.get(id, since)`. The response shape is the same, without `draft`/`tail`.
- **New `GET /api/runs/active`:** running runs from all authors, for the UI indicator (§6.3).

### 3.4 Optimistic concurrency
- `history.update(id, patch)` on the supabase driver reads `{doc, version}`, merges the patch exactly like the file driver, then calls `forma_update_entry` with the expected version. On conflict it re-reads and retries once. If it still conflicts, it throws 409 «Кампанию только что изменил <author> — обновите страницу».
- Immutable entries (everything except `campaign`) are only inserted, never updated, except for `copy` re-injects, which already create new entries.

---

## 4. Style variants (works on both drivers)

### 4.1 Data shape
Campaign `doc` changes from single `steps.styles/preview/final` to:
```js
steps: { scenario: {entryId, approvedAt, stale, needs} },   // shared by all variants
variants: [
  { id, label,                       // label = chosen style name, editable
    createdAt, author,
    styles:  {entryId, chosenIndex, direction},
    preview: {entryId, approvedAt, stale},
    final:   {entryId, stale},
    cost:    {llm, image, video, total, unknown} }
],
activeVariant: '<variant id>'
```
- **`upgradeCampaign(doc)`:** a pure function that converts the old shape into `variants:[{id: randomUUID(), label: <chosen style name or 'Стиль 1'>, styles, preview, final}]` and sets `activeVariant`. Call it on every read (`requireCampaign`, `hydrateCampaign`, list). It is written back naturally on the next update, and the migration script applies it eagerly.
- **`hydrateCampaign`** keeps returning `steps.styles/preview/final` and `entries.{styles,preview,final}` **for the active variant**, so existing client code keeps working. It additionally returns `variants` (light: id, label, author, the chosen style's name/idea/svg, preview/final ids and paths, approved and stale flags, cost) and `activeVariant`.

### 4.2 Behaviour
- **Scenario:** one per campaign. Editing or regenerating it marks **every** variant's preview and final stale.
- **New variant:** a «Новый стиль» action in Step 2 does either of these:
  - (a) **«Новые 3 направления»**: a new styles entry, which creates a new variant that becomes active; the old variants stay untouched;
  - (b) **«Другое направление из этих трёх»**: picking a different index from the current styles entry. If the active variant already has a preview, this creates a new variant sharing the same `styles.entryId` with a different `chosenIndex`. If it has no preview yet, it just changes `chosenIndex` in place.
- A variant that has a preview is **never mutated** by a style choice; only new variants are created.
- **Gating per variant:** a preview requires an approved scenario plus `variant.styles.chosenIndex`; a final requires `variant.preview.approvedAt && !variant.preview.stale`. One job per campaign at a time, as now.
- **Endpoints:**
  - `POST /api/campaigns/:id/variants {stylesEntryId?, index, direction?, label?}` → creates a variant and makes it active.
  - `PATCH /api/campaigns/:id {activeVariant}` switches the active variant; it is allowed while idle only.
  - `PATCH /api/campaigns/:id/variants/:vid {label}` renames.
  - All step endpoints accept an optional `variant` (default: active) and act on it.
  - `/styles` (new directions) always creates a new variant when the active one already has a preview.
- **Costs:** per variant and rolled up to the campaign total.
- **Revision chat:** per entry, as now. Because preview and final entries belong to one variant, the thread follows the selected variant automatically.
- **Fork:** keep `POST /api/campaigns/:id/fork` for «Копия кампании», but remove the «ветка» flow for styles from the UI (`handleForkAndBuildPreview` and `#forkFromStep2Btn` in `public/app.js`). Replace it with the variants flow above.

### 4.3 UI
- **Player (`public/player.js` `renderSwitchers`):** add a first chip row **«Стиль»**, before «Формат» / «Язык» / «Длина».
  - It is shown when the campaign has ≥ 2 variants with a result for the stage on screen: previews in Step 2, finals in Step 3, falling back to previews.
  - Each chip shows a 14 px swatch, which is the variant's SVG keyframe as a tiny image, plus the label, with a ✓ (approved) or ⚠ (stale) marker. The tooltip holds the style idea and the author.
  - Switching **keeps format, language, length and current time** (same beats → same timeline), loads that variant's entry, makes it active (PATCH), and re-renders the chat thread for it.
  - Keyboard: `S` cycles variants when the stage has focus.
- **Step 2 panel:** a compact **«Стили кампании»** strip above the three direction cards, listing the existing variants (swatch, label, status) as selectable rows; the active one is highlighted. Below it sit two buttons: «Новые 3 направления» and «Выбрать другое направление» (the second enables the cards for a new variant). Rename the label inline.
- **Stepper:** Steps 2 and 3 show the active variant's status. A small «Стиль: <label> ▾» menu next to the stepper switches variants (same action as the player chips).
- **History drawer:** the campaign card lists variants as small swatch chips with their status; clicking a chip opens the campaign with that variant active.

---

## 5. Authors and multi-user UX
- **`FORMA_AUTHOR`** (env, required in cloud mode, e.g. `Дмитрий`) is written to `author` on every entry, variant, run, project and asset row.
- **History drawer:** filter chips «Все · Мои · Коллег», plus the author shown on every card («Дмитрий · 11:20»).
- **Freshness:** while the drawer is open, refresh it every 15 s. While a campaign is open and idle, poll `GET /api/campaigns/:id` every 10 s. If `version` changed, re-hydrate and show a toast «Обновлено: <author> изменил кампанию».
- **Running indicator:** `GET /api/runs/active` every 10 s drives a pill in the topbar, «Идёт: 1» (with a popover listing author · campaign · step · elapsed). Clicking an entry opens that campaign and attaches the journal to the colleague's run, read-only, through `render-progress` polling.

---

## 6. Migration script: `scripts/migrate-to-cloud.mjs`

Run it with `node --env-file=.env scripts/migrate-to-cloud.mjs [--apply] [--merge-style-forks] [--concurrency 4]`.
- **Dry run by default.** It prints what would happen, then exits.
- **Idempotent and resumable.** Re-running skips what is already done: an R2 object with an equal size and `sha256` metadata, or an entry row with an equal `doc` hash.

**Steps, in order:**
1. **Preflight.**
   - Env present: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `R2_*`, `FORMA_AUTHOR`.
   - DB reachable and `schema_meta` = 1; R2 bucket reachable (`HeadBucket`).
   - Local `DATA_DIR` readable.
   - Print a summary: projects, files by kind with total bytes, entries by type, campaigns, plus orphan files referenced by no entry (still migrated).
2. **Projects.** Each `DATA_DIR/<uuid>/` → upsert into `projects` (author = `FORMA_AUTHOR`; `created_at` = the dir's birthtime or mtime).
3. **Files.** Every file per §2.1 classification → sha256 → `PutObject projects/<project>/<rel>` → upsert into `assets`. Print a progress line every 25 files (count, MB, ETA).
4. **Entries.** Every `DATA_DIR/history/*.json`:
   - campaigns get `upgradeCampaign` applied;
   - the log is uploaded to `logs/<id>.json`;
   - the row is upserted (columns per §3.1, `author` = `FORMA_AUTHOR`).
   - Order: non-campaign entries first, then campaigns.
5. **Merge style forks (`--merge-style-forks`).** Campaigns that share the same `steps.scenario.entryId` and were created by `fork` (the name ends with « (копия)», « (ветка)» or a « (<style name>)» suffix, **or** the scenario id matches) merge into the earliest campaign:
   - their single variant is appended to its `variants`;
   - the merged campaign docs get `status:'merged'` and `mergedInto` (they are kept, never deleted);
   - the dry run prints the merge plan first.
6. **Verify.**
   - Row counts equal local counts per type.
   - Every entry's `output.path` exists in R2 (`HeadObject`).
   - 10 random files are downloaded and their sha256 compared.
   - Every campaign's referenced entry ids exist.
   - `thread()` works for every revision chain.
7. **Report.** Write `DATA_DIR/migration-report.json` (counts, bytes, skipped, failures, merge plan) and print the next steps (switch `FORMA_STORE`, restart).

The script never deletes or modifies local files, except writing the report.

---

## 7. Runbook for the owner: write `docs/cloud-runbook.md` (in Russian)

It must be a complete, copy-paste-ready guide with these sections:
1. **Что понадобится:**
   - a Supabase project (region close to Belgrade, e.g. Frankfurt);
   - a Cloudflare account with R2 enabled;
   - Node 22;
   - 10–15 minutes.
2. **Supabase:**
   - create the project;
   - where to copy the `Project URL`, the `service_role` key and the DB connection string (Settings → API / Database; note that the menu wording may change);
   - `npx supabase login`, `npx supabase link --project-ref <ref>`, `npx supabase db push`;
   - how to check that the `forma_schema` row exists.
3. **Cloudflare R2:**
   - create a private bucket `forma`;
   - create an R2 API token with Object Read & Write limited to that bucket;
   - copy the Account ID, Access Key ID and Secret;
   - no public access and no CORS needed (the local server proxies everything).
4. **`.env`:** the full block of new variables with comments, `FORMA_STORE=supabase`, `FORMA_AUTHOR`, and a warning never to commit `.env`, plus how to pass keys to a colleague (a password manager, not chat).
5. **Выгрузка текущих данных:**
   - make a backup copy of `data/`;
   - dry run;
   - read the plan;
   - `--apply`, then `--merge-style-forks` if wanted;
   - what the report means;
   - how to re-run safely after a failure.
6. **Переключение:** `FORMA_STORE=supabase`, restart, and what to check (history count, open an old creative, open a campaign with variants, run a demo campaign end to end, check that the colleague sees it).
7. **Коллега:**
   - clone the repo, `npm ci`, the `.env` with the shared Supabase/R2 values plus their own `FORMA_AUTHOR` and their own Anthropic key or Claude subscription login, `npm start`;
   - the first open of a project downloads its files into the local cache.
8. **Как это работает:** a short explanation of cache and sync, live runs, locks and conflicts, in plain words.
9. **Откат:** set `FORMA_STORE=file` → the app runs on the untouched local `data/`. Note that runs made in cloud mode exist only in the cloud, and give a `scripts/pull-from-cloud.mjs` command (implement it: it downloads every entry, log and file into a fresh `DATA_DIR`).
10. **Стоимость и лимиты:**
    - current data size (from the dry run);
    - what counts against the Supabase free tier (the DB is small because bytes and logs live in R2);
    - R2 storage pricing and free egress;
    - the owner should check the current prices on the providers' pricing pages.
11. **Безопасность:**
    - the service-role key gives full DB access and lives only in the server `.env`;
    - RLS denies everything else;
    - rotate the keys if they leak (where to rotate them).

---

## 8. Configuration
Add to `.env.example`, commented:
```
# Store: file (local data/) or supabase (Supabase Postgres + Cloudflare R2, shared with colleagues)
FORMA_STORE=file
FORMA_AUTHOR=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=forma
# Optional: local cache dir in cloud mode (defaults to DATA_DIR)
# CACHE_DIR=
```
`GET /api/status` gains `store: {driver, author, ready, error?}`. The topbar's «Локальный стенд» becomes «Облако · <author>» in cloud mode, with a red dot and an error tooltip when the store is unreachable.

---

## 9. Milestones
1. **Async history.** `store/` with the file driver; make `history` async and update every call site; tests stay green (no behaviour change).
2. **Style variants** on the file driver: `upgradeCampaign`, the endpoints, the gating, the UI (player «Стиль» row, Step 2 strip, stepper menu, history chips); remove the fork-for-style UI. Tests: the upgrade function, variant creation rules (a preview-bearing variant is never mutated), gating per variant, and that a scenario edit stales every variant.
3. **Supabase migrations** and the `store/supabase.mjs` history (entries + RPCs), with the row mapping round-trip tests.
4. **R2 blobs**, the asset index, `sync.up/down`, the preview read-through cache, and the upload endpoint write-through.
5. **Runs:** DB lock, heartbeat, event flushing, `render-progress` fallback, `/api/runs/active`, optimistic concurrency on campaigns.
6. **Authors and multi-user UX** (filters, freshness polling, running indicator, status pill).
7. **`scripts/migrate-to-cloud.mjs`** and `scripts/pull-from-cloud.mjs`.
8. **`docs/cloud-runbook.md`**, plus README and AGENTS updates (store architecture, env, scripts).

---

## 10. Verification (code only)
- `node --check` on every changed file; `npm test` green.
- **Unit tests (node:test, no network):**
  - `entryToRow` / `rowToEntry` round-trip on every fixture and on every `data/history/*.json` that exists locally (read-only);
  - `upgradeCampaign`: idempotent, preserves ids, costs and approvals;
  - variant rules and gating;
  - the file classification of §2.1;
  - the sha and size skip logic of `sync.up`, using an in-memory fake blob store;
  - the fork merge planner;
  - the read-through middleware, with a fake blob store: a miss fetches and caches, and a missing object returns 404 with the security headers present.
- **Fake cloud driver for integration:** `FORMA_STORE=memory` (test-only) implements the supabase driver's contract in memory, including the version conflict and the partial unique run lock. Run the full demo campaign flow through it with two simulated authors:
  - author A runs a step; author B sees it in `/api/runs/active`; B starting a step on the same campaign gets 409;
  - two concurrent PATCHes → one returns 409 with the conflict message;
  - a new style variant → the player data lists 2 variants; switching variants keeps format, language and length.
- **Migration script:** a dry run against a temp copy of `data/` with the memory driver prints the right counts. `--apply` twice: the second run uploads 0 files and upserts 0 changed entries.
- No real Supabase or R2 calls in tests. Document the manual cloud smoke test in the runbook.

## 11. Out of scope
Supabase Auth or per-user permissions, Realtime subscriptions (polling is enough), public sharing links, CDN delivery of creatives, video export.
