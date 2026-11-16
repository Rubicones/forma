-- Compare-and-set update of a mutable entry. Returns the new row, or nothing if the version moved.
create or replace function forma_update_entry(p_id uuid, p_expected integer, p_doc jsonb, p_campaign uuid, p_parent uuid, p_output_path text, p_status text)
returns setof entries language sql as $$
  update entries
     set doc = p_doc, version = version + 1, updated_at = now(),
         campaign_id = p_campaign, parent_id = p_parent, output_path = p_output_path, status = p_status
   where id = p_id and version = p_expected
  returning *;
$$;

-- Walks parent_id chain up to 50 steps, returning rows oldest first (§3.2).
create or replace function forma_thread(p_id uuid)
returns setof entries language sql stable as $$
  with recursive chain as (
    select e.*, 1 as depth
      from entries e
     where e.id = p_id
    union all
    select p.*, c.depth + 1
      from chain c
      join entries p on p.id = c.parent_id
     where c.parent_id is not null
       and c.depth < 50
  )
  select id, type, status, created_at, updated_at, version, author,
         project_id, campaign_id, parent_id, output_path, log_size, doc
    from chain
   order by depth desc;
$$;
