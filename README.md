# VirtualBet

**Plataforma full-stack de casino virtual y apuestas deportivas con moneda ficticia.**

> ⚠️ **Proyecto demo.** Funciona solo con moneda virtual: no acepta ni paga dinero real.

Proyecto personal de [David Ureña](https://david.norastudio.digital) para practicar
arquitectura full-stack de punta a punta: autenticación, lógica de juego en el servidor,
datos en tiempo real, seguridad y despliegue.

---

## Qué incluye

**Juegos** — Crash · Mines · Blackjack · Keno · Plinko · CoinFlip · Dice
Toda la lógica y los resultados se calculan en el servidor; el navegador solo muestra.

**Apuestas deportivas** — partidos y ligas reales importados de TheSportsDB,
cuotas calculadas por el sistema y apuestas que se resuelven y pagan solas cuando termina el partido.

**Social y P2P** — apuestas entre usuarios con invitaciones, chat y notificaciones push.

**Seguridad** — contraseñas con bcrypt, JWT, límites de peticiones, Helmet,
validación de entradas y verificación de configuración al arrancar.

## Stack

| Capa | Tecnología |
|---|---|
| Backend | Node.js · Express |
| Datos | PostgreSQL (Supabase) · Prisma ORM |
| Frontend | HTML · CSS · JavaScript (sin frameworks) |
| Despliegue | Render (API) · Vercel (frontend) |

## Correr el proyecto

Las instrucciones completas de instalación y despliegue están en
[`docs/INSTALACION.md`](docs/INSTALACION.md).

```bash
cd backend
npm install
cp .env.example .env     # completar con tus propios datos
npm run migrate
npm run seed             # requiere ADMIN_PASSWORD propia en .env
npm run dev
```

---

Hecho por **David Ureña** · [Portafolio](https://david.norastudio.digital) · [LinkedIn](https://www.linkedin.com/in/davure) · [NoraStudio](https://norastudio.digital)
