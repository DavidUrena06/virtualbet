// frontend/js/share.js
// Generador de imagen compartible para apuestas + integración con WhatsApp / Web Share API.
//
// Uso:
//   ShareBet.shareBet({
//     teamHome:'Real Madrid', teamAway:'Barcelona',
//     selection:'HOME', amount:100, oddAtBet:2.10,
//     potentialWin:210, status:'WON',
//   });

const ShareBet = (() => {
  const W = 1080, H = 1080; // formato Instagram square

  function drawBg(ctx) {
    // Gradient principal
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#0f0c2c');
    g.addColorStop(0.5, '#1a0f3d');
    g.addColorStop(1, '#2d1655');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Acento dorado/violeta
    const glow = ctx.createRadialGradient(W * 0.85, 200, 0, W * 0.85, 200, 600);
    glow.addColorStop(0, 'rgba(245, 158, 11, 0.35)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    const glow2 = ctx.createRadialGradient(W * 0.15, H - 200, 0, W * 0.15, H - 200, 600);
    glow2.addColorStop(0, 'rgba(124, 58, 237, 0.45)');
    glow2.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow2;
    ctx.fillRect(0, 0, W, H);
  }

  function drawCenteredText(ctx, text, x, y, opts = {}) {
    ctx.font         = opts.font || 'bold 40px sans-serif';
    ctx.fillStyle    = opts.color || '#fff';
    ctx.textAlign    = opts.align || 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  function ellipsize(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '...').width > maxWidth) {
      t = t.slice(0, -1);
    }
    return t + '...';
  }

  // Renderiza la imagen de apuesta y devuelve un Blob PNG
  async function renderImage(bet) {
    const canvas = document.createElement('canvas');
    canvas.width  = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    drawBg(ctx);

    // Logo / brand
    drawCenteredText(ctx, '🎰 VirtualBet', W / 2, 110, {
      font: 'bold 56px sans-serif', color: '#fbbf24',
    });
    drawCenteredText(ctx, 'BetCoins · Apuestas con amigos', W / 2, 165, {
      font: '28px sans-serif', color: 'rgba(255,255,255,0.65)',
    });

    // Status badge
    const status = (bet.status || 'PENDING').toUpperCase();
    const statusMap = {
      WON:      { txt: '✅ APUESTA GANADA',    color: '#22c55e' },
      LOST:     { txt: '❌ APUESTA PERDIDA',   color: '#ef4444' },
      PENDING:  { txt: '⏳ APUESTA EN JUEGO',  color: '#fbbf24' },
      REFUNDED: { txt: '↩ REEMBOLSADA',       color: '#94a3b8' },
    };
    const st = statusMap[status] || statusMap.PENDING;
    ctx.fillStyle = st.color + '33';
    const badgeW = 520, badgeH = 70;
    ctx.beginPath();
    ctx.roundRect((W - badgeW) / 2, 230, badgeW, badgeH, 35);
    ctx.fill();
    ctx.strokeStyle = st.color;
    ctx.lineWidth = 3;
    ctx.stroke();
    drawCenteredText(ctx, st.txt, W / 2, 265, {
      font: 'bold 34px sans-serif', color: st.color,
    });

    // Partido
    const matchY = 410;
    ctx.font = 'bold 60px sans-serif';
    const home = ellipsize(ctx, bet.teamHome || '?', 800);
    const away = ellipsize(ctx, bet.teamAway || '?', 800);
    drawCenteredText(ctx, home, W / 2, matchY, { font: 'bold 60px sans-serif', color: '#fff' });
    drawCenteredText(ctx, 'vs', W / 2, matchY + 75, { font: '34px sans-serif', color: 'rgba(255,255,255,0.5)' });
    drawCenteredText(ctx, away, W / 2, matchY + 145, { font: 'bold 60px sans-serif', color: '#fff' });

    // Card central con selección + cuota
    const cardY = 640, cardH = 200, cardW = 820;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.beginPath();
    ctx.roundRect((W - cardW) / 2, cardY, cardW, cardH, 24);
    ctx.fill();
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const selMap = { HOME: 'Gana Local', DRAW: 'Empate', AWAY: 'Gana Visitante' };
    const selLabel = selMap[bet.selection] || bet.selection || '';
    drawCenteredText(ctx, 'SELECCIÓN', W / 2 - 200, cardY + 55, {
      font: 'bold 24px sans-serif', color: 'rgba(255,255,255,0.5)',
    });
    drawCenteredText(ctx, selLabel, W / 2 - 200, cardY + 105, {
      font: 'bold 42px sans-serif', color: '#a78bfa',
    });

    drawCenteredText(ctx, 'CUOTA', W / 2 + 200, cardY + 55, {
      font: 'bold 24px sans-serif', color: 'rgba(255,255,255,0.5)',
    });
    drawCenteredText(ctx, `${parseFloat(bet.oddAtBet || 0).toFixed(2)}x`, W / 2 + 200, cardY + 105, {
      font: 'bold 60px sans-serif', color: '#fbbf24',
    });

    // Monto apostado / ganado
    const amount = parseFloat(bet.amount || 0).toFixed(2);
    const win    = parseFloat(bet.potentialWin || 0).toFixed(2);

    drawCenteredText(ctx, `Apostó ${amount} BC`, W / 2, cardY + 175, {
      font: '28px sans-serif', color: 'rgba(255,255,255,0.7)',
    });

    // Premio destacado
    const prizeText = status === 'WON' ? `+${win} BC` : `Premio: ${win} BC`;
    const prizeColor = status === 'WON' ? '#22c55e' : '#fbbf24';
    drawCenteredText(ctx, prizeText, W / 2, 920, {
      font: 'bold 90px sans-serif', color: prizeColor,
    });

    // Footer
    drawCenteredText(ctx, '🌐 virtualbet-vert.vercel.app', W / 2, 1020, {
      font: '32px sans-serif', color: 'rgba(255,255,255,0.55)',
    });

    return new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.95));
  }

  function buildWhatsAppText(bet) {
    const status   = (bet.status || 'PENDING').toUpperCase();
    const selMap   = { HOME: bet.teamHome, DRAW: 'Empate', AWAY: bet.teamAway };
    const intro = status === 'WON'
      ? `🎉 ¡Acabo de ganar ${parseFloat(bet.potentialWin).toFixed(2)} BC en VirtualBet!`
      : `⚽ Mi apuesta en VirtualBet:`;
    return `${intro}\n\n${bet.teamHome} vs ${bet.teamAway}\nSelección: ${selMap[bet.selection]}\nCuota: ${parseFloat(bet.oddAtBet).toFixed(2)}x\n\n¿Querés jugar conmigo? 🎰\nhttps://virtualbet-vert.vercel.app`;
  }

  // Punto de entrada — usa Web Share API con archivos si está disponible,
  // sino abre WhatsApp con texto + descarga la imagen como fallback.
  async function shareBet(bet) {
    try {
      const blob = await renderImage(bet);
      const file = new File([blob], `virtualbet-${Date.now()}.png`, { type: 'image/png' });
      const text = buildWhatsAppText(bet);

      // Mejor opción: Web Share API con archivos
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: '🎰 VirtualBet',
          text,
          files: [file],
        });
        return { method: 'webshare' };
      }

      // Fallback: descarga + abre WhatsApp Web
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href     = url;
      a.download = `virtualbet-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      // Abre WhatsApp con el texto
      const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
      window.open(waUrl, '_blank');
      return { method: 'fallback' };
    } catch (err) {
      if (err.name === 'AbortError') return { method: 'cancelled' };
      throw err;
    }
  }

  return { shareBet, renderImage, buildWhatsAppText };
})();
