# VirtualBet — Documentación completa del proyecto

> Última actualización: 2026-06-16
> Repo: https://github.com/DavidUrena06/virtualbet
> Frontend: https://virtualbet-vert.vercel.app
> Backend: https://virtualbet.onrender.com

---

## 1. Stack y arquitectura

| Capa | Tecnología | Hosting | Costo |
|---|---|---|---|
| Frontend | HTML/CSS/JS vanilla | Vercel | Free |
| Backend | Node.js + Express + Prisma | Render | Free |
| Base de datos | PostgreSQL | Supabase | Free |
| Anti-sleep | UptimeRobot ping /health cada 5min | UptimeRobot | Free |
| Push notifications | Web Push API (VAPID) | Inline en backend | Free |
| Datos deportivos | ESPN (primario) + TheSportsDB (fallback) | API públicas | Free |

**Moneda interna:** BetCoins (BC). 1 BC = unidad ficticia, no convertible.

---

## 2. Estructura del proyecto

```
virtualbet/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma                    ← tablas
│   │   ├── seed.js                          ← admin inicial
│   │   └── migrations/
│   │       └── 20260616050000_add_chat_and_push/   ← chat + push
│   ├── scripts/
│   │   └── generate-vapid.js                ← genera VAPID keys
│   └── src/
│       ├── app.js                           ← server + middleware
│       ├── auth/                            ← login, registro, JWT
│       ├── wallet/                          ← balance, transacciones
│       ├── games/                           ← dice, coinflip, crash, mines, plinko, blackjack, keno
│       ├── betting/                         ← apuestas deportivas (legacy)
│       ├── sportsbook/                      ← apuestas deportivas (activa)
│       ├── sports/                          ← importador + resolver + ESPN + odds
│       │   ├── importer.js                  ← cron sync + updateLiveScores
│       │   ├── resolver.js                  ← paga apuestas ganadas
│       │   ├── espn.js                      ← scraper ESPN scoreboard
│       │   └── oddsCalculator.js            ← cuotas dinámicas por forma
│       ├── p2p/                             ← apuestas peer-to-peer
│       ├── friends/                         ← sistema social
│       ├── admin/                           ← panel admin
│       ├── chat/                            ← chat por partido (polling)
│       ├── push/                            ← Web Push notifications
│       ├── promo/                           ← daily bonus + leaderboard
│       ├── security/                        ← lockout + blacklist + rate limits
│       │   ├── loginAttempts.js
│       │   ├── passwordBlacklist.js
│       │   ├── rateLimiters.js
│       │   └── startup.js
│       ├── cron/scheduler.js                ← tareas programadas
│       ├── middleware/auth.middleware.js    ← JWT verify
│       └── routes/user.routes.js            ← perfil/stats
└── frontend/
    ├── index.html
    ├── sw.js                                ← service worker push
    ├── css/main.css
    ├── js/
    │   ├── api.js                           ← cliente HTTP + Auth
    │   ├── navbar.js
    │   ├── push.js                          ← cliente Web Push
    │   └── share.js                         ← generador imagen + share
    └── pages/
        ├── login.html, register.html
        ├── dashboard.html
        ├── sports.html                      ← sportsbook + chat + share
        ├── p2p.html
        ├── profile.html, history.html
        ├── friends.html
        ├── admin.html                       ← panel admin con sync-now
        └── games/                           ← dice, coinflip, crash, etc.
```

---

## 3. Decisiones de arquitectura

### 3.1 Por qué ESPN para scores en vivo

**Problema:** El endpoint `eventslive.php` de TheSportsDB free tier devuelve `{ events: null }` (es de pago). Por eso los marcadores nunca se actualizaban y los partidos quedaban en LIVE para siempre.

**Solución:** Usar la **API pública oculta de ESPN** (`site.api.espn.com/apis/site/v2/sports/soccer/{league}/scoreboard`).
- Sin API key
- Refresh ~30s
- Muy estable
- Misma que usa la app oficial

**Estrategia de 3 pasos en `updateLiveScores()`:**
1. **ESPN scoreboard por liga** (primario)
2. **TheSportsDB `lookupevent.php?id={id}`** (backup individual, free tier sí lo soporta)
3. **Fallback por tiempo:** partido >150 min en LIVE/UPCOMING → resolver con marcador actual (o 0-0 → DRAW si no hay datos)

**Mapeo de ligas internas → ESPN slugs:**
| Interno | ESPN slug |
|---|---|
| PREMIER_LEAGUE | `eng.1` |
| LA_LIGA | `esp.1` |
| SERIE_A | `ita.1` |
| CHAMPIONS_LEAGUE | `uefa.champions` |
| MLS | `usa.1` |
| COSTA_RICA_FPD | `crc.1` |
| FIFA_WORLD_CUP | `fifa.world` |

**Matching DB ↔ ESPN:** normalización de nombres de equipo + ventana ±2 días de fecha.

### 3.2 Por qué cuotas dinámicas (no fijas 2.0/3.2/2.0)

**Modelo en `oddsCalculator.js`:**
1. Para cada equipo, traer **últimos 5 partidos** via TheSportsDB `eventslast.php?id={teamId}`
2. Calcular **forma** ponderada: peso 5→4→3→2→1 desde más reciente. Puntos: 3 victoria / 1 empate / 0 derrota. Normalizar a [0,1].
3. **Fuerza local** = forma + 0.12 (ventaja de local). **Fuerza visita** = forma.
4. **Probabilidad de empate** baja cuando los equipos son disparejos: `pDraw = clamp(0.28 - |diff| × 0.18, 0.16, 0.32)`
5. Repartir el resto según diferencia de fuerza.
6. Aplicar **overround**: `1/odd × (1 + HOUSE_EDGE)`
7. Floor 1.10 / ceiling 15.00.

**Ejemplos:**
- Equipos parejos → `2.10 / 3.20 / 3.40`
- Favorito local vs underdog → `1.45 / 4.20 / 6.80`
- Underdog local vs favorito → `4.50 / 3.50 / 1.75`

**Cold start:** si no hay 5 partidos previos → odds default `2.10 / 3.30 / 3.20`.

**Refresh:** cada 6h se recalculan las odds de partidos UPCOMING que faltan >2h (no afecta apuestas ya colocadas — usan `oddAtBet` del momento de apostar).

### 3.3 Por qué chat con polling y no WebSocket

Free tier de Render **duerme los sockets después de 15 min** sin actividad. Polling cada 5s es 30 requests/min/usuario activo → totalmente manejable, y sobrevive al sleep.

**Anti-spam:** cooldown de 3s/mensaje en backend (in-memory Map) + rate limiter Express 60 msgs/5min + sanitización XSS con librería `xss`.

### 3.4 Por qué Web Push y no email/SMS

- **Email/SMS** = pago. Web Push API es gratis y nativa del navegador.
- Soporta Chrome, Firefox, Edge, Safari (con iOS 16.4+ y app agregada a home screen).
- Requiere VAPID keys (generadas una vez, guardadas en env vars).

**Eventos que disparan push:**
1. **Apuesta deportiva ganada** → desde `resolver.js` post-commit
2. **Partido apostado empieza en 15 min** → cron cada 5 min busca matches en ventana 13-18min
3. **Push de prueba** al activar opt-in

### 3.5 Por qué daily bonus con racha

Mecánica conocida que aumenta retención. Estructura:
| Día | BC | Mundial (x2) |
|---|---|---|
| 1 | 100 | 200 |
| 2 | 150 | 300 |
| 3 | 200 | 400 |
| 4 | 250 | 500 |
| 5 | 300 | 600 |
| 6 | 400 | 800 |
| 7 | 500 | 1000 |

Se resetea si el usuario falta >1 día. Durante Mundial 2026 (11 jun - 19 jul) se aplica x2.

**Implementación sin nuevo modelo:** se usa `Transaction` con type=`SCHEDULED_BONUS` y note prefix `DAILY:`. Se calcula la racha leyendo las últimas 14 transacciones del usuario con ese filtro.

### 3.6 Por qué Mundial pinned al top

Adquisición de usuarios. La sección Mundial siempre va primera en sports.html, con:
- Banner gradient animado
- Estrella ⭐ en el título de liga
- Badge ⭐ MUNDIAL en cada match-card
- Tab "Mundial" en leaderboard

---

## 4. Endpoints API

### 4.1 Auth (`/api/auth`)
| Method | Path | Auth | Descripción |
|---|---|---|---|
| POST | `/register` | público | Crear cuenta + wallet con welcome bonus |
| POST | `/login` | público | Login con lockout 5/email + 10/IP |
| GET | `/me` | JWT | Datos del usuario actual |

### 4.2 Wallet (`/api/wallet`)
| Method | Path | Auth | Descripción |
|---|---|---|---|
| GET | `/balance` | JWT | Balance + stats del wallet |
| GET | `/transactions` | JWT | Historial de transacciones |

### 4.3 Sportsbook (`/api/sports`)
| Method | Path | Auth | Descripción |
|---|---|---|---|
| GET | `/matches?league=&status=` | JWT | Partidos por liga y estado |
| GET | `/matches/:id` | JWT | Detalle de un partido |
| POST | `/bet` | JWT | Colocar apuesta (atomic tx) |
| GET | `/history` | JWT | Historial de apuestas del usuario |

### 4.4 P2P (`/api/p2p`)
| Method | Path | Auth | Descripción |
|---|---|---|---|
| POST | `/create` | JWT | Crear apuesta privada |
| POST | `/join` | JWT | Unirse a apuesta |
| POST | `/cancel` | JWT | Cancelar apuesta |
| GET | `/my` | JWT | Mis apuestas P2P |
| POST | `/invite` | JWT | Invitar amigo |
| POST | `/invite/respond` | JWT | Aceptar/rechazar invitación |
| GET | `/invitations` | JWT | Invitaciones recibidas |
| GET | `/:betId/friends` | JWT | Amigos invitables |

### 4.5 Games (`/api/games`)
| Method | Path | Auth | Descripción |
|---|---|---|---|
| POST | `/dice` | JWT | Jugar dice |
| POST | `/coinflip` | JWT | Jugar coinflip |
| POST | `/crash/start` | JWT | Iniciar ronda crash |
| POST | `/crash/cashout` | JWT | Cashout crash |
| POST | `/mines/start, /reveal, /cashout` | JWT | Mines |
| POST | `/plinko` | JWT | Jugar plinko |
| POST | `/blackjack/deal, /hit, /stand, /double` | JWT | Blackjack |
| POST | `/keno/play` | JWT | Jugar keno |
| GET | `/history` | JWT | Historial de juegos |

### 4.6 Friends (`/api/friends`)
| Method | Path | Auth | Descripción |
|---|---|---|---|
| GET | `/search?q=` | JWT | Buscar usuarios |
| GET | `/` | JWT | Lista de amigos |
| GET | `/requests` | JWT | Solicitudes pendientes |
| POST | `/request, /respond, /remove` | JWT | Acciones de amistad |

### 4.7 Chat (`/api/chat`) — **NUEVO**
| Method | Path | Auth | Descripción |
|---|---|---|---|
| GET | `/:matchId?after=ISO` | JWT | Mensajes (incremental si `after`) |
| POST | `/:matchId` | JWT | Enviar mensaje (cooldown 3s, 280 chars) |

### 4.8 Push (`/api/push`) — **NUEVO**
| Method | Path | Auth | Descripción |
|---|---|---|---|
| GET | `/public-key` | público | VAPID public key |
| POST | `/subscribe` | JWT | Registrar suscripción del navegador |
| POST | `/unsubscribe` | JWT | Quitar suscripción |
| POST | `/test` | JWT | Mandar push de prueba al usuario |

### 4.9 Promo (`/api/promo`) — **NUEVO**
| Method | Path | Auth | Descripción |
|---|---|---|---|
| GET | `/daily` | JWT | Status del bono diario |
| POST | `/daily/claim` | JWT | Reclamar bono del día |
| GET | `/leaderboard?period=&mundial=` | JWT | Top ganadores de la semana |

### 4.10 Admin (`/api/admin`)
| Method | Path | Auth | Descripción |
|---|---|---|---|
| GET | `/users` | ADMIN | Lista de usuarios paginada |
| GET | `/stats` | ADMIN | Métricas globales |
| GET | `/logs` | ADMIN | Audit log de acciones admin |
| POST | `/coins/give, /give-all, /remove` | ADMIN | Manejo de BC |
| POST | `/ban, /unban` | ADMIN | Banear/desbanear |
| POST | `/matches` | ADMIN | Crear partido manual |
| POST | `/matches/resolve` | ADMIN | Resolver partido manual |
| DELETE | `/matches/:id` | ADMIN | Eliminar partido |
| POST | `/sports/import` | ADMIN | Importar desde TheSportsDB |
| POST | `/sports/sync-now` | ADMIN | **NUEVO**: import + live + recompute en bg |

### 4.11 User (`/api/user`)
| Method | Path | Auth | Descripción |
|---|---|---|---|
| GET | `/profile` | JWT | Perfil del usuario |
| GET | `/stats` | JWT | Stats personales |

### 4.12 Notifications (`/api/notifications`)
| Method | Path | Auth | Descripción |
|---|---|---|---|
| GET | `/` | JWT | Últimas 30 notificaciones (in-app, no push) |
| POST | `/read-all` | JWT | Marcar todas como leídas |

---

## 5. Schema de base de datos

### 5.1 Tablas existentes

- `users` — Usuario con username, email, role, avatar emoji, isBanned
- `wallets` — Balance + lockedBalance + total stats por usuario
- `transactions` — Ledger inmutable de movimientos
- `friendships` — Relaciones de amistad
- `matches` — Partidos deportivos
- `sport_bets` — Apuestas en partidos
- `private_bets` + `private_bet_participants` — Apuestas P2P
- `p2p_invitations` — Invitaciones a P2P
- `game_history` — Historial de juegos casino
- `notifications` — Notificaciones in-app
- `admin_logs` — Audit log de admin
- `coin_schedules` — Recargas programadas

### 5.2 Tablas nuevas (migración `20260616050000_add_chat_and_push`)

```sql
match_messages
  - id, match_id, user_id, message VARCHAR(280), created_at
  - INDEX (match_id, created_at)
  - FK match → CASCADE, FK user → CASCADE

push_subscriptions
  - id, user_id, endpoint UNIQUE, p256dh, auth, user_agent, created_at
  - INDEX (user_id)
  - FK user → CASCADE
```

---

## 6. Tareas programadas (cron)

| Cron | Frecuencia | Qué hace |
|---|---|---|
| `* * * * *` | 1 min | Cierra partidos UPCOMING que ya iniciaron → LIVE; lockea P2P; expira invitaciones |
| `* * * * *` | 1 min | Ejecuta `coinSchedule` programados (recargas) |
| `*/2 * * * *` | 2 min | `updateLiveScores()` — ESPN → lookupevent → fallback 150min |
| `0 */6 * * *` | 6 hs | `importMatchesToDB()` — trae partidos nuevos |
| `30 */6 * * *` | 6 hs | `recomputeUpcomingOdds()` — refresca cuotas |
| `0 3 * * *` | Diario 3am UTC | `cleanupOldMatches(7)` — elimina FINISHED >7 días |
| `*/5 * * * *` | 5 min | Push recordatorio "tu partido empieza en 15 min" |

Importación inicial: 30s después del boot.

---

## 7. Variables de entorno requeridas

### 7.1 Backend (Render)

| Variable | Requerida | Validación | Ejemplo |
|---|---|---|---|
| `DATABASE_URL` | ✅ | Conexión Postgres válida | `postgresql://...:6543/postgres?pgbouncer=true` |
| `DIRECT_URL` | ✅ | Para Prisma migrations | `postgresql://...:5432/postgres` |
| `JWT_SECRET` | ✅ | **≥ 32 chars, no genérico** | Generado con `crypto.randomBytes(64).toString('hex')` |
| `JWT_EXPIRES_IN` | opcional | default `7d` | `7d` |
| `PORT` | opcional | default `3000` | `3000` |
| `NODE_ENV` | ✅ | `production` en Render | `production` |
| `FRONTEND_URL` | ✅ | URL del frontend para CORS | `https://virtualbet-vert.vercel.app` |
| `WELCOME_BONUS` | opcional | default `1000` | `1000` |
| `HOUSE_EDGE` | opcional | default `0.05` | `0.05` |
| `ADMIN_USERNAME` | ✅ | Para seed inicial | `admin` |
| `ADMIN_EMAIL` | ✅ | Para seed inicial | `admin@virtualbet.com` |
| `ADMIN_PASSWORD` | ✅ | **No puede contener "cambiaesto"** | Tu password fuerte |
| `VAPID_PUBLIC_KEY` | opcional* | Para push notifications | Generada con `scripts/generate-vapid.js` |
| `VAPID_PRIVATE_KEY` | opcional* | idem | idem |
| `VAPID_SUBJECT` | opcional* | `mailto:` o URL | `https://virtualbet-vert.vercel.app` |
| `RATE_LIMIT_MAX` | opcional | default `200` (req/15min) | `200` |
| `RATE_LIMIT_LOGIN_MAX` | opcional | default `10` (req/15min) | `10` |
| `SPORTS_API_BASE` | opcional | default thesportsdb | URL alternativa |

*\* Si están vacías, el resto de la app funciona pero el botón "Activar notificaciones" devuelve 503.*

**Startup checks abortan el server en producción si:**
- `JWT_SECRET` < 32 caracteres
- `JWT_SECRET` es genérico (`secret`, `changeme`, etc.)
- `ADMIN_PASSWORD` contiene "cambiaesto"
- `DATABASE_URL` no está definida

---

## 8. Seguridad implementada

### 8.1 Autenticación y autorización
- **JWT 7 días** en localStorage (mantenido)
- **bcrypt 12 rounds** para passwords
- **Mass assignment defense:** destructuring explícito sin spread
- **Banned users:** rechazados en cada `requireAuth` middleware
- **Admin endpoints:** doble check con `requireAdmin`

### 8.2 Anti brute force
- **Account lockout** (`src/security/loginAttempts.js`):
  - 5 fallos por email → 15 min bloqueado
  - 10 fallos por IP → 30 min bloqueado
  - Login exitoso resetea contadores
  - Ventana de tracking: 15 min
- **Comparación bcrypt constante** (anti timing attack)
- **Mensajes genéricos** ("email o contraseña incorrectos") — no revela si el email existe

### 8.3 Passwords
- **Validación express-validator:** min 8 chars, ≥1 mayúscula, ≥1 número
- **Blacklist** (`src/security/passwordBlacklist.js`): 30+ passwords comunes prohibidas
- Prohibido contener username o email
- Prohibido solo dígitos o 3+ caracteres repetidos
- Max 128 caracteres

### 8.4 Rate limiting (granular por endpoint)
| Endpoint | Limite |
|---|---|
| Global | 200 req / 15 min |
| Login/register | 20 req / 15 min |
| Apuestas deportivas | 30 req / 5 min |
| Chat | 60 msgs / 5 min (+ cooldown 3s in-controller) |
| Push subscribe | 10 req / hora |
| Promo claims | 5 req / hora |
| P2P | 20 req / 10 min |
| Games | 200 req / 5 min |
| Admin | 60 req / 5 min |

### 8.5 Headers HTTP

**Backend (helmet):**
- CSP `default-src 'none'` (API solo devuelve JSON)
- HSTS 2 años con includeSubDomains + preload
- frame-ancestors `'none'`
- Referrer-Policy `no-referrer`
- X-Content-Type-Options `nosniff`
- crossOriginResourcePolicy `same-site`

**Frontend (vercel.json):**
- CSP con `connect-src` restringido al backend
- HSTS 2 años
- Permissions-Policy: geolocation/microphone/camera/payment = ()
- Service-Worker-Allowed `/` para sw.js

### 8.6 CORS
- Allowlist explícita: `FRONTEND_URL` env var + localhost en dev
- Bloquea con error 403 cualquier origin no listado

### 8.7 Input validation
- **express-validator** en todas las rutas críticas
- **XSS sanitization** en chat (librería `xss` + escape en frontend)
- **Length limits** en cada campo string
- **Payload size limit** 10kb

### 8.8 Error handling
- 5xx en producción → mensaje genérico ("Error interno del servidor")
- Stack traces nunca se envían al cliente
- Logs en server incluyen method + path + mensaje (no payloads sensibles)
- Errores específicos: `entity.too.large`, `entity.parse.failed`, CORS

### 8.9 Data integrity
- **Transacciones atómicas** en operaciones críticas (placeBet, claim daily, p2p)
- **Re-check de saldo** dentro de cada tx para evitar race conditions
- **Atomic balance updates** vía Prisma `increment`/`decrement`

### 8.10 Audit logging
- Toda acción admin queda en `admin_logs` con IP, payload y target user
- Login attempts fallidos van a console.warn

---

## 9. Cómo correr localmente

```bash
# Backend
cd backend
cp .env.example .env       # configurar variables
npm install
npx prisma migrate dev
npx prisma generate
node prisma/seed.js        # crea el admin
npm run dev                # → http://localhost:3000

# Frontend
cd frontend
npx serve .                # → http://localhost:5500
# o usar Live Server de VS Code
```

### Generar VAPID keys (una sola vez)
```bash
cd backend
node scripts/generate-vapid.js
# Copiar las 3 vars a Render → Environment
```

### Generar JWT_SECRET fuerte
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## 10. Deploy

### Render (backend)
- **Root directory:** `backend`
- **Build:** `npm install && npx prisma generate && npx prisma migrate deploy`
- **Start:** `npm start`
- **Plan:** Free
- **UptimeRobot:** pinguea `/health` cada 5 min para evitar sleep

### Vercel (frontend)
- **Framework preset:** Other
- **Root directory:** `frontend` (definido en `vercel.json`)
- Headers de seguridad configurados en `vercel.json`

### Supabase (DB)
- Connection pooler (puerto 6543) → `DATABASE_URL`
- Direct connection (puerto 5432) → `DIRECT_URL` (Prisma migrations)

---

## 11. Funcionalidades del usuario

### 11.1 Login bonus
- Aparece en sports.html si el usuario aún no reclamó hoy
- Botón "🎁 Reclamar ahora" → suma BC + sigue racha

### 11.2 Sportsbook
- Tabs por liga + tab Todas
- Mundial siempre primero, ligas con LIVE segundo, resto después
- Match cards muestran badges: ⭐ MUNDIAL / EN VIVO / FINAL / AUTO
- Apuesta simple: HOME / DRAW / AWAY con modal de cantidad
- Auto-refresh cada 30s

### 11.3 Chat en vivo
- Botón "💬 Chat" en cualquier match-card
- Modal con scroll, input de 280 chars
- Polling cada 5s para mensajes nuevos
- Admins se muestran con 👑 en color dorado

### 11.4 Compartir apuesta
- Botón "📤 Compartir" en cada item del historial
- Genera PNG 1080×1080 con marca, partido, selección, cuota, ganancia
- Mobile: Web Share API (WhatsApp, Telegram, etc.)
- Desktop: descarga PNG + abre wa.me con texto

### 11.5 Push notifications
- Banner azul "🔔 Activá notificaciones" arriba de sports.html
- Click → permiso navegador → push de prueba inmediato
- Triggers automáticos:
  - Apuesta deportiva ganada → "🎉 ¡Ganaste! +XXX BC"
  - 15 min antes de partido apostado → "⚽ ¡Tu partido empieza en 15 minutos!"

### 11.6 Leaderboard
- Top 20 ganadores de la semana (por profit neto)
- Tabs: Todos / 🏆 Mundial (filtra apuestas de FIFA_WORLD_CUP)
- Medallas 🥇🥈🥉 para top 3

---

## 12. Panel admin

Sección "Partidos":
- **🔄 Sincronizar YA** — corre import + updateLive + recomputeOdds en background, tabla se autorefresca cada 15s por 90s
- **📥 Importar partidos** — solo importMatchesToDB
- **+ Crear partido** — manual con cuotas y fecha
- **Resolver partido** — manual cuando el auto-resolve no funcionó
- **Eliminar partido** — solo UPCOMING o FINISHED sin apuestas activas

Sección "Usuarios":
- Búsqueda paginada
- Dar BC / Quitar BC / Banear / Desbanear

Sección "Logs":
- Audit log de toda acción admin con IP, payload, target

---

## 13. Tareas manuales pendientes

| Tarea | Cómo | Bloquea |
|---|---|---|
| Verificar `JWT_SECRET` en Render | Si server no arranca, generar uno nuevo de ≥32 chars | Server boot |
| Verificar `ADMIN_PASSWORD` no contenga "cambiaesto" | Cambiar en Render → Environment | Server boot |
| ✅ VAPID keys generadas y guardadas en Render | Confirmado | Push notifications |
| Actualizar `VAPID_SUBJECT` con dominio correcto | `https://virtualbet-vert.vercel.app` | No bloqueante |
| Cada usuario activa sus propias notifs | Click en banner azul en sports.html | Push individual |

---

## 14. Cambios principales en esta sesión (2026-06-15/16)

### Sportsbook (resolver bug crítico)
- ✅ ESPN scoreboard como fuente primaria de live scores
- ✅ Fallback TheSportsDB `lookupevent.php` (free tier compatible)
- ✅ Fallback por tiempo: 150 min → auto-resolución
- ✅ Cleanup automático de partidos FINISHED >7 días
- ✅ Calculadora de cuotas dinámicas por forma reciente
- ✅ Recompute de odds cada 6h para UPCOMING

### Admin
- ✅ Endpoint `POST /api/admin/sports/sync-now` (background)
- ✅ Botón "🔄 Sincronizar YA" en admin.html

### Engagement (Mundial 2026)
- ✅ Banner Mundial gradient en sports.html (auto-show durante evento)
- ✅ Bono diario por racha con x2 durante Mundial
- ✅ Leaderboard semanal con filtro Mundial
- ✅ Sección Mundial pinned al top + badges ⭐
- ✅ Auto-refresh sports.html cada 30s

### Social
- ✅ Chat por partido con polling
- ✅ Web Push notifications (VAPID)
- ✅ Service worker `/sw.js`
- ✅ Compartir apuesta con canvas + Web Share API

### Seguridad
- ✅ Account lockout 5/email + 10/IP
- ✅ Password blacklist (30+ comunes)
- ✅ Rate limiters por endpoint
- ✅ Helmet con CSP estricta + HSTS 2 años
- ✅ Vercel CSP + Permissions-Policy
- ✅ Startup validation (aborta en prod si config insegura)
- ✅ Error sanitization (no stack traces a clientes)
- ✅ Mass assignment defense en register

### Schema
- ✅ Migración `20260616050000_add_chat_and_push`
- ✅ Nuevos modelos: `MatchMessage`, `PushSubscription`

### Commits relevantes
- `feat(sports): ESPN live scores + dynamic odds + auto cleanup`
- `feat(promo): Mundial banner, daily bonus, leaderboard + admin sync-now`
- `feat(social+security): chat, push, share + hardening completo`
- `docs(vapid): clarificar que VAPID_SUBJECT no recibe emails`
- `fix(share): corregir dominio a virtualbet-vert.vercel.app`

---

## 15. Roadmap propuesto (no implementado)

Ordenado por impacto en growth/retención:

1. **Sistema de referidos** — código único por user, +500 BC para invitador e invitado (x2 durante Mundial). Motor #1 de growth.
2. **Bracket Mundial** — predicción de knockout stage, pool repartido por aciertos. Muy viral.
3. **Apuesta combinada (parlay)** — multiplica cuotas de 2-3 partidos. Alta adicción.
4. **Misiones diarias** — "Apostá en 3 partidos hoy → +200 BC". Aumenta sesiones/día.
5. **Odds boost destacados** — admin marca partidos con cuota inflada manual. FOMO.
6. **2FA opcional** — TOTP con QR (otplib + qrcode). Seguridad premium.
7. **Refresh tokens rotativos** — sesiones más largas sin riesgo de token leak.
8. **Auditoría IDOR completa** — review endpoint por endpoint que cada GET respeta ownership.

---

## 16. Operación y monitoreo

### Logs importantes en Render
```
✅ Security startup checks OK
✅ Web Push habilitado
✅ PostgreSQL conectado (Supabase)
✅ Cron scheduler iniciado
[IMPORTER] live: X actualizados, Y resueltos
[IMPORTER] Resumen: +N importados, M ya existían
[SECURITY] Email lockout: ... hasta ...
[SECURITY] IP lockout: ... hasta ...
[CRON] Limpieza: N partidos eliminados
```

### Comandos útiles
```bash
# Ver tablas vivas
cd backend && npx prisma studio

# Reset completo (¡BORRA TODO!)
npx prisma migrate reset

# Nueva migración
npx prisma migrate dev --name nombre

# Forzar sync desde admin panel
# → admin.html → Partidos → 🔄 Sincronizar YA
```

### Healthcheck
- `GET /health` → `{ status: "ok", service: "VirtualBet API", currency: "BetCoins (BC)", timestamp }`
- UptimeRobot pinguea cada 5 min para mantener el server despierto

---

## 17. Limitaciones conocidas

1. **iOS Safari:** push notifications solo funcionan si la web está agregada a la home screen (iOS 16.4+). No es limitación nuestra.
2. **Liga FPD Costa Rica:** cobertura limitada en ESPN, depende más de TheSportsDB. Si falla, fallback de 150 min cubre.
3. **Partidos creados manualmente desde admin:** sin `externalId` → no reciben scores de ESPN. El fallback de tiempo los cierra con marcador actual o 0-0.
4. **Free tier Render duerme tras 15 min sin requests:** mitigado con UptimeRobot.
5. **In-memory stores (lockout, chat cooldown):** se pierden al redeploy. Aceptable en 1 instancia. Si escalamos a múltiples instancias, migrar a Redis.
6. **TheSportsDB API:** sin garantía de uptime, sin SLA. Por eso ESPN es primario.

---

## 18. Contacto y ownership

- Repo GitHub: https://github.com/DavidUrena06/virtualbet
- Owner: David Ureña

---

*Esta documentación refleja el estado al 2026-06-16. Para cambios futuros, actualizar este archivo en el mismo commit.*
