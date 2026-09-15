# GST Invoice App

A single-store, personal-use Shopify app that turns paid Shopify orders into GST-compliant
tax invoices. Next.js 15 (App Router) with Polaris for the admin UI, JSON files for
persistence, and `@react-pdf/renderer` for the PDF.

Two screens: **Orders** and **Settings**. Invoices are generated on demand; there are no
background jobs, no database and no OAuth.

---

## 1. Create the app and get its credentials

The app authenticates with a **client ID and client secret**, not a stored token. Create the
app, then from its credentials page copy the **Client ID** and **Client secret**.

1. **Scopes**: `read_orders` and `read_products`. Three optional extras:
   - `read_all_orders` for orders older than 60 days. It is an *add-on* to `read_orders`,
     never a replacement for it, and Shopify gates it.
   - `read_customers` lets the app read the customer's default address, which is the third
     fallback for place of supply. Without it the app downgrades its query automatically
     and uses the order's shipping and billing addresses only.
   - `read_inventory` lets the app read each variant's Harmonized System code, the most
     specific HSN source. Without it, HSN falls back to product tags, metafields and the
     rate table.
2. **Install the app on the store.** Credentials for an app that is not installed are
   refused at the token endpoint.

> **60-day window.** Without `read_all_orders` only the last 60 days of orders are
> readable. The Orders screen shows a notice only when the granted scopes confirm the limit
> (or cannot be read, as with a static token).

## 2. Configure

```bash
cp .env.example .env
```

| Variable | Required | Notes |
| --- | --- | --- |
| `SHOPIFY_SHOP_DOMAIN` | yes | `your-store.myshopify.com`, no protocol |
| `SHOPIFY_CLIENT_ID` | yes | the app's client ID |
| `SHOPIFY_CLIENT_SECRET` | yes | the app's client secret; server-side only |
| `SHOPIFY_API_VERSION` | no | defaults to `2025-07` |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | no | legacy fallback: a static `shpat_…` token, used only when no client credentials are set |
| `NEXT_PUBLIC_SHOPIFY_API_KEY` | no | only for running embedded (see below) |
| `APP_SHARED_SECRET` | no | if set, every request needs `?k=<secret>` once |

**How the token is handled** (`lib/shopify/token.ts`). On the first Shopify call the server
POSTs the client ID and secret to `https://<shop>/admin/oauth/access_token` with
`grant_type=client_credentials` and keeps the returned token **in memory only**:

- it is reused until shortly before it expires (tokens last ~24h; refresh happens 1–5
  minutes early) and then fetched again automatically;
- if Shopify answers 401 - the token was revoked or the app reinstalled - it is dropped and
  the request retried once with a fresh token; a 403 (missing scope) is reported, not retried;
- concurrent requests share one token request;
- it is never written to disk or `.env`, and neither it nor the secret is ever logged or
  returned by an API route. A server restart just fetches a new one.

`GET /api/health` shows the auth mode, when the current token expires, the scopes it was
granted, and any required scope that is missing - without revealing the token.

## 3. Run

```bash
npm install && npm run dev
```

Open <http://localhost:3100>. (Port 3100 rather than 3000, which another project on this machine already uses. Change it in `package.json` if you like.) Fill in **Settings** first — invoices cannot be issued until
the seller details validate.

### Running embedded in the Shopify admin

An app created under *Develop apps* gives you API credentials but **cannot be embedded** in
the admin — embedding needs an app with a Client ID and an App URL. If you want the
embedded experience, create the app in the Partner Dashboard (or `shopify app dev`, which
also gives you the tunnel), set the App URL to the tunnel URL, and put the Client ID in
`NEXT_PUBLIC_SHOPIFY_API_KEY`. App Bridge then loads and `middleware.ts` emits the
`frame-ancestors` CSP the admin iframe needs. Authentication is the static Admin API token
either way.

Nothing is stored in `localStorage` or `sessionStorage` anywhere in this app — all state is
server-side, so Chrome's storage partitioning and Safari ITP cannot break it in the iframe.

---

## How it works

### Data (`./data`, gitignored)

```
settings.json            seller details and invoice config
counter.json             { "2026-27": 106 }  financial year -> last issued number
hsn-rates.json           rate rules, seeded on first run, meant to be edited
invoices/<number>.json   immutable snapshot, one per issued invoice
invoices/_index.json     order id -> invoice pointer (derived; rebuilt if deleted)
```

Every read and write goes through `lib/store.ts`. Writes are atomic (temp file + rename)
and serialised through a named in-process mutex (`lib/mutex.ts`), so two simultaneous
requests cannot interleave a read-modify-write. Replacing JSON with Prisma later means
reimplementing that one module; no caller changes.

### Invoice numbering

Format `<prefix><FY>/<seq>` → `AD/26-27/106`. The financial year runs 1 April – 31 March
and is evaluated in IST, so an order paid at 02:00 IST on 1 April lands in the new year.
The series is **independent of the Shopify order number**, which is printed only as a
reference field.

A number is allotted only when an invoice is actually issued:

1. read the counter
2. increment in memory
3. build the snapshot **and render the PDF**
4. write the snapshot file
5. only then persist the incremented counter

A failure at any step leaves the counter untouched, so no number is burned. If the process
dies between steps 4 and 5, the next allocation takes `max(counter, highest sequence on
disk) + 1`, so a number is never handed out twice. `lib/store.test.ts` covers all of this,
including five concurrent callers.

The **Last issued invoice number** field in Settings edits the counter directly — useful to
start the series mid-year or to correct it. It refuses to move below a number that has
already been issued.

### Cancelling and reissuing

An issued invoice cannot be edited - it is a frozen snapshot. To correct one (a wrong rate,
a wrong address, a duplicate), **Cancel** it from its order row and give a reason, then
generate again:

- the cancelled snapshot is flagged `CANCELLED` with `cancelledAt` and the reason, is never
  deleted, and stays downloadable - its PDF is watermarked and prints the reason
- its number stays consumed for ever; the corrected invoice takes the **next** number
- the order is then invoiceable again, and its row shows `replaces INV/26-27/N`

So one order can hold several invoices: any number of cancelled ones plus at most one live
one. `data/invoices/_index.json` records the full history per order; the newest `ISSUED`
entry is the live document.

### Cancelled orders

- Cancelled **before** an invoice existed → no invoice, no number consumed. The row shows
  *Not invoiceable* and the download button is disabled with the reason.
- Cancelled **after** an invoice was issued → the snapshot is marked
  `status: "CANCELLED"` with `cancelledAt` and `reason`. The file is never deleted, the
  number is never reused, and the PDF still downloads (watermarked `CANCELLED`).

Only orders whose financial status is `PAID` or `PARTIALLY_PAID` can be invoiced.

### Inspecting one order

```
GET /api/orders/6727651950769        everything
GET /api/orders/<id>?raw=0           skip Shopify's raw payload
GET /api/orders/<id>?trace=0         skip the per-line rule trace
```

Four layers, so a wrong figure can be pinned on the right one:

| Key | What it is |
| --- | --- |
| `raw` | Shopify's response, untouched - strings and all |
| `order` | the normalised order the engine actually sees |
| `placeOfSupply`, `invoiceability`, `lines` | the GST decisions taken from it, each line with its resolved HSN/rate and the full rule trace |
| `invoices` | every invoice ever issued for this order, cancelled ones included, with PDF links |
| `shopifyBlocks` | which optional query blocks were available; a `false` explains missing data |

When an invoice looks wrong, this is the endpoint that says whether the app misread the
order or the order really says that. Read-only - nothing is allotted or written.

The response carries the customer's name, address, email and phone, so treat it as you
would the order itself.

### Notices on the Orders screen

Informational banners appear only when they say something true about this store and page,
because a banner that is always on gets ignored:

- **60-day window** - only when the token's scopes show `read_all_orders` is missing, or when
  scopes cannot be read (a static token does not report them).
- **Orders with no usable address** - only when an order on the page still needs an invoice
  but has no Indian shipping or billing address, and `read_customers` is not granted. It
  names the orders.

### Previewing before issuing

An order with no invoice yet has a **Preview** button beside *Generate invoice*. It renders
the exact invoice that order would get - rates, HSN codes, tax split, the number it would
take - stamped `PREVIEW`, and allots nothing. Use it whenever the rate table has changed:
an issued invoice is frozen, so a wrong rate cannot be edited afterwards.

### Viewing and downloading

Each issued row has **View** and **Download**. Both hit the same route - the only
difference is `Content-Disposition`:

- **View** opens the PDF in a modal inside the app (`?disposition=inline`), with *Open in
  new tab* for browsers that will not render a PDF in a frame. This is why `frame-ancestors`
  in `middleware.ts` includes `'self'`.
- **Download** saves the file, opened through a new tab so the admin iframe sandbox cannot
  block it.

Generating does **not** download by default: it issues the invoice and the row's View /
Download buttons take over, so a mis-click never drops a file in your downloads folder.
Turn on **Download immediately after generating** in Settings if you prefer the old
behaviour.

### Immutability

Everything an invoice needs — seller details, bank details, terms, logo, line rates, the
rate-table version — is captured into the snapshot at issue time. Re-downloading renders
that stored JSON; nothing is recalculated. Changing your GSTIN, your address or the rate
table cannot alter an invoice that already exists.

The two endpoints reflect this: `POST /api/orders/:id/invoice` allots a number (a state
change, so never a GET a browser might prefetch), and `GET /api/invoices/:key/pdf` only
ever replays a snapshot.

### GST engine (`lib/gst/`)

Pure TypeScript — no Shopify imports, no filesystem, no clock — so it is unit-testable in
isolation (`npm test`).

**Place of supply**: shipping address → billing address → customer default address → the
buyer's GSTIN state. If none resolves to an Indian state, the order is reported as not
invoiceable rather than being silently treated as intra-state.

**Tax split**: seller state == place of supply → CGST + SGST at half the rate each;
otherwise IGST at the full rate. Odd paise go to SGST so the two halves always sum to the
line tax exactly.

**Rate resolution** is table-driven — no rate or HSN is hardcoded in the calculator.
`data/hsn-rates.json` holds rules matched in ascending `priority`, first match wins:

```jsonc
{
  "id": "apparel-slab",
  "priority": 50,
  "match": [{ "field": "productType", "operator": "contains", "value": "apparel" }],
  "hsn": "6109",
  "slabs": [{ "maxUnitTaxableValue": 1000, "rate": 5 }, { "rate": 12 }]
}
```

- `field`: `sku` | `tag` | `productType` | `vendor` | `title` | `any`
- `operator`: `equals` | `startsWith` | `contains` | `regex` (case-insensitive by default)
- `rate` for a flat rate, or `slabs` for value-dependent rates (apparel, footwear)
- an empty `hsn` means "rate only" — the HSN comes from the line or the default HSN setting
- no match → the table fallback, whose HSN is the **Default HSN code** from Settings

Two per-product shortcuts need no rule editing: tag a product `gst:5` / `gst:12` / `gst:18`
to pin its rate, or `hsn:61091000` (or a `custom.hsn` product metafield) to pin its HSN.

Slabs are defined on the per-unit *taxable* value, which is circular when prices are
tax-inclusive. Each slab is tested for self-consistency: apply the slab's rate, strip the
tax, check the result still falls inside that slab. In the narrow band where no slab is
consistent, the gross value decides (the higher rate).

**Delivery charges.** By default delivery is taxed as a **separate service**: it gets its
own line at the rate of the `SHIPPING` rule in `data/hsn-rates.json` (18%) - CGST 9% +
SGST 9% in-state, IGST 18% out of state - with **no HSN/SAC code** printed, and its own row
in the HSN summary labelled with the line's description. The goods lines keep their own
rates. Two alternatives can be selected in Settings:

| Treatment | What the invoice shows |
| --- | --- |
| `SEPARATE_SERVICE` (default) | Own delivery line at the delivery rate (18%), no code unless a delivery SAC is set |
| `COMPOSITE_LINE` | Own delivery line at the rate **and** under the HSN of the largest goods line by value |
| `APPORTION` | No delivery line - freight is split across the goods lines pro rata, each slice at its own line's rate |

The delivery **rate** lives in the rate table (the Settings screen shows the rate that will
apply). The optional **Delivery SAC code** in Settings is the only source of a code for the
delivery line: left blank, nothing is printed - the line never borrows the rate rule's code
or the default goods HSN. With GST-inclusive prices the customer pays the same; an Rs.80
delivery charge is Rs.67.80 taxable + Rs.12.20 GST.

The delivery line's description is the **Delivery line label** setting (default "Delivery
charges"), not Shopify's shipping rate name. To compare treatments without issuing anything,
preview an order with `?shipping=APPORTION|COMPOSITE_LINE|SEPARATE_SERVICE`.

### Auditing the catalogue

```
GET /api/products                  first 50 products, by title
GET /api/products?first=250        a bigger page
GET /api/products?query=shirt      Shopify product search syntax
GET /api/products?audit=1          summary only, no per-product rows
```

For every variant it reports the HSN and rate that would be applied, **and where each came
from**, because the resolution is layered:

| `hsnSource` | Means |
| --- | --- |
| `variant-hs-code` | the variant's own Harmonized System code - wins over everything |
| `product-tag` | the product carries an `hsn:61091000` tag |
| `product-metafield` | the product's `custom.hsn` metafield |
| `rate-table-rule` | a rule in `data/hsn-rates.json` supplied it |
| `default-setting` | nothing matched; the **Default HSN** from Settings was used |

Without that trace you cannot tell a correct HSN from a lucky one - the default happening to
equal what the product should have had. `audit=1` also lists which rules the catalogue is
riding on, and flags products whose variants straddle a price-slab boundary (`mixedRates`).

The rate always comes from the rate table, even when the HSN comes from the product. That
keeps historical invoices explainable: a rate is always traceable to a rule.

#### One product, in full

```
GET /api/products/8992666321073            numeric product id
GET /api/products/mens-black-checked-shirt product handle
GET /api/products/<id>?trace=0             skip the per-variant rule trace
```

Returns the product's details (type, vendor, tags, inventory, image, timestamps) and, per
variant, the resolved HSN and rate **plus the full rule trace** - every rule that was
considered, in resolution order, with the condition that failed and which rule won:

```
[  -  ]   15 u3-tshirts-type   failed: productType equals "T-Shirts"
[  -  ]   20 u3-tshirt-title   failed: title regex "t-?shirts?|\btees?\b"
[WON  ]   30 u3-shirt-title    hsn=6205 rate=5%
[match]  900 u3-default-garment hsn=61091000 rate=5%
```

The near-misses are the useful part: the last line above is what this shirt *used* to get
before a shirt rule existed. `hsnExplanation` says the same thing in a sentence.

### Rounding

All money is rounded half-up to two decimals in one place (`lib/gst/money.ts`). Tax is
computed per line, the grand total is rounded to the nearest rupee, and the difference is
printed as a **Round off** row.

---

## Commands

```bash
npm run dev        # dev server on :3100
npm run build      # production build
npm start          # production server
npm test           # 76 unit tests (engine, store, PDF smoke)
npm run typecheck  # tsc --noEmit
```

The PDF smoke test writes a sample invoice to your temp directory, so you can eyeball the
layout after changing `lib/pdf/InvoiceDocument.tsx`.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/orders` | paginated order rows with invoice status |
| `GET` | `/api/orders/:id` | one order: raw Shopify payload, normalised order, GST decisions, invoice history |
| `POST` | `/api/orders/:id/invoice` | issue the invoice (or return the existing one) |
| `GET` | `/api/orders/:id/invoice/preview` | dry run: the invoice that order would get, allots nothing (`?shipping=APPORTION` to compare treatments) |
| `GET` | `/api/invoices` | issued invoices and the counter |
| `GET` | `/api/invoices/:key` | the frozen snapshot |
| `GET` | `/api/invoices/:key/pdf` | re-render the snapshot as a PDF (`?disposition=inline` to view) |
| `GET` | `/api/sample-invoice` | layout preview from a fabricated order (allots nothing) |
| `GET` `PUT` | `/api/settings` | read / save settings |
| `POST` `DELETE` | `/api/settings/logo` | upload / remove the logo |
| `GET` | `/api/products` | catalogue with the HSN and rate each product resolves to, and from where |
| `GET` | `/api/products/:idOrHandle` | one product in full, with the rule trace behind its HSN and rate |
| `GET` | `/api/hsn-rates` | the live rate table |
| `GET` | `/api/health` | is the server configured and does the token work |

## Seeing what an invoice will look like

```
GET /api/sample-invoice            place of supply = your state  -> CGST + SGST
GET /api/sample-invoice?pos=29     place of supply = Karnataka    -> IGST
GET /api/sample-invoice?download=1 download instead of viewing inline
```

Or use the two buttons in the **Preview** section at the bottom of the Settings screen.

The preview runs a made-up order through the real engine and the real template with your
saved settings and rate table, so it is an accurate picture of the finished document. The
sample order is built to exercise the whole layout: a slab-priced apparel line, a line
whose rate is pinned by a `gst:5` tag, a line that falls through to your default HSN, a
line discount, and shipping - which is why the HSN summary has four rows.

It is read-only by construction: the route never calls `store.issueInvoice`, so **no
invoice number is allotted and no file is written** - open it as often as you like. The
number shown is the one the next real invoice would get. The PDF is stamped `SAMPLE` and
its footer says it is not a valid tax invoice. If Settings has not been filled in yet,
placeholder seller details are substituted so the preview still renders.

## Troubleshooting

`GET /api/health` answers with the status code alone:

| Code | `status` | Meaning |
| --- | --- | --- |
| 200 | `OK` | configured, and both scopes verified against the live Admin API |
| 503 | `NOT_CONFIGURED` | `.env` missing or incomplete - nothing wrong with the app |
| 502 | `SHOPIFY_ERROR` | credentials present but Shopify rejected them; `checks` says which scope |

Add `?quick=1` to skip the two live API calls and check configuration only. The access
token never appears in the response.

Two things that look like bugs but are not:

- **`GET /api/health` returns 503.** Create `.env` (see above) and **restart** the dev
  server - Next.js reads `.env` only at startup.
- **Port already in use.** The dev server runs on **3100** because another project on this
  machine listens on 3000. Hitting `localhost:3000/api/health` reaches that other app,
  which replies `{"detail":"Not Found"}`. Change the port in `package.json` if you prefer.

## Backups

`./data` is your invoice register and is gitignored. Back it up — a lost `counter.json`
alone is recoverable (it is rebuilt from the snapshot files), but losing
`data/invoices/` loses the invoices themselves.
