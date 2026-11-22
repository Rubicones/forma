-- Toggle Concepts client dashboard: the client side of the shared store.
-- Non-breaking: new tables only; forma_schema stays at 1.
-- Server-side access only (service role). RLS is on with no policies, as in Forma.
-- Contract: dashboard/docs/contract.md (in the dashboard repo).

-- Who fills things in: a brand, or an agency that brings several client brands.
create table if not exists client_accounts (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'brand' check (kind in ('brand','agency')),
  name text,
  contact_email text,
  test boolean not null default false,          -- created from test mode
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The brands an account advertises. A brand account has one; an agency has one per client.
create table if not exists client_brands (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references client_accounts(id) on delete cascade,
  name text not null,
  questionnaire_scope text,                     -- null for a brand account; the prototype client id ('c1'…) for agency clients
  forma_brand_id uuid,                          -- set by the studio when it creates the brand in Forma
  created_at timestamptz not null default now()
);

-- The brand questionnaire: the prototype's whole state, versioned.
create table if not exists brand_questionnaires (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null unique references client_accounts(id) on delete cascade,
  schema_version integer not null default 1,
  state jsonb not null default '{}',            -- {role, mode, a, flags, clients, ac, legal, …} as in the prototype, minus UI-only keys
  status text not null default 'draft' check (status in ('draft','submitted','changes_requested','approved')),
  unlocked text[] not null default '{}',        -- scoped question ids editable while changes are requested
  submitted_at timestamptz,
  approved_at timestamptz,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

-- Follow-up questions from the studio and the client's replies, tied to answers.
create table if not exists questionnaire_notes (
  id uuid primary key default gen_random_uuid(),
  questionnaire_id uuid not null references brand_questionnaires(id) on delete cascade,
  author_role text not null check (author_role in ('studio','client')),
  author text,
  question_ids text[] not null default '{}',    -- scoped ids, e.g. 'c_what' or 'c1:c_what'
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Files the client uploads (questionnaire materials, references).
create table if not exists client_files (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references client_accounts(id) on delete cascade,
  scope text not null default 'brand',          -- 'brand' or an agency client id
  name text not null,
  size bigint not null check (size >= 0 and size <= 2147483648),  -- 2 GB cap
  content_type text,
  category text not null,                       -- the prototype's catOf() result
  r2_key text not null,
  status text not null default 'uploading' check (status in ('uploading','ready','failed')),
  created_at timestamptz not null default now()
);

-- A campaign as the client knows it.
create table if not exists campaign_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references client_accounts(id) on delete cascade,
  client_brand_id uuid not null references client_brands(id) on delete cascade,
  name text not null,
  setup jsonb not null,                         -- {kind:'poster'|'single'|'multi', formats:[], languages:[codes], lengths:[s]}
  brief jsonb not null,                         -- the campaign brief answers
  status text not null default 'submitted'
    check (status in ('submitted','in_progress','review_directions','in_production','delivered','cancelled')),
  forma_campaign_id uuid,                       -- set by the studio
  rebuilds_used integer not null default 0 check (rebuilds_used between 0 and 2),
  approved_item_id text,                        -- the chosen direction (Forma variant id)
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- What we send the client: an immutable snapshot, so the client sees exactly what we approved.
create table if not exists deliveries (
  id uuid primary key default gen_random_uuid(),
  campaign_request_id uuid not null references campaign_requests(id) on delete cascade,
  stage text not null check (stage in ('directions','final')),
  round integer not null default 1,             -- directions: 1, 2, 3 (after rebuilds)
  items jsonb not null,
  status text not null default 'sent' check (status in ('sent','responded','superseded')),
  sent_by text,
  sent_at timestamptz not null default now(),
  response jsonb,                               -- {decision:'approve'|'rebuild', itemId?, reason?, at}
  responded_at timestamptz,
  unique (campaign_request_id, stage, round)
);

-- Comments on a directions delivery; pinned ones carry normalized coordinates on the artboard.
create table if not exists delivery_comments (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references deliveries(id) on delete cascade,
  item_id text not null,                        -- direction (variant id)
  scene text,                                   -- storyboard scene id for multi-scene previews
  format text, lang text,
  x real check (x between 0 and 1),             -- null x/y = a general comment on the direction
  y real check (y between 0 and 1),
  number integer not null,                      -- pin number within the item
  body text not null check (length(body) between 1 and 4000),
  author text,
  state text not null default 'draft' check (state in ('draft','sent','resolved')),
  resolved_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((x is null) = (y is null))
);

-- Files ready to download for a final delivery (written by Forma's export job).
create table if not exists delivery_exports (
  delivery_id uuid not null references deliveries(id) on delete cascade,
  format text not null, lang text not null, length integer not null default 0,   -- 0 for posters
  file_type text not null check (file_type in ('mp4','png','jpg','gif','webm')),
  r2_key text not null, size bigint, width integer, height integer,
  status text not null default 'ready' check (status in ('pending','ready','failed')),
  primary key (delivery_id, format, lang, length, file_type)
);

-- What happened, for the client timeline and (later) emails.
create table if not exists client_events (
  id bigserial primary key,
  account_id uuid not null references client_accounts(id) on delete cascade,
  campaign_request_id uuid references campaign_requests(id) on delete cascade,
  type text not null,                           -- 'questionnaire.submitted', 'directions.sent', 'direction.approved', …
  payload jsonb not null default '{}',
  at timestamptz not null default now()
);

-- Indexes: every foreign key, plus the list orders the dashboard reads.
create index if not exists client_brands_account on client_brands (account_id);
create unique index if not exists client_brands_scope on client_brands (account_id, coalesce(questionnaire_scope, ''));
create index if not exists questionnaire_notes_questionnaire on questionnaire_notes (questionnaire_id, created_at);
create index if not exists client_files_account on client_files (account_id, created_at desc);
create index if not exists campaign_requests_account on campaign_requests (account_id, updated_at desc);
create index if not exists campaign_requests_brand on campaign_requests (client_brand_id, updated_at desc);
create index if not exists campaign_requests_forma on campaign_requests (forma_campaign_id) where forma_campaign_id is not null;
create index if not exists deliveries_campaign on deliveries (campaign_request_id, stage, round desc);
create index if not exists delivery_comments_delivery on delivery_comments (delivery_id, item_id, number);
create unique index if not exists delivery_comments_number on delivery_comments (delivery_id, item_id, number);
create index if not exists delivery_exports_delivery on delivery_exports (delivery_id);
create index if not exists client_events_account on client_events (account_id, at desc);
create index if not exists client_events_campaign on client_events (campaign_request_id, at) where campaign_request_id is not null;
create index if not exists client_accounts_updated on client_accounts (updated_at desc);

-- updated_at follows every write (autosave, comment edits) without each caller remembering it.
create or replace function client_touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists client_accounts_touch on client_accounts;
create trigger client_accounts_touch before update on client_accounts for each row execute function client_touch_updated_at();
drop trigger if exists brand_questionnaires_touch on brand_questionnaires;
create trigger brand_questionnaires_touch before update on brand_questionnaires for each row execute function client_touch_updated_at();
drop trigger if exists campaign_requests_touch on campaign_requests;
create trigger campaign_requests_touch before update on campaign_requests for each row execute function client_touch_updated_at();
drop trigger if exists delivery_comments_touch on delivery_comments;
create trigger delivery_comments_touch before update on delivery_comments for each row execute function client_touch_updated_at();

-- Drafts live only on a round still waiting for the client. Locking the delivery row (for share)
-- serialises a late comment against the decision, which updates that row: no comment slips in after.
create or replace function client_comments_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    -- A cascade from the delivery or campaign: the parent is already gone.
    if not exists (select 1 from deliveries where id = old.delivery_id) then return old; end if;
    if old.state <> 'draft' or not exists (
      select 1 from deliveries where id = old.delivery_id and stage = 'directions' and status = 'sent' for share
    ) then raise exception 'delivery_not_open'; end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.state <> 'draft' then
    -- Sent comments are the record: the studio may resolve them, nobody may rewrite them.
    if new.state = 'draft' or new.body is distinct from old.body or new.x is distinct from old.x or new.y is distinct from old.y then
      raise exception 'delivery_not_open';
    end if;
    return new;
  end if;
  if new.state = 'draft' and not exists (
    select 1 from deliveries where id = new.delivery_id and stage = 'directions' and status = 'sent' for share
  ) then raise exception 'delivery_not_open'; end if;
  if tg_op = 'INSERT' and new.state <> 'draft' then raise exception 'delivery_not_open'; end if;
  return new;
end $$;
drop trigger if exists delivery_comments_guard on delivery_comments;
create trigger delivery_comments_guard before insert or update or delete on delivery_comments for each row execute function client_comments_guard();

-- Status changes (called only by dashboard/lib/state-machine.ts, which validates the transition first).
-- Each function is one transaction: compare-and-set on version AND from-status, side effects, event row.
-- Returns the updated row, or no row when the version or status moved (the caller answers 409).

create or replace function client_questionnaire_transition(
  p_id uuid, p_expected_version integer, p_from text, p_to text,
  p_unlocked text[], p_brands jsonb, p_event_type text, p_event_payload jsonb
) returns setof brand_questionnaires language plpgsql as $$
declare
  r brand_questionnaires;
begin
  update brand_questionnaires
     set status = p_to,
         version = version + 1,
         unlocked = case when p_to = 'changes_requested' then coalesce(p_unlocked, '{}') else '{}' end,
         submitted_at = case when p_to = 'submitted' then now() else submitted_at end,
         approved_at = case when p_to = 'approved' then now() else approved_at end
   where id = p_id and version = p_expected_version and status = p_from
  returning * into r;
  if not found then return; end if;

  if p_to = 'approved' and p_brands is not null then
    insert into client_brands (account_id, name, questionnaire_scope)
    select r.account_id, b->>'name', nullif(b->>'questionnaire_scope', '')
      from jsonb_array_elements(p_brands) b
    on conflict (account_id, (coalesce(questionnaire_scope, ''))) do update set name = excluded.name;
  end if;

  insert into client_events (account_id, type, payload)
  values (r.account_id, p_event_type, coalesce(p_event_payload, '{}'));
  return next r;
end $$;

create or replace function client_campaign_transition(
  p_id uuid, p_expected_version integer, p_from text, p_to text,
  p_rebuilds_inc boolean, p_approved_item_id text, p_forma_campaign_id uuid,
  p_new_delivery jsonb,            -- {stage, items, sentBy} or null
  p_respond_delivery uuid,         -- the open delivery the client answers, or null
  p_response jsonb,
  p_event_type text, p_event_payload jsonb
) returns setof campaign_requests language plpgsql as $$
declare
  r campaign_requests;
  v_stage text;
  v_round integer;
  v_delivery uuid;
begin
  update campaign_requests
     set status = p_to,
         version = version + 1,
         rebuilds_used = rebuilds_used + case when p_rebuilds_inc then 1 else 0 end,
         approved_item_id = coalesce(p_approved_item_id, approved_item_id),
         forma_campaign_id = coalesce(p_forma_campaign_id, forma_campaign_id)
   where id = p_id and version = p_expected_version and status = p_from
     and (not p_rebuilds_inc or rebuilds_used < 2)
  returning * into r;
  if not found then return; end if;

  if p_respond_delivery is not null then
    update deliveries
       set status = 'responded', response = p_response, responded_at = now()
     where id = p_respond_delivery and campaign_request_id = p_id and status = 'sent' and stage = 'directions';
    if not found then raise exception 'delivery_not_open'; end if;
    update delivery_comments set state = 'sent' where delivery_id = p_respond_delivery and state = 'draft';
  end if;

  if p_new_delivery is not null then
    v_stage := p_new_delivery->>'stage';
    -- Anything still open for this stage is replaced by the new round.
    update deliveries set status = 'superseded'
     where campaign_request_id = p_id and stage = v_stage and status = 'sent';
    select coalesce(max(round), 0) + 1 into v_round from deliveries where campaign_request_id = p_id and stage = v_stage;
    insert into deliveries (campaign_request_id, stage, round, items, sent_by)
    values (p_id, v_stage, v_round, p_new_delivery->'items', p_new_delivery->>'sentBy')
    returning id into v_delivery;
  end if;

  insert into client_events (account_id, campaign_request_id, type, payload)
  values (
    r.account_id, p_id, p_event_type,
    coalesce(p_event_payload, '{}')
      || case when v_delivery is not null then jsonb_build_object('deliveryId', v_delivery, 'round', v_round) else '{}'::jsonb end
  );
  return next r;
end $$;

-- Only the service role calls these (security invoker + RLS already deny others; this makes it explicit).
revoke execute on function client_questionnaire_transition(uuid, integer, text, text, text[], jsonb, text, jsonb) from public, anon, authenticated;
revoke execute on function client_campaign_transition(uuid, integer, text, text, boolean, text, uuid, jsonb, uuid, jsonb, text, jsonb) from public, anon, authenticated;

alter table client_accounts      enable row level security;
alter table client_brands        enable row level security;
alter table brand_questionnaires enable row level security;
alter table questionnaire_notes  enable row level security;
alter table client_files         enable row level security;
alter table campaign_requests    enable row level security;
alter table deliveries           enable row level security;
alter table delivery_comments    enable row level security;
alter table delivery_exports     enable row level security;
alter table client_events        enable row level security;
