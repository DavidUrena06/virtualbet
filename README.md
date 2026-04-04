# VirtualBet — Instrucciones de instalación y deploy
# =======================================================

## Stack gratuito y permanente
- Backend:    Render        (Node.js + Express)
- Base datos: Supabase      (PostgreSQL)
- Frontend:   Vercel        (HTML/CSS/JS estático)
- Anti-sleep: UptimeRobot   (mantiene el servidor despierto)

---

## PASO 1 — Clonar y preparar el proyecto

```bash
git clone https://github.com/TU_USUARIO/virtualbet.git
cd virtualbet/backend
npm install
```

---

## PASO 2 — Crear la base de datos en Supabase (GRATIS)

1. Entrá a https://supabase.com y creá una cuenta
2. "New project" → poné nombre "virtualbet" → elegí contraseña fuerte
3. Esperá ~2 minutos que se cree
4. Andá a: Settings → Database
5. Bajá hasta "Connection string"
6. Copiá:
   - "Transaction pooler" (puerto 6543) → es tu DATABASE_URL
   - "Direct connection"  (puerto 5432) → es tu DIRECT_URL

---

## PASO 3 — Configurar variables de entorno en local

```bash
# Desde la carpeta backend/
cp .env.example .env
# Editá el archivo .env con tus datos de Supabase y JWT
```

El .env debe quedar así:
```
DATABASE_URL="postgresql://postgres.XXXX:PASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://postgres.XXXX:PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
JWT_SECRET="string_muy_largo_y_aleatorio"
JWT_EXPIRES_IN="7d"
PORT=3000
NODE_ENV=development
FRONTEND_URL="http://localhost:5500"
HOUSE_EDGE=0.03
WELCOME_BONUS=1000
ADMIN_USERNAME="admin"
ADMIN_EMAIL="admin@virtualbet.com"
ADMIN_PASSWORD="CambiaEsto123!"
```

Generá el JWT_SECRET con:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## PASO 4 — Crear las tablas y el admin inicial

```bash
# Desde la carpeta backend/
npx prisma migrate dev --name init
npx prisma generate
node prisma/seed.js
```

Deberías ver:
```
✅ Conectado a PostgreSQL (Supabase)
✅ Admin creado exitosamente
```

---

## PASO 5 — Correr en local

```bash
# Backend (en una terminal)
cd backend
npm run dev
# → API corriendo en http://localhost:3000

# Frontend (en otra terminal o con Live Server en VS Code)
# Abrí frontend/pages/login.html con Live Server
# O instalá: npm install -g serve
serve frontend
# → Frontend en http://localhost:5500 o 3000
```

Para probar la API:
```bash
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"...","service":"VirtualBet API"}
```

---

## PASO 6 — Deploy del BACKEND en Render (GRATIS)

1. Subí el proyecto a GitHub:
```bash
git add .
git commit -m "VirtualBet inicial"
git push origin main
```

2. Entrá a https://render.com → creá cuenta con GitHub
3. "New" → "Web Service"
4. Conectá tu repo de GitHub → seleccioná "virtualbet"
5. Configuración:
   - Name: virtualbet-api
   - Root Directory: backend
   - Runtime: Node
   - Build Command: `npm install && npx prisma generate && npx prisma migrate deploy`
   - Start Command: `npm start`
   - Plan: **Free**

6. En "Environment Variables" agregá TODAS las variables de tu .env
   (las mismas que tenés local, pero con NODE_ENV=production)
   Para FRONTEND_URL poné la URL de Vercel que obtenés en el paso 7

7. Hacé clic en "Create Web Service"
8. Render tardará ~3-5 minutos en el primer deploy
9. Tu API quedará en: https://virtualbet-api.onrender.com

---

## PASO 7 — Deploy del FRONTEND en Vercel (GRATIS)

1. Entrá a https://vercel.com → creá cuenta con GitHub
2. "New Project" → importá tu repo
3. Framework Preset: **Other**
4. Root Directory: **frontend**
5. Deploy

Tu frontend quedará en: https://virtualbet.vercel.app (o similar)

6. Copiá esa URL y actualizá en Render la variable FRONTEND_URL

---

## PASO 8 — Configurar UptimeRobot (mantiene el servidor despierto)

El free tier de Render duerme el servidor si no hay requests en 15 minutos.
Esto lo solucionamos gratis con UptimeRobot.

1. Entrá a https://uptimerobot.com → creá cuenta gratis
2. "Add New Monitor":
   - Monitor Type: HTTP(s)
   - Friendly Name: VirtualBet API
   - URL: https://virtualbet-api.onrender.com/health
   - Monitoring Interval: **5 minutes**
3. Guardá

El servidor quedará SIEMPRE encendido. Cada 5 minutos UptimeRobot
pingea /health y Render no lo apaga jamás. ✅

---

## PASO 9 — Verificar que todo funciona

Abrí tu frontend en Vercel, creá una cuenta de prueba,
verificá que el balance de 1000 monedas aparezca,
jugá una partida de Dice.

Para acceder al panel admin:
- Entrá con el email/password del ADMIN_EMAIL/ADMIN_PASSWORD de tu .env
- Te redirigirá a admin.html automáticamente

---

## Comandos útiles en desarrollo

```bash
# Ver las tablas en una interfaz gráfica
npx prisma studio

# Resetear la BD completa (¡BORRA TODO!)
npx prisma migrate reset

# Generar nueva migración después de cambiar schema.prisma
npx prisma migrate dev --name nombre_del_cambio

# Ver logs de Render en tiempo real
# Desde el dashboard de Render → tu servicio → Logs
```

---

## Estructura final del proyecto

```
virtualbet/
├── render.yaml                    ← Config deploy Render
├── vercel.json                    ← Config deploy Vercel
├── backend/
│   ├── package.json
│   ├── .env.example
│   ├── prisma/
│   │   ├── schema.prisma          ← Todas las tablas
│   │   └── seed.js                ← Crea el admin inicial
│   └── src/
│       ├── app.js                 ← Servidor principal
│       ├── auth/                  ← Login, registro, JWT
│       ├── wallet/                ← Balance, transacciones
│       ├── games/                 ← Dice, Coinflip, Crash...
│       ├── betting/               ← Apuestas deportivas
│       ├── admin/                 ← Panel de administrador
│       ├── cron/                  ← Recargas automáticas
│       ├── middleware/            ← Auth, validaciones
│       └── routes/                ← Rutas generales
└── frontend/
    ├── css/main.css               ← Tema casino completo
    ├── js/api.js                  ← Cliente HTTP + Auth
    └── pages/
        ├── login.html
        ├── register.html
        ├── dashboard.html         ← Lobby principal
        ├── sports.html            ← Apuestas deportivas
        ├── profile.html
        ├── history.html
        ├── admin.html             ← Panel admin
        └── games/
            ├── dice.html
            ├── coinflip.html
            └── crash.html
```
# virtualbet
