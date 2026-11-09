# Anime Arena 2 — Backend + Site

`anime-arena2.html` o‘yini serverga ko‘chirildi: hisoblar SQLite’da saqlanadi, o‘yin holati
(loglar, level, tanga, almaz, hero’lar, tarix) har bir kirishda tiklanadi. Qo‘shimcha ravishda
**jonli (odamlar) turniri**, **yashirin admin panel** va **Telegram orqali almaz sotish** qo‘shildi.

> **Bu repo — backend-only.** Frontend alohida `fronted/` papkasida joylashtiriladi.
> Backend statik fayllarni `../fronted` dan beradi; u papka bo‘lmasa `/` 404 qaytaradi,
> lekin `/api/...` ishlaydi. Alohida hostingda frontendning `API_BASE` qiymatini shu
> backend URL’iga o‘zgartiring.

- **0 tashqi dependency** — faqat Node.js ichki modullari (`node:http`, `node:sqlite`, `node:crypto`).
- **SQLite** — baza birinchi ishga tushishda avtomatik yaratiladi.
- **124 hero** — katalog `anime-arena2.html` dan avtomatik ajratiladi.
- **24 ta avtomatik test** — `npm test`.

> Talab: **Node.js 22.5+** (loyihada 26.13 da tekshirilgan). `node:sqlite` ishlatilgani uchun
> `better-sqlite3` kabi native paketlar shart emas.

---

## 1. Ishga tushirish

```powershell
cd C:\Users\PC\OneDrive\Desktop\backand
npm start
```

| Manzil | Tavsif |
| --- | --- |
| `http://127.0.0.1:8787/` | **O‘yin** (`anime-arena2` + bulut integratsiyasi) |
| `http://127.0.0.1:8787/console.html` | API console (register/login/shop/progress sinash) |
| `http://127.0.0.1:8787/api/health` | Health check |
| `http://127.0.0.1:8787/api/catalog` | Hero, tier, rank, arena, monster ro‘yxati |

Boshqa port: `$env:PORT=9000; npm start`.

### Skriptlar

| Buyruq | Vazifasi |
| --- | --- |
| `npm start` | Serverni ishga tushirish |
| `npm run dev` | `--watch` rejimida |
| `npm run extract` | `anime-arena2.html` dan katalogni qayta ajratish |
| `npm test` | 24 ta API testini yurgizish |
| `node tools/extract-catalog.js "D:\path\anime-arena2.html"` | Boshqa nusxadan ekstrakt qilish |

---

## 2. Hisoblar (login / registratsiya)

O‘yin boshida chiqadigan panelda ikki bo‘lim bor:

- **Kirish** — nickname yoki Gmail + parol. Hisob serverda bo‘lsa, butun o‘yin holati
  (tanga, almaz, level, hero’lar, xaritalar, turnir tarixi, sozlamalar) avtomatik tiklanadi.
- **Ro‘yxatdan o‘tish** — ism, familiya, nickname, yosh, Gmail, parol. Parol talabi:
  kamida 6 harf, 3 raqam va 1 belgi.

Hisob yaratilganda boshlang‘ich holat: 15 000 tanga, 8 token, `std` arena, ikkita sinov hero’si.
Har bir o‘zgarish (xarid, level, turnir yakuni, sozlama) 700 ms debounce bilan
`PUT /api/player/state` orqali SQLite’ga yoziladi.

> Eski `localStorage` hisobi bo‘lsa, birinchi marta kirganingizda u bulutga ko‘chiriladi.

### Admin hisobi

`xasanovlazizbek10@gmail.com` Gmail’i **band qilingan**. Faqat `ADMIN_PASSWORD` env’da
o‘rnatilgan parol bilan ro‘yxatdan o‘tish/kirish mumkin:

```text
Gmail:  xasanovlazizbek10@gmail.com
Parol:  <ADMIN_PASSWORD> (env orqali o‘rnatiladi)
```

Bu hisob bilan kirilganda o‘yin avtomatik **Admin panelga** o‘tadi va faqat admin ko‘radigan
qo‘shimcha menyu paydo bo‘ladi. Boshqa hech kim bu Gmail’ni boshqa parol bilan ro‘yxatdan
o‘tkaza olmaydi. Kodda default parol yo‘q — `ADMIN_PASSWORD` majburiy.

---

## 3. Jonli (odamlar) turniri

O‘yinda **“Jonli turnir”** yangi menyusi bor. Bu — haqiqiy o‘yinchilar ishtirok etadigan,
lekin jangni **server boti** olib boradigan turnir. O‘yinchi faqat kuzatadi; ikki o‘yinchi
o‘rtasida to‘g‘ridan-to‘g‘ri aloqa yo‘q — hamma bir xil holatni (`/api/live/state`) ko‘radi.

Qoidalar (standart qiymatlar):

| Qoida | Qiymat |
| --- | --- |
| Sig‘im | 16 ishtirokchi |
| Boshlanish | ro‘yxat to‘lganda; to‘lmasa 1 soatlik ro‘yxat oynasi yopilganda (kamida 2 kishi) |
| Keyingi turnir | oldingi turnir boshlanganidan kamida **1 soat** keyin |
| Janglar | bitta-bitta, ketma-ket; har jang orasida **1 daqiqa tanaffus** |
| Jang davomiyligi | ~18–28 soniya (server tomonda bir marta hisoblanadi) |
| Chempion mukofoti | +30 000 tanga, +10 almaz |
| Tarix | oxirgi 30 turnir, har bir foydalanuvchi uchun o‘rin va g‘alabalar |

Ishtirokchi o‘z hero’sini tanlaydi (do‘kondan olingan, sinov bo‘lmagan hero). Jang natijasi
va HP timeline’i serverda deterministik seed bilan yaratiladi — server qayta ishga tushsa ham
bir xil natija saqlanadi.

Sozlash (env):

```powershell
$env:LIVE_TOURNAMENT_SIZE=16
$env:LIVE_REST_MS=60000        # tanaffus
$env:LIVE_CYCLE_MS=3600000     # keyingi turnir oralig‘i
$env:LIVE_REGISTRATION_MS=3600000
$env:LIVE_PRIZE_COINS=30000
$env:LIVE_PRIZE_DIAMONDS=10
```

> Server bitta processda ishlashi kerak: turnir soati shu processdagi taymer bilan yuradi.
> Bir nechta instance ishlatilsa, leader election yoki Redis lock kerak bo‘ladi.

---

## 4. Admin panel

Admin panelda:

- Ro‘yxatdan o‘tgan barcha foydalanuvchilar ro‘yxati (`nickname`, Gmail, tanga, almaz, level).
- Nickname yoki Gmail bo‘yicha **qidiruv**.
- Foydalanuvchini tanlab, unga **almaz o‘tkazish** (1 … 1 000 000), izoh bilan.
- Har bir o‘tkazma `transactions` va `admin_audit` jadvallariga yoziladi (kim, kimga, qancha,
  oldingi va yangi balans).
- Admin panel menyusi faqat `role = 'admin'` bo‘lgan hisobda ko‘rinadi.

API:

```text
GET  /api/admin/users?q=...&limit=100&offset=0
POST /api/admin/diamonds     { userId, amount, note }
GET  /api/admin/audit?limit=30
```

---

## 5. Almaz sotib olish (Telegram)

O‘yindagi **Premium / Almaz** bo‘limida Stripe sinov havolasi olib tashlandi. Uning o‘rniga:

- Tugma: **“Admin bilan gaplashish”**
- Havola: **https://t.me/Xasanov_lazizbek8** (`@Xasanov_lazizbek8`)

Foydalanuvchi admin bilan kelishadi, karta orqali to‘laydi, admin esa admin panel orqali
almazlarni hisobiga o‘tkazadi.

---

## 6. Ma’lumotlar ro‘yxati (ekstrakt)

`tools/extract-catalog.js` `anime-arena2.html` dagi data-bloklarini **xavfsiz `vm` sandbox**
ichida baholaydi (DOM, tarmoq va fayl tizimiga ruxsat yo‘q) va quyidagilarni yozadi:

```text
data/
├─ catalog.json     1.4 MB   — hammasi birga (server shuni o‘qiydi)
├─ heroes.json      690 KB   — 124 hero (stats + skills + prices + tier)
├─ tiers.json         3 KB   — E→Z darajalar va har biridagi hero'lar
├─ ranks.json         2 KB   — 7 account rank (Total chegaralari)
├─ maps.json          4 KB   — 10 arena (3 oddiy + 7 rank mukofoti)
├─ monsters.json      5 KB   — 12 level mahluqi
└─ anime-arena.db            — runtime bazasi (avtomatik yaratiladi)
```

Qamrab olingan bloklar: asosiy `H` ro‘yxati, balance patchlar, `EXPANSION_HEROES`,
`PREMIUM_HEROES`, `LANDMARK_HEROES`, tier/rank jadvallari, xaritalar va mahluqlar.
Ya’ni JSON — o‘yin ichida haqiqatda ishlaydigan qiymatlar.

---

## 7. Arxitektura

```text
anime-arena-top/
├─ fronted/                       # statik sayt — backend shu papkadan beradi
│  ├─ index.html                  # anime-arena2 + cloud integratsiyasi
│  ├─ game-integration.js         # login/register, cloud save, live, admin UI
│  ├─ game-extra.css              # yangi UI stillari
│  ├─ console.html / app.js / style.css
│  ├─ manifest.webmanifest / sw.js / icons/
│  └─ catalog.json                # Cloudflare Worker uchun katalog
└─ backand/                       # shu papka
   ├─ server.js                   # HTTP entrypoint
   ├─ src/                        # router, API, services, util
   ├─ data/                       # katalog JSON + SQLite baza
   ├─ tools/extract-catalog.js
   ├─ tests/api.test.js
   ├─ cloudflare/                 # Workers + D1 deploy varianti
   └─ client/anime-arena-api.js   # ixtiyoriy brauzer SDK
```

### Ma’lumotlar bazasi

`users`, `sessions`, `players`, `player_states`, `owned_heroes`, `owned_maps`, `transactions`,
`level_runs`, `tournaments`, `live_tournaments`, `live_entries`, `live_matches`, `admin_audit`,
`meta` — barcha pul/progress operatsiyalari SQL tranzaksiya ichida (`BEGIN IMMEDIATE`).

`player_states` — o‘yinning to‘liq JSON snapshoti. `players` jadvalidagi wallet/progress
ustunlari shu snapshot bilan sinxronlanadi (leaderboard, admin panel va jonli turnir uchun).

---

## 8. API

`🔒` — `Authorization: Bearer <token>` (yoki `aa_session` HttpOnly cookie) talab qiladi.

### Auth
| Method | Endpoint | Tavsif |
| --- | --- | --- |
| POST | `/api/auth/register` | Ro‘yxatdan o‘tish → token + user + player |
| POST | `/api/auth/login` | Nickname yoki Gmail + parol |
| POST | `/api/auth/logout` | Sessiyani bekor qilish |
| GET | 🔒 `/api/auth/me` | Joriy foydalanuvchi + player |

### Cloud state
| Method | Endpoint | Tavsif |
| --- | --- | --- |
| GET | 🔒 `/api/player/state` | To‘liq o‘yin snapshoti |
| PUT | 🔒 `/api/player/state` | Snapshotni saqlash `{ state }` |

### Live tournament
| Method | Endpoint | Tavsif |
| --- | --- | --- |
| GET | 🔒 `/api/live/state` | Joriy turnir + bracket + jang + tarix |
| GET | 🔒 `/api/live/history` | Yakunlangan turnirlar |
| POST | 🔒 `/api/live/enter` | `{ heroId }` |
| POST | 🔒 `/api/live/leave` | Ro‘yxatdan chiqish (startgacha) |

### Admin (`role = admin`)
| Method | Endpoint |
| --- | --- |
| GET | 🔒 `/api/admin/users?q=...&limit=&offset=` |
| POST | 🔒 `/api/admin/diamonds` `{ userId, amount, note }` |
| GET | 🔒 `/api/admin/audit?limit=` |

### Qolgan endpointlar
Auth, catalog, player, shop, progress va leaderboard — quyidagi eski bo‘limlardagi kabi
(`/api/catalog`, `/api/shop/heroes`, `/api/progress/levels/complete`, `/api/leaderboard` …).
Batafsil: `src/app.js` dagi `ROUTES` jadvali.

---

## 9. Xavfsizlik va muhim eslatmalar

- **Parollar** — `scrypt` (N=16384, r=8, p=1) + har foydalanuvchiga alohida 16-byte salt;
  solishtirish `timingSafeEqual` bilan.
- **Sessiyalar** — 32-byte opaque token; bazada faqat SHA-256 hash. Token HttpOnly cookie
  yoki `Authorization: Bearer`.
- **SQL** — faqat prepared statementlar; dinamik ustun nomlari whitelist orqali.
- **Rate limit** — IP bo‘yicha 180 req/min, auth endpointlar uchun 12 req/min.
- **Body limit** — 64 KB (`/api/player/state` uchun 512 KB), faqat `application/json`.
- **CORS** — allowlist (`CORS_ORIGINS`).
- **Admin parol** — productionda albatta `ADMIN_PASSWORD` env orqali almashtiring.
- **Snapshot ishonchi** — solo o‘yin natijalari (coin/almaz) client snapshotidan saqlanadi.
  Jonli turnir mukofoti va admin o‘tkazmalari esa faqat serverda hisoblanadi. To‘liq
  anti-cheat kerak bo‘lsa, level/solo-turnir natijalarini ham serverda simulyatsiya qilish kerak.
- **Bitta process** — live ticker shu jarayonda ishlaydi. Bir nechta process uchun Redis yoki
  leader election qo‘shilishi kerak.
- **Bulutga chiqarish** — loyihani VPS’ga ko‘chirib, `NODE_ENV=production`, `SECURE_COOKIES=1`,
  HTTPS va `CORS_ORIGINS` ni sozlang. SQLite fayl (`data/anime-arena.db`) — baza; uni zaxiralang.

---

## 10. Env o‘zgaruvchilari

`.env.example` ga qarang. Asosiylari:

| Nomi | Standart | Tavsif |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `DB_PATH` | `data/anime-arena.db` | SQLite fayl |
| `ADMIN_EMAIL` | `xasanovlazizbek10@gmail.com` | Band qilingan admin Gmail |
| `ADMIN_PASSWORD` | — (majburiy) | Admin parol |
| `LIVE_TOURNAMENT_SIZE` | `16` | Jonli turnir sig‘imi |
| `LIVE_REST_MS` | `60000` | Janglar orasidagi tanaffus |
| `LIVE_CYCLE_MS` | `3600000` | Keyingi turnir oralig‘i |
| `LIVE_PRIZE_COINS` | `30000` | Chempion tangasi |
| `LIVE_PRIZE_DIAMONDS` | `10` | Chempion almazi |
| `STATE_LIMIT_BYTES` | `524288` | Snapshot hajmi chegarasi |
#   m y - b a c k a n d  
 