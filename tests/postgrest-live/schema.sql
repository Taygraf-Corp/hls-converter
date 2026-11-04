-- Schema for tests/postgrest-live.test.ts (CI job "postgrest"). Only the
-- posts columns the HLS policy reads, with production's names and types for
-- the filtered ones. PostgREST runs requests as the anon role "postgres".
create table public.posts (
  id uuid primary key,
  profile_id uuid,
  video_url text,
  hls_url text,
  media_bucket text,
  media_path text,
  media_count integer,
  post_type text,
  channel text,
  in_general_feed boolean,
  type text,
  is_hidden boolean not null default false,
  is_vip boolean,
  expires_at timestamptz
);
create table public.account_deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null
);

insert into public.posts (id, profile_id, video_url, media_bucket, media_path, media_count,
                          post_type, channel, in_general_feed, type, is_hidden, is_vip, expires_at)
values
  -- the production failure: a unified private video in the General Feed (post 58598bf2's shape)
  ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', null,
   'unfiltered', 'p1/v.mp4', 1, 'video', 'standard', true, 'UNFILTERED', false, false, null),
  -- a legacy public post
  ('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   'https://ref.supabase.co/storage/v1/object/public/FlutterFlow/Videos/p2.mp4',
   null, null, null, null, null, null, 'PUBLIC', false, null, null),
  -- hidden after it was read: the publish must not happen
  ('00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', null,
   'unfiltered', 'p3/v.mp4', 1, 'video', 'unfiltered', null, 'UNFILTERED', false, false, null);

notify pgrst, 'reload schema';
