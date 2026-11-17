-- The art director's looks are history entries of their own type ('review').
-- Non-breaking: widens the allowed entry types; forma_schema stays at 1.
alter table entries drop constraint if exists entries_type_check;
alter table entries add constraint entries_type_check
  check (type in ('scenario','style','preview','creative','campaign','review'));
