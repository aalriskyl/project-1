# Tsuzumi Japan (`tsuzumijapan.com`) — Network Traffic & Legacy Backend Audit

> **Captured:** 2026-11-24 (read-only browser network reconnaissance across homepage, search, category & subcategory listings, best products, product detail, product comparison, articles, about/contact/care, cart redirect, and login views).

---

## 1. Domain & Product Overview

**Tsuzumi Japan** (`https://tsuzumijapan.com/`, operated by **PT Pelangi Teknik Indonesia**) is an industrial machinery and power-generation e-commerce platform selling:

- **Generator Sets (Gensets, 1–500 kVA):** Silent, open, portable, inverter, welding, and TKDN gensets powered by Tsuzumi, Perkins, Yanmar, Cummins, Isuzu, and FAW-VW engines.
- **Construction & Industrial Equipment:** Lighting towers (`Tower Light`), air compressors, water/submersible pumps, paint sprayers & hand mixers (`Alat Cat`), road construction machinery (`Cutting Machine`, `Bar Bending`), alternators, dynamos, and power stations.
- **Spare Parts & After-Sales:** Product-linked spare parts, technical/SEO articles, `Tsuzumi Care` warranty/service info, product comparison, customer reviews, and direct e-commerce checkout / WhatsApp inquiry flows.

---

## 2. Observed Legacy Architecture

```text
Browser (Nuxt 2 SPA / SSR)
  ├──► https://tsuzumijapan.com/api/*          (Origin 1: Express + Nuxt 2 BFF, Cloudflare cached)
  ├──► https://api-v1.tsuzumijapan.com/v1/*    (Origin 2: Catalog & Content REST API, Express/Helmet)
  └──► https://api-ecom.tsuzumijapan.com/api/* (Origin 3: E-Commerce RPC-style API)
```

### Infrastructure & Third-Party Clues

| Layer            | Observed Technology                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Frontend         | Nuxt.js v2 SSR (`/_nuxt/*`, `data-n-head="ssr"`), Bulma CSS, 360° hero product viewer (`/360/bg/*.avif`)                   |
| BFF / Web Server | Express (`x-powered-by: Express`) behind Cloudflare CDN/WAF (`cf-ray`, `cf-cache-status`)                                  |
| Databases        | **Hybrid split:** PostgreSQL/SQL (`UUIDv4` on categories, subcategories, products) + MongoDB (`24-hex ObjectId` on CMS)    |
| Object Storage   | AWS S3 (`tsuzumi-bucket.s3.ap-southeast-1.amazonaws.com`) + `wsrv.nl` image optimization proxy                             |
| Payments         | **Xendit** (`https://checkout.xendit.co` whitelisted in `Content-Security-Policy` `script-src`)                            |
| Authentication   | Phone/Email + Password login, Registration, Forgot Password, and **Google OAuth** (`apis.google.com`, Sign in with Google) |
| Customer Support | Tawk.to live chat (`embed.tawk.to`), Trustindex Google review widget, WhatsApp (`wa.me`)                                   |

### SSR Hydration vs. Client-Side Behavior

1. **Initial SSR Load:** Full document requests (`GET /`, `/product/...`, `/article/...`) render HTML server-side via Nuxt 2. On initial `/` load, banners, categories, best products, and top articles are hydrated in HTML, while `/v1/brands` and `/v1/clients` are fetched client-side via XHR. Subsequent client-side SPA navigations call all JSON endpoints directly.
2. **Client-Side Product Compare (`/compare`):** Clicking _Bandingkan_ stores product UUIDs in client storage without calling the server. Opening `/compare` fires one `GET /api/product.find-by-id?id=<uuid>` request **per compared product** (N+1 client fan-out).
3. **Auth-Gated Cart & Checkout:** All catalog and content endpoints are public (no `Authorization` header or API key). Navigating to `/cart` or clicking _Beli Sekarang_ while unauthenticated redirects client-side to `/auth/login` before firing any cart API request.

---

## 3. Discovered Network Endpoints Catalog

### Origin A — Same-Origin BFF (`https://tsuzumijapan.com/api/*`)

Common headers: `Accept: application/json, text/plain, */*`, `Origin/Referer: https://tsuzumijapan.com`. Origin sets `Cache-Control: no-store` on several routes while Cloudflare caches responses at the edge (`cf-cache-status: HIT` / `REVALIDATED`).

#### A1. `GET /api/banners`

- **UI Trigger:** Homepage hero / promotional banner carousel (`/`).
- **Auth:** Public.
- **Response (`200 OK`):**
  ```json
  {
    "success": true,
    "banners": [
      {
        "id": "6457c3040fc0d2862fdbf510",
        "link": "https://www.youtube.com/watch?v=ObH3ZNu6OFU",
        "photo": "https://tsuzumi-bucket.s3.ap-southeast-1.amazonaws.com/1683473259710.png"
      }
    ]
  }
  ```

#### A2. `GET /api/products-categories`

- **UI Trigger:** Global navbar/footer category menus, homepage category grid, about/contact pages.
- **Query Params:**
  - `with_sub_categories` (`boolean`, optional) — embeds `sub_categories[]` per category.
  - `simple_list` (`boolean`, optional) — returns lightweight `{ name, url_image }` items.
  - `with_image` (`boolean`, optional) — used alongside `simple_list=true`.
- **Response (`200 OK`, full mode):**
  ```json
  {
    "data": [
      {
        "id": "6956e52a-d36c-49bc-ae94-049559e23b7f",
        "name": "Alat Cat",
        "desc": "...",
        "url_image": "https://tsuzumi-bucket.s3.ap-southeast-1.amazonaws.com/1665896104119.png",
        "url_banner_image": "https://tsuzumi-bucket.s3.ap-southeast-1.amazonaws.com/...",
        "banner_title": "Alat Cat",
        "created_at": "2025-01-10T00:00:00.000Z",
        "updated_at": "2026-06-06T03:09:18.087Z",
        "deleted_at": null,
        "sub_categories": [
          {
            "id": "uuid",
            "category_id": "6956e52a-d36c-49bc-ae94-049559e23b7f",
            "name": "HAND MIXER",
            "desc": "...",
            "created_at": "2025-01-10T00:00:00.000Z",
            "updated_at": "2025-01-10T00:00:00.000Z",
            "deleted_at": null
          }
        ]
      }
    ]
  }
  ```
- **Response (`200 OK`, `?simple_list=true&with_image=true`):**
  ```json
  {
    "data": [
      {
        "name": "Alat Cat",
        "url_image": "https://tsuzumi-bucket.s3.ap-southeast-1.amazonaws.com/1665896104119.png"
      }
    ]
  }
  ```

#### A3. `GET /api/products-categories-list`

- **UI Trigger:** Category product listing page (`/product/:categorySlug`).
- **Query Params:** `category` (`string`, lowercase category name, e.g. `alat cat`, `tower light`). Unpaginated.
- **Response (`200 OK`, bare JSON array):**
  ```json
  [
    {
      "id": "8ec529d2-fb16-4312-b733-a1880e5af2e9",
      "name": "Spray Gun Mortar TMG-II",
      "category_id": "6956e52a-d36c-49bc-ae94-049559e23b7f",
      "sub_category_id": null,
      "slug": "spray-gun-mortar-tmg-ii",
      "type": "product",
      "created_at": "2025-08-28T03:01:37.079Z",
      "updated_at": "2026-06-06T03:09:18.087Z",
      "deleted_at": null,
      "desc": "<p>...</p>",
      "keywords": [],
      "category_name": "Alat Cat",
      "sub_category_name": null,
      "images": [
        {
          "id": "uuid",
          "product_id": "8ec529d2-fb16-4312-b733-a1880e5af2e9",
          "image": "https://tsuzumi-bucket.s3.ap-southeast-1.amazonaws.com/....png",
          "order": 1
        }
      ],
      "price": 650000,
      "is_best_product": false,
      "stock": 10
    }
  ]
  ```

#### A4. `GET /api/best-product`

- **UI Trigger:** Featured / Best Products page (`/product/best-products`) and homepage featured products section.
- **Query Params:** `limit` (`number`, observed `limit=999`).
- **Response (`200 OK`):** List of products where `is_best_product = true`.

#### A5. `GET /api/product.reviews`

- **UI Trigger:** Product detail page (`/product/view/:slug/:id` — _Ulasan_ section).
- **Query Params:** `productId` (`uuid`), `limit` (`number`, observed `5`), optional `cursor`.
- **Response (`200 OK`):**
  ```json
  {
    "ok": true,
    "data": [],
    "cursor": null
  }
  ```

#### A6. `GET /api/articles`

- **UI Trigger:** Initial load of `/article` listing page.
- **Query Params:** `limit` (`number`, observed `8`).
- **Response (`200 OK`, bare JSON array):**
  ```json
  [
    {
      "id": "6afff63744ee80a7c9946346",
      "title": "Mesin Potong Aspal: Fungsi, Spesifikasi, dan Pilihan untuk Pekerjaan Pemotongan Jalan",
      "photo": "https://tsuzumi-bucket.s3.ap-southeast-1.amazonaws.com/1795159616263-OPTIMALIN SEO (4).png",
      "created_at": "2026-11-20T07:26:47.745Z",
      "updated_at": "2026-11-20T07:27:04.763Z",
      "slug": "mesin-potong-aspal:-fungsi-spesifikasi-dan-pilihan-untuk-pekerjaan-pemotongan-jalan"
    }
  ]
  ```

---

### Origin B — Catalog & Content REST Service (`https://api-v1.tsuzumijapan.com/v1/*`)

Common response headers:

- `Access-Control-Allow-Origin: https://tsuzumijapan.com`
- `X-RateLimit-Limit: 30` (`X-RateLimit-Reset: 10` seconds)
- `Cache-Control: public, s-maxage=300|600|3600, max-age=300|600|3600`

#### B1. `GET /v1/brands`

- **UI Trigger:** Homepage "Powered By" engine brand cards (`/`).
- **Response (`200 OK`):**
  ```json
  {
    "success": true,
    "brands": [
      {
        "id": "6457bd080fc0d2862fdbf506",
        "name": "Tsuzumi Japan",
        "desc": "Tsuzumi Japan Engine Original...",
        "photo": "https://tsuzumi-bucket.s3.ap-southeast-1.amazonaws.com/1683471606273.png"
      }
    ]
  }
  ```

#### B2. `GET /v1/clients`

- **UI Trigger:** Homepage (`/`), `/about-us`, and layout footer/auth shell ("Satisfied Clients" logo grid).
- **Response (`200 OK`):**
  ```json
  {
    "success": true,
    "clients": [
      {
        "id": "63b41fba28e0b578ddb89b43",
        "photo": "https://tsuzumi-bucket.s3.ap-southeast-1.amazonaws.com/1672748982804.png"
      }
    ]
  }
  ```

#### B3. `GET /v1/products/categories`

- **UI Trigger:** Category & subcategory detail headers/banners (`/product/:categorySlug`).
- **Query Params:** `name` (`string`, e.g. `genset silent`, `alat cat`), `with_sub_categories` (`boolean`, optional).
- **Caching:** `s-maxage=3600, max-age=3600`.
- **Response (`200 OK`):** `{ "data": Category[] }` (same entity shape as `A2`).

#### B4. `GET /v1/products/sub-categories`

- **UI Trigger:** Category sidebar navigation (`/product/:categorySlug`).
- **Response (`200 OK`):**
  ```json
  {
    "data": [
      {
        "id": "uuid",
        "category_id": "6956e52a-d36c-49bc-ae94-049559e23b7f",
        "name": "HAND MIXER",
        "desc": "...",
        "created_at": "2025-01-10T00:00:00.000Z",
        "updated_at": "2025-01-10T00:00:00.000Z",
        "deleted_at": null,
        "category": {
          "id": "6956e52a-d36c-49bc-ae94-049559e23b7f",
          "name": "Alat Cat"
        }
      }
    ]
  }
  ```

#### B5. `GET /v1/products/categories/list`

- **UI Trigger:** Subcategory filter view (`/product/:categorySlug/:subCategorySlug`).
- **Query Params:** `category` (`string`), `sub_category` (`string`, e.g. `category=alat cat&sub_category=hand mixer`).
- **Caching:** `s-maxage=3600, max-age=3600`.
- **Response (`200 OK`):** Bare array `Product[]` (same shape as `A3`).

#### B6. `GET /v1/products/search`

- **UI Trigger:** Header search bar (`/search?product=<query>`).
- **Query Params:** `search` (`string`, e.g. `genset`, `perkins`).
- **Caching:** `s-maxage=300, max-age=300`.
- **Response (`200 OK`):**
  ```json
  {
    "data": [
      {
        "id": "75afab65-ce26-4515-9c48-0f91ce9cc2fd",
        "name": "Genset 30 Kva Silent Diesel Tsuzumi TPG30 kva Engine Powered by Perkins",
        "slug": "genset-30-kva-silent-diesel-tsuzumi-tpg30-kva-engine-powered-by-perkins",
        "type": "product",
        "is_best_product": true,
        "category_name": "Genset Silent",
        "sub_category_name": "Engine Perkins",
        "price": 177500000,
        "stock": 2,
        "images": [
          {
            "id": "uuid",
            "productId": "75afab65-ce26-4515-9c48-0f91ce9cc2fd",
            "image": "https://tsuzumi-bucket.s3.ap-southeast-1.amazonaws.com/....png",
            "order": 1
          }
        ]
      }
    ]
  }
  ```

#### B7. `GET /v1/products/random`

- **UI Trigger:** "Produk Terkait" (related products) on product detail, compare, and article sidebar views.
- **Caching:** `s-maxage=600, max-age=600`.
- **Response (`200 OK`):** `{ "data": ProductSummary[] }` (same summary shape as `B6`).

#### B8. `GET /v1/articles`

- **UI Trigger:** "View More Articles" pagination on `/article` and `/tsuzumicare`.
- **Query Params:** `limit` (`number`, default `8`), `page` (`number`, e.g. `2`).
- **Caching:** `s-maxage=3600, max-age=3600`.
- **Response (`200 OK`):** Bare array `ArticleSummary[]` (same shape as `A6`).

#### B9. `GET /v1/articles/:id`

- **UI Trigger:** Article detail page (`/article/:slug/:id`).
- **Path Param:** `id` (`24-hex ObjectId`).
- **Caching:** `s-maxage=3600, max-age=3600`.
- **Response (`200 OK`):**
  ```json
  {
    "id": "6afff63744ee80a7c9946346",
    "title": "Mesin Potong Aspal: Fungsi, Spesifikasi, dan Pilihan untuk Pekerjaan Pemotongan Jalan",
    "content": "<p>...</p>",
    "created_at": "2026-11-20T07:26:47.745Z",
    "updated_at": "2026-11-20T07:27:04.763Z"
  }
  ```

#### B10. `GET /v1/articles/random`

- **UI Trigger:** Related articles section on `/article/:slug/:id`.
- **Caching:** `s-maxage=600, max-age=600`.
- **Response (`200 OK`):** Bare array `Array<{ id, title, photo, slug, excerpt, created_at, updated_at }>`.

---

### Origin C — E-Commerce RPC Service (`https://api-ecom.tsuzumijapan.com/api/*`)

Common response headers: `Access-Control-Allow-Origin: https://tsuzumijapan.com`, `cf-cache-status: DYNAMIC`.

#### C1. `GET /api/product.find-by-id`

- **UI Trigger:** Product detail page (`/product/view/:slug/:id`) and Compare page (`/compare`, called N times).
- **Query Params:** `id` (`uuid`).
- **Response (`200 OK`):**
  ```json
  {
    "ok": true,
    "data": {
      "id": "bb3a980d-0d3f-442b-8aed-602dec5d67d9",
      "name": "HAND MIXER THM16-3",
      "desc": "<p>SPESIFIKASI...</p>",
      "price": 800000,
      "is_best_product": false,
      "stock": 5,
      "height": 48.5,
      "length": 45.5,
      "weight": 5.5,
      "width": 36.5,
      "videos": [],
      "sparepart_products": [],
      "category_id": "6956e52a-d36c-49bc-ae94-049559e23b7f",
      "keywords": [],
      "category_name": "Alat Cat",
      "sub_category_name": "HAND MIXER",
      "features_by_category": [
        {
          "id": "1e0cf09a-ff42-41da-b7c0-64271f5009cb",
          "title": "tes",
          "value": "",
          "category_id": "6956e52a-d36c-49bc-ae94-049559e23b7f",
          "column_spec_id": "09ef8bfe-f4d0-4abb-a5dc-da74784710d3",
          "product_id": "bb3a980d-0d3f-442b-8aed-602dec5d67d9",
          "created_at": "2026-06-06T03:08:46.544Z",
          "updated_at": "2026-06-06T03:08:46.544Z"
        }
      ],
      "features_by_sub_category": [],
      "productImages": [
        {
          "id": "1171a1b0-1ede-45c5-8c05-fd6523809818",
          "image": "https://tsuzumi-bucket.s3.ap-southeast-1.amazonaws.com/1774853484042-THM16-3_wm-05.png",
          "productId": "bb3a980d-0d3f-442b-8aed-602dec5d67d9",
          "order": 1,
          "created_at": "2026-06-06T03:08:46.544Z",
          "updated_at": "2026-06-06T03:08:46.544Z"
        }
      ]
    }
  }
  ```

#### C2. `GET /api/product.get-spareparts-by-product-id`

- **UI Trigger:** Product detail page (_Spareparts_ tab/section).
- **Query Params:** `productId` (`uuid`).
- **Response (`200 OK`):**
  ```json
  {
    "ok": true,
    "data": []
  }
  ```

---

## 4. Authenticated / Gated Flows Observed in UI & Headers

Because read-only reconnaissance did not create accounts or submit transactions, the following flows were identified from `/auth/login`, `/cart` redirects, product detail actions, and CSP directives:

1. **Customer Authentication (`/auth/login`):**
   - Identifier input accepts **phone number OR email** (`Nomor Hp atau Email`) + password.
   - Customer registration (`Daftar`), forgot-password flow (`Lupa password`), and **Google OAuth** (`Sign in with Google`).
2. **Shopping Cart & Checkout (`/cart`, `Beli Sekarang`):**
   - Server-persisted authenticated cart (add/update quantity/remove item, stock check against `product.stock`, shipping weight/dimensions calculation using `height`, `length`, `width`, `weight`).
   - Order creation + **Xendit** payment invoice/checkout integration (`checkout.xendit.co`) and payment status webhooks.
3. **Verified Product Reviews:**
   - Submitting customer star ratings/reviews to populate `product.reviews`.
4. **Backoffice / Admin Management:**
   - CRUD endpoints for categories, subcategories, dynamic specification columns (`column_spec_id`), products, spare-part links, banners, brands, client logos, articles, and S3/Storage media uploads.

---

## 5. Legacy Design Flaws to Fix When Forking

When rebuilding these services in `project-1`, **do not copy these legacy anti-patterns**:

1. **Four incompatible response envelopes:** Legacy endpoints mix `{ success: true, banners: [...] }`, `{ data: [...] }`, `{ ok: true, data: ... }`, and raw top-level JSON arrays `[...]`. Standardize everything onto `{ data }` / `{ data, meta }` / `{ error }`.
2. **Unbounded & unpaginated queries:** `/api/best-product?limit=999`, `/api/products-categories-list`, and `/v1/products/search` have no bounded pagination, risking memory/payload blowups as the catalog grows.
3. **Mixed naming & RPC URLs:** `product_id` vs `productId`, `images` vs `productImages`, and RPC verbs (`product.find-by-id`) mixed with REST paths (`/v1/products/...`).
4. **Filter by mutable display name instead of slug/ID:** `/v1/products/categories/list?category=alat%20cat` filters by raw category name (one category in production even has a trailing space: `"Alternator "`). Use immutable UUIDv7s or normalized URL slugs.
5. **Client-side N+1 on `/compare`:** Fetching compared products one-by-one should be replaced by a single batch endpoint (`GET /v1/products/compare?ids=...` bounded to e.g. 4 IDs).
6. **Dual-database split (MongoDB + SQL):** Banners, brands, clients, and articles have simple relational shapes and belong in the same Supabase PostgreSQL schema with UUIDv7 primary keys and RLS enabled.
7. **Raw inline-styled HTML in `desc` / `content`:** Sanitize HTML on write or store structured fields alongside sanitized rich text to prevent stored XSS.
