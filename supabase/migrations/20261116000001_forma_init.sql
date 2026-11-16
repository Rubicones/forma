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
