# Azure Quiz – Cloudflare Workers + Pages + D1

نسخه بازنویسی‌شده برای Cloudflare با **همان قابلیت‌های** نسخه Flask.

## معماری

- **Worker (Hono):** تمام APIها
- **D1:** اعضا، سؤالات، نتایج
- **Assets:** فرانت PWA
- **Excel:** فقط Import/Export با SheetJS (ذخیره اصلی روی D1 است)

## پیش‌نیاز

- حساب Cloudflare
- Node.js 18+
- نصب: `npm i -g wrangler` و لاگین: `wrangler login`

## راه‌اندازی

```bash
cd azure-quiz-cf
npm install

# 1) ساخت دیتابیس
npm run db:create
# خروجی یک database_id می‌دهد → در wrangler.toml جایگزین REPLACE_WITH_YOUR_D1_DATABASE_ID

# 2) Migration + Seed
npm run db:migrate:remote
npm run db:seed:remote

# 3) Secret
npx wrangler secret put SECRET_KEY
# یک رشته تصادفی وارد کنید

# 4) Deploy
npm run deploy
```

آدرس نهایی چیزی شبیه:

```text
https://azure-quiz-cf.<your-subdomain>.workers.dev
```

همین لینک را در **آدرس دکمه ایتایار** بگذارید.

## ادمین

کد ملی ادمین در `wrangler.toml`:

```toml
ADMIN_NATIONAL_IDS = "1274829860"
```

## توسعه محلی

```bash
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

## نکات

- فایل‌های سنگین اکسل لازم نیست؛ Import/Export سبک است.
- Cookie سشن با `Secure` است → روی HTTPS کار می‌کند.
- حذف درس فقط سؤالات را پاک می‌کند؛ نتایج تاریخی می‌مانند.
