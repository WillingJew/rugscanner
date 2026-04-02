-- Run this in Supabase SQL Editor (supabase.com → your project → SQL Editor)

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  stripe_customer_id text unique,
  stripe_subscription_status text default 'inactive',
  created_at timestamptz default now()
);

-- Index for fast email lookups
create index if not exists users_email_idx on users(email);
create index if not exists users_stripe_customer_idx on users(stripe_customer_id);
