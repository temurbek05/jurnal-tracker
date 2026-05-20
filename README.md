# JURNAL Roadmap Tracker

21-kunlik production roadmap'ni kunlik email hisobot bilan kuzatuvchi tracker.

## Mahalliy ishlatish

```bash
cp .env.example .env   # Gmail App Password kiriting
npm install
npm start
# http://localhost:5555
```

## Railway'ga deploy

1. **GitHub repo yarating** — bu papka uchun (web orqali yoki `gh repo create`)
2. **Railway → New Project → Deploy from GitHub repo**
3. **Variables** (Settings → Variables) — quyidagilarni qo'shing:

   | Kalit | Qiymat |
   |-------|--------|
   | `GMAIL_USER` | sizning@gmail.com |
   | `GMAIL_APP_PASSWORD` | App password (16 belgi) |
   | `REPORT_TO` | qabul qiluvchi@gmail.com |
   | `SEND_HOUR` | 21 |
   | `TZ` | Asia/Tashkent |
   | `DATA_DIR` | /data |

4. **Volume qo'shing** — Settings → Volumes → New Volume
   - Mount path: `/data`
   - Size: 1 GB (eng kichigi)

5. **Generate Domain** — Settings → Networking → Generate Domain
   - URL olasiz: `https://xxx.up.railway.app`

6. **Deploy** avtomatik boshlanadi — taxminan 2-3 daqiqa.
