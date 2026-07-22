-- Reference schema for the optional shared video cache + playlist groundwork.
-- Not run automatically — paste into the Supabase project's SQL editor once,
-- by hand, when setting up the optional shared cache (see README.md "Setup").
-- Not loaded by the app itself.

-- Shared cache: primary key IS the client's cache key (see js/youtube.js), so no
-- translation is needed between the query string and the row.
create table if not exists public.video_cache (
  query      text primary key,   -- "artist title", matches youtube.js's query
  video_id   text not null,
  created_at timestamptz not null default now()
);

alter table public.video_cache enable row level security;

create policy "video_cache_public_read"
  on public.video_cache for select using (true);
-- No insert/update/delete policy for anon — all writes go through cache_video() below,
-- so the anon key (public in the client, same as the YouTube key) can't be used to
-- write arbitrary rows directly.

-- Needed because this project was created with "Automatically expose new tables"
-- disabled: Postgres checks the base table grant before RLS policies are even
-- evaluated, so the select policy above does nothing for anon/authenticated without
-- this. (playlists/playlist_tracks deliberately get no such grant — see below.)
grant select on public.video_cache to anon, authenticated;

create or replace function public.cache_video(p_query text, p_video_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_query is null or length(trim(p_query)) = 0 or length(p_query) > 300 then return; end if;
  if p_video_id is null or p_video_id !~ '^[A-Za-z0-9_-]{11}$' then return; end if;
  insert into public.video_cache (query, video_id)
  values (trim(p_query), p_video_id)
  on conflict (query) do nothing; -- first writer wins, never overwrite
end;
$$;

revoke all on function public.cache_video(text, text) from public;
grant execute on function public.cache_video(text, text) to anon;

-- Playlist schema groundwork for a future feature. RLS is enabled with zero policies,
-- so these tables are inert (PostgREST denies all access by default) until owner-scoped
-- policies (e.g. user_id = auth.uid()) are added alongside real playlist UI.
-- auth.users is provided by Supabase Auth (Authentication -> Providers -> Google).
create table if not exists public.playlists (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  mode          text not null check (mode in ('only', 'similar')),
  source_artist text not null,
  created_at    timestamptz not null default now()
);
create index if not exists playlists_user_id_idx on public.playlists(user_id);

create table if not exists public.playlist_tracks (
  playlist_id uuid not null references public.playlists(id) on delete cascade,
  position    integer not null,
  artist      text not null,
  title       text not null,
  query       text not null,
  video_id    text,
  primary key (playlist_id, position)
);

alter table public.playlists enable row level security;
alter table public.playlist_tracks enable row level security;
