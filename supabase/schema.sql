-- ============================================================
--  Patrimonio · esquema de base de datos (Supabase / Postgres)
--  Pégalo entero en: Supabase > SQL Editor > New query > Run
--  Se puede ejecutar más de una vez sin romper nada.
-- ============================================================

-- 1) PRODUCTOS --------------------------------------------------
--  category : efectivo | fondo | accion | plan_pensiones | inmobiliario | deuda
--  valuation: 'units'  -> valor = participaciones x precio (fondos, acciones, planes)
--             'manual' -> valor que escribes tú cada mes (cuentas, inmuebles, deudas)
--  sources  : lista (JSON) de dónde sacar el precio, en orden de preferencia.
--             Ejemplo: [{"type":"yahoo","symbol":"ABVX.PA"},{"type":"yahoo","isin":"FR0012333284"}]
create table if not exists public.assets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  entity      text,                       -- banco / gestora / broker (solo informativo)
  category    text not null check (category in
                ('efectivo','fondo','accion','plan_pensiones','inmobiliario','deuda')),
  valuation   text not null check (valuation in ('units','manual')),
  isin        text,                       -- ISIN o código DGS (solo informativo)
  sources     jsonb not null default '[]'::jsonb,
  active      boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);

-- 2) PARTICIPACIONES (histórico: una fila cada vez que cambian) --
create table if not exists public.holdings (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  asset_id  uuid not null references public.assets(id) on delete cascade,
  date      date not null,                -- desde cuándo tienes estas participaciones
  units     numeric not null check (units >= 0),
  unique (asset_id, date)
);

-- 3) PRECIOS (los escribe el flujo de GitHub o tú a mano) --------
--  date     : día en que se registró el dato (eje de tiempo de la web)
--  nav_date : fecha del valor liquidativo según la fuente (puede ser anterior)
create table if not exists public.prices (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  asset_id  uuid not null references public.assets(id) on delete cascade,
  date      date not null,
  nav_date  date,
  price     numeric not null check (price > 0),
  source    text,                         -- 'yahoo', 'ft', 'quefondos', 'manual', ...
  unique (asset_id, date)
);

-- 4) VALORES MANUALES (saldos de cuentas, valor de inmuebles, deudas) --
create table if not exists public.manual_values (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  asset_id  uuid not null references public.assets(id) on delete cascade,
  date      date not null,
  value     numeric not null,
  unique (asset_id, date)
);

create index if not exists prices_asset_date_idx on public.prices (asset_id, date desc);
create index if not exists holdings_asset_date_idx on public.holdings (asset_id, date desc);
create index if not exists manual_asset_date_idx on public.manual_values (asset_id, date desc);

-- 5) SEGURIDAD (Row Level Security) -----------------------------
--  Cada fila solo la ve y la toca su dueño. Sin sesión iniciada no se ve nada.
--  El flujo de GitHub usa la clave secreta, que se salta estas reglas a propósito.
alter table public.assets        enable row level security;
alter table public.holdings      enable row level security;
alter table public.prices        enable row level security;
alter table public.manual_values enable row level security;

drop policy if exists own_assets on public.assets;
create policy own_assets on public.assets
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists own_holdings on public.holdings;
create policy own_holdings on public.holdings
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid()
    and exists (select 1 from public.assets a where a.id = asset_id and a.user_id = auth.uid()));

drop policy if exists own_prices on public.prices;
create policy own_prices on public.prices
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid()
    and exists (select 1 from public.assets a where a.id = asset_id and a.user_id = auth.uid()));

drop policy if exists own_manual on public.manual_values;
create policy own_manual on public.manual_values
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid()
    and exists (select 1 from public.assets a where a.id = asset_id and a.user_id = auth.uid()));

-- La clave pública (anon/publishable) no debe poder leer nada de estas tablas:
revoke all on public.assets, public.holdings, public.prices, public.manual_values from anon;
