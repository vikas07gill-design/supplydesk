-- SupplyDesk Supabase schema
-- Run this once in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category_group text not null check (category_group in ('Products','Services','Industrial')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (category_group, name)
);

create table if not exists public.subcategories (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.categories(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (category_id, name)
);

create table if not exists public.supplier_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  legal_name text not null,
  trade_name text,
  business_type text not null,
  year_established integer,
  country text not null,
  city text not null,
  address text not null,
  business_email text not null,
  business_phone text not null,
  contact_person text not null,
  designation text,
  registration_number text,
  tax_number text,
  import_export_number text,
  website text,
  certification_details text,
  category_id uuid references public.categories(id),
  subcategory_id uuid references public.subcategories(id),
  requested_category text,
  status text not null default 'submitted'
    check (status in ('draft','submitted','under_review','query','resubmitted','approved','rejected','suspended')),
  admin_notes text,
  submitted_at timestamptz default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.supplier_documents (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.supplier_applications(id) on delete cascade,
  document_type text not null check (document_type in ('business_registration','tax_registration','licence_certificate','address_proof','other')),
  file_path text not null,
  original_name text,
  mime_type text,
  file_size bigint,
  created_at timestamptz not null default now()
);

create table if not exists public.supplier_photos (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.supplier_applications(id) on delete cascade,
  photo_type text not null default 'business',
  file_path text not null,
  original_name text,
  mime_type text,
  file_size bigint,
  created_at timestamptz not null default now()
);

create table if not exists public.supplier_verification (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.supplier_applications(id) on delete cascade,
  registration_details_checked boolean not null default false,
  documents_checked boolean not null default false,
  photos_checked boolean not null default false,
  address_checked boolean not null default false,
  verification_notes text,
  verified_at timestamptz,
  verified_by uuid references auth.users(id)
);

create table if not exists public.category_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  application_id uuid references public.supplier_applications(id) on delete set null,
  requested_category text not null,
  requested_subcategory text,
  description text,
  status text not null default 'pending'
    check (status in ('pending','approved','modified','rejected')),
  admin_notes text,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.supplier_profiles (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.supplier_applications(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  legal_name text not null,
  trade_name text,
  business_type text not null,
  country text not null,
  city text not null,
  address text,
  website text,
  business_email text,
  business_phone text,
  contact_person text,
  designation text,
  category_id uuid references public.categories(id),
  subcategory_id uuid references public.subcategories(id),
  verified boolean not null default false,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Basic timestamps
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists supplier_applications_updated_at on public.supplier_applications;
create trigger supplier_applications_updated_at
before update on public.supplier_applications
for each row execute function public.set_updated_at();

drop trigger if exists supplier_profiles_updated_at on public.supplier_profiles;
create trigger supplier_profiles_updated_at
before update on public.supplier_profiles
for each row execute function public.set_updated_at();

-- Enable RLS
alter table public.categories enable row level security;
alter table public.subcategories enable row level security;
alter table public.supplier_applications enable row level security;
alter table public.supplier_documents enable row level security;
alter table public.supplier_photos enable row level security;
alter table public.supplier_verification enable row level security;
alter table public.category_requests enable row level security;
alter table public.supplier_profiles enable row level security;

-- Public taxonomy
drop policy if exists "Public can read active categories" on public.categories;
create policy "Public can read active categories"
on public.categories for select
to anon, authenticated
using (is_active = true);

drop policy if exists "Public can read active subcategories" on public.subcategories;
create policy "Public can read active subcategories"
on public.subcategories for select
to anon, authenticated
using (is_active = true);

-- Supplier can create/read/update their own application
drop policy if exists "Supplier can insert own application" on public.supplier_applications;
create policy "Supplier can insert own application"
on public.supplier_applications for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Supplier can read own application" on public.supplier_applications;
create policy "Supplier can read own application"
on public.supplier_applications for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Supplier can update own application" on public.supplier_applications;
create policy "Supplier can update own application"
on public.supplier_applications for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Supplier document/photo metadata
drop policy if exists "Supplier can insert own document metadata" on public.supplier_documents;
create policy "Supplier can insert own document metadata"
on public.supplier_documents for insert
to authenticated
with check (
  exists (
    select 1 from public.supplier_applications a
    where a.id = application_id and a.user_id = auth.uid()
  )
);

drop policy if exists "Supplier can read own document metadata" on public.supplier_documents;
create policy "Supplier can read own document metadata"
on public.supplier_documents for select
to authenticated
using (
  exists (
    select 1 from public.supplier_applications a
    where a.id = application_id and a.user_id = auth.uid()
  )
);

drop policy if exists "Supplier can insert own photo metadata" on public.supplier_photos;
create policy "Supplier can insert own photo metadata"
on public.supplier_photos for insert
to authenticated
with check (
  exists (
    select 1 from public.supplier_applications a
    where a.id = application_id and a.user_id = auth.uid()
  )
);

drop policy if exists "Supplier can read own photo metadata" on public.supplier_photos;
create policy "Supplier can read own photo metadata"
on public.supplier_photos for select
to authenticated
using (
  exists (
    select 1 from public.supplier_applications a
    where a.id = application_id and a.user_id = auth.uid()
  )
);

-- Category requests
drop policy if exists "Supplier can create category requests" on public.category_requests;
create policy "Supplier can create category requests"
on public.category_requests for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Supplier can read own category requests" on public.category_requests;
create policy "Supplier can read own category requests"
on public.category_requests for select
to authenticated
using (auth.uid() = user_id);

-- Only published verified profiles are public
drop policy if exists "Public can read published verified profiles" on public.supplier_profiles;
create policy "Public can read published verified profiles"
on public.supplier_profiles for select
to anon, authenticated
using (verified = true and published = true);

drop policy if exists "Supplier can read own profile" on public.supplier_profiles;
create policy "Supplier can read own profile"
on public.supplier_profiles for select
to authenticated
using (auth.uid() = user_id);

-- Admin policies should be added after the admin role model is created.
-- Never expose service_role keys in browser code.

-- Private storage buckets
insert into storage.buckets (id, name, public)
values ('supplier-documents','supplier-documents',false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('supplier-photos','supplier-photos',false)
on conflict (id) do nothing;

-- Storage access: authenticated supplier can access files under their own user-id folder.
drop policy if exists "Supplier upload documents" on storage.objects;
create policy "Supplier upload documents"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'supplier-documents'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Supplier read documents" on storage.objects;
create policy "Supplier read documents"
on storage.objects for select
to authenticated
using (
  bucket_id = 'supplier-documents'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Supplier upload photos" on storage.objects;
create policy "Supplier upload photos"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'supplier-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Supplier read photos" on storage.objects;
create policy "Supplier read photos"
on storage.objects for select
to authenticated
using (
  bucket_id = 'supplier-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Seed categories
insert into public.categories (category_group,name) values
('Products','Raw Materials'),('Products','Plastics & Packaging'),('Products','Machinery'),
('Products','Electronics & Components'),('Products','Automotive'),('Products','Textiles & Apparel'),
('Products','Food & Agriculture'),('Products','Chemicals'),('Products','Consumer Products'),
('Products','Construction Materials'),('Services','Logistics & Freight'),('Services','Warehousing & Fulfilment'),
('Services','Customs & Trade'),('Services','Inspection & Verification'),('Services','Insurance'),
('Services','Trade Finance'),('Services','Sourcing Services'),('Services','Professional Services'),
('Industrial','Industrial Equipment'),('Industrial','Electrical Equipment'),('Industrial','Tools & Hardware'),
('Industrial','Metal Products'),('Industrial','Industrial Components'),('Industrial','Manufacturing Services')
on conflict (category_group,name) do nothing;
