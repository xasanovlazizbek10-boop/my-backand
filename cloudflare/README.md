# Anime Arena Top — Cloudflare Workers + D1

Bu papka o‘yinni **Cloudflare Workers** (API + static assets) va **D1** (SQLite) ustida
ishga tushirish uchun. Asosiy Node backend (`../src`) o‘zgarmagan — bu alohida serverless port.
Static frontend `../../fronted` dan olinadi.

## 1. O‘rnatish

```powershell
cd C:\Users\PC\OneDrive\Desktop\anime-arena-server\cloudflare
npm install
npx wrangler login
```

## 2. D1 baza yaratish

```powershell
npx wrangler d1 create anime-arena-db
```

Chiqadigan `database_id` ni `wrangler.jsonc` dagi
`d1_databases[0].database_id` ga qo‘ying (hozir placeholder turibdi).

Keyin sxema:

```powershell
npm run db:remote
```

## 3. Deploy

```powershell
npx wrangler deploy
```

Worker nomi: **anime-arena-top**. Chiqadigan havola:

```text
https://anime-arena-top.<CLOUDFLARE_SUBDOMAIN>.workers.dev
```

Agar nom band bo‘lsa, `wrangler.jsonc` dagi `"name"` ni `anime-arena-top-uz` ga o‘zgartirib
qayta deploy qiling.

## 4. Admin

O‘yinda **Ro‘yxatdan o‘tish** bo‘limidan:

```text
Gmail:  xasanovlazizbek10@gmail.com
Parol:  <ADMIN_PASSWORD> (siz o‘rnatgan secret)
```

Birinchi ro‘yxatdan o‘tishdan keyin avtomatik admin panel ochiladi.

Admin parolini maxfiy saqlash uchun `wrangler.jsonc` dagi `ADMIN_PASSWORD` ni olib tashlab:

```powershell
npx wrangler secret put ADMIN_PASSWORD
```

## 5. Lokal test

```powershell
npm run db:local
npm run dev
```

`http://127.0.0.1:8788/` — o‘yin, `/api/health` — API.

## Muhim

- Jonli turnir soati **lazy tick** (har bir `/api/live/state` so‘rovida) va **cron trigger**
  (har daqiqa) orqali yuradi. Alohida background timer yo‘q.
- D1 bepul rejasida o‘qish/yozish limitlari bor; katta auditoriya uchun paid reja tavsiya etiladi.
- Parollar PBKDF2-SHA256 (30 000 iteratsiya) bilan saqlanadi.
- Static fayllar `../../fronted` dan olinadi (`fronted/catalog.json` ham shu yerda).
