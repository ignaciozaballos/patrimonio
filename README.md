# Patrimonio

Web personal para seguir tu patrimonio (cuentas, fondos, acciones, planes de pensiones, inmobiliario y deudas).

- **Web**: HTML estático en GitHub Pages. Entras con un enlace que te llega al email.
- **Datos**: Supabase (Postgres). Se sincronizan entre ordenador y móvil. Cada fila solo la ve tu usuario (RLS).
- **Precios**: un flujo de GitHub Actions corre cada día, consulta los precios y los guarda. Valor = participaciones × precio.
- **Cuentas, inmobiliario y deudas**: los actualizas tú a mano desde la pestaña *Actualizar*.

> Aviso honesto: el código que lee precios de Yahoo, FT, Finect y quefondos está probado con textos de ejemplo, no contra las webs reales (desde donde lo desarrollé no tenía acceso). Por eso el paso 7 usa el modo `probe`: comprueba cada producto antes de fiarte. Si una fuente falla, se puede cambiar desde la web (Ajustes) sin tocar código, o escribir el precio a mano.

---

## 1. Crear el proyecto en Supabase

1. Entra en <https://supabase.com> y crea cuenta (con GitHub es lo más cómodo).
2. **New project**: ponle nombre (`patrimonio`), una contraseña de base de datos (guárdala; no la usarás aquí) y región **West EU (Ireland)** o la más cercana a Madrid. Plan **Free**.
3. Espera 1–2 minutos a que termine de crearse.

## 2. Crear las tablas

1. Menú izquierdo: **SQL Editor** → **New query**.
2. Pega todo el contenido de `supabase/schema.sql` y pulsa **Run**. Debe decir *Success*. Se puede repetir sin problema.

## 3. Crear tu usuario y cerrar el registro

1. **Authentication → Users → Add user → Create new user**. Pon tu email, marca *Auto Confirm User*. La contraseña puede ser cualquiera larga (no se usará: entras por código).
2. **Authentication → Sign In / Providers** (o *Settings*): desactiva **Allow new users to sign up**. Así nadie más puede crearse cuenta.

## 4. El email de acceso

Entras con el **enlace** que Supabase te manda por email (la web también acepta un código si algún día lo configuras). No tienes que tocar nada: la plantilla por defecto de Supabase ya sirve. Editar la plantilla exige un SMTP propio (ver abajo) y no es necesario.

Cómo funciona: escribes tu email en la web, te llega un correo con "Sign in", lo pulsas **en el mismo dispositivo** y entras. Ese dispositivo queda con la sesión iniciada.

**Límite del correo gratuito:** el envío integrado de Supabase solo manda al email del dueño del proyecto (tú) y unos ~2 correos por hora. Para uso personal basta. Si te da problemas, configura un SMTP propio (p. ej. Resend) en **Authentication → Emails → SMTP Settings**; con eso además podrás editar la plantilla para que traiga un código (`{{ .Token }}`).

## 5. Cargar tus productos (privado)

El archivo `seed.sql` va **aparte** de este repositorio (no lo subas a GitHub).

1. Ábrelo y sustituye `TU_EMAIL@ejemplo.com` por tu email de Supabase.
2. SQL Editor → New query → pega → **Run**.
3. Crea 6 productos con sus participaciones (Indexa x2, NAO, Kutxabank fondo, Kutxabank plan, Abivax) y 3 cuentas llamadas *Cuenta bancaria 1–3* (renómbralas luego en la web).

El plan de pensiones de Indexa (715,72 participaciones) y el inmobiliario se añaden después desde la web: **Ajustes → Añadir producto**.

## 6. Conectar la web con Supabase y publicarla

1. En Supabase: **Project Settings → API Keys**. Copia:
   - **Project URL** (`https://xxxx.supabase.co`)
   - **Publishable key** (`sb_publishable_…`) → va en la web.
   - **Secret key** (`sb_secret_…`) → solo para GitHub Actions (paso 6.4). **Nunca** en el código.
2. Edita `config.js` y pega URL y clave *publishable*.
3. En GitHub crea un repositorio (p. ej. `patrimonio`) y sube el contenido de esta carpeta (el `.gitignore` ya excluye `seed.sql`, copias de seguridad y `.env`).
4. En el repo: **Settings → Secrets and variables → Actions → New repository secret**:
   - `SUPABASE_URL` = la Project URL
   - `SUPABASE_SECRET_KEY` = la secret key
5. **Settings → Pages**: *Source* = *Deploy from a branch*, rama `main`, carpeta `/ (root)`. En un minuto tendrás `https://TU_USUARIO.github.io/patrimonio/`.
6. En Supabase: **Authentication → URL Configuration**: pon esa URL en *Site URL*.

Entra a la URL: te pide el email, te llega el código, lo escribes y ya estás dentro. En el móvil, "Añadir a pantalla de inicio" lo deja como app.

> Los datos están en Supabase, protegidos por login y RLS. Aunque el repo/HTML sea público, sin tu código no se ve nada. Si prefieres que el código no sea público, GitHub Pages en repo privado exige plan de pago.

## 7. Probar la obtención de precios

En GitHub: **Actions → Actualizar precios → Run workflow**.

1. **Probe**: escribe `IE00BFPM9N11 IE00BGCZ0B53 ES0165283021 ES0166778003 N2621 FR0012333284` y ejecuta. En el *Summary* verás, por fuente, qué precio y fecha lee. Si una no devuelve nada, avísame con el resultado y ajustamos la fuente.
2. **Dry run** (sin escribir en la base de datos): comprueba que lo que se guardaría es razonable.
3. Ejecución normal: guarda los precios. Abre la web: el patrimonio ya usa precio × participaciones.

Desde entonces corre solo cada día (~07:17 UTC). Detalles útiles:

- Un precio manual puesto hoy desde la web **no** lo pisa el flujo.
- Se rechazan saltos sospechosos (>20 % en fondos y planes, >60 % en acciones) y precios demasiado antiguos. Si algún producto no tiene precio fresco, el flujo termina en rojo y GitHub te avisa por email.
- Los planes de pensiones publican valor con retraso; es normal que la fecha del precio vaya unos días por detrás.
- Supabase gratis se pausa tras 7 días sin actividad; el flujo diario lo evita.
- GitHub desactiva flujos programados tras 60 días sin actividad en el repo; el flujo hace un commit vacío mensual para evitarlo.

## 8. Uso mensual

1. Pestaña **Actualizar**: escribe el saldo de tus 3 cuentas (y inmobiliario/deudas si cambian). Se guarda con la fecha de hoy.
2. Si compras o vendes participaciones: abre el producto → *Cambiar participaciones*. El histórico se conserva.
3. **Ajustes → Descargar copia** guarda un JSON de seguridad (no lo subas a GitHub).

## 9. Añadir el plan de Indexa más adelante

Necesito el código exacto del plan (N5138 es el código DGS; confirma el nombre/ISIN del fondo en el documento de Indexa, el plan de autónomos puede ser un producto distinto al de otros planes). Se añade en **Ajustes → Añadir producto** con 715,72 participaciones, categoría *Plan de pensiones* y fuente `quefondos` con ese código; o escríbeme el código y lo preparo.

## Estructura

```
index.html, style.css, app.js, calc.js, charts.js, config.js   web
supabase/schema.sql                                            tablas + seguridad
scripts/update_prices.py                                       actualizador de precios
.github/workflows/update-prices.yml                            flujo diario
tests/                                                         pruebas
```

Pruebas: `node --test tests/calc.test.js` y `python3 -I -m unittest discover -s tests`.

## Seguridad: qué no subir nunca

`seed.sql`, copias de seguridad JSON, la clave `sb_secret_…` (solo como secreto de GitHub). La clave `sb_publishable_…` sí puede ir en `config.js`.
