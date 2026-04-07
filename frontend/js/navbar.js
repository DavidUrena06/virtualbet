// frontend/js/navbar.js
// Navbar universal con hamburguesa y menú móvil
// Incluir DESPUÉS de api.js en cada página

(function () {
  // ── Detecta página actual para marcar link activo ─────────────────────
  const path = window.location.pathname;
  const isActive = (href) => path.includes(href);

  const user = Auth.getUser();
  const isAdmin = user?.role === 'ADMIN';

  // ── Links de navegación ───────────────────────────────────────────────
  const navLinks = [
    { href: 'dashboard.html',  label: '🎰 Casino',    icon: '🎰' },
    { href: 'sports.html',     label: '⚽ Deportes',  icon: '⚽' },
    { href: 'p2p.html',        label: '🤝 P2P',       icon: '🤝' },
    { href: 'friends.html',    label: '👥 Amigos',    icon: '👥' },
    { href: 'history.html',    label: '📋 Historial', icon: '📋' },
    { href: 'profile.html',    label: '👤 Perfil',    icon: '👤' },
    ...(isAdmin ? [{ href: 'admin.html', label: '⚙️ Admin', icon: '⚙️' }] : []),
  ];

  // ── Inyecta navbar en el DOM ──────────────────────────────────────────
  function buildNavbar() {
    const existing = document.querySelector('.navbar');
    if (!existing) return;

    // Agrega sección de links al navbar existente
    const nav = document.querySelector('.navbar__nav');
    if (nav) {
      nav.innerHTML = navLinks.map(l => `
        <a href="${l.href}" class="navbar__link ${isActive(l.href) ? 'active' : ''}">
          ${l.label}
        </a>
      `).join('');
    }

    // Agrega hamburguesa si no existe
    if (!document.querySelector('.navbar__hamburger')) {
      const hamburger = document.createElement('button');
      hamburger.className = 'navbar__hamburger';
      hamburger.setAttribute('aria-label', 'Menú');
      hamburger.innerHTML = '<span></span><span></span><span></span>';
      hamburger.onclick = toggleMenu;
      existing.appendChild(hamburger);
    }

    // Crea el menú móvil overlay
    if (!document.querySelector('.mobile-menu')) {
      const menu = document.createElement('div');
      menu.className = 'mobile-menu';
      menu.id = 'mobileMenu';

      // Balance en el menú
      menu.innerHTML = `
        <div class="mobile-menu__balance">
          <div>
            <div style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Balance</div>
            <div style="font-size:1.2rem;font-weight:800;color:var(--green-neon);" id="mobileBalance">— BC</div>
          </div>
          <div style="font-size:0.82rem;color:var(--text-secondary);">${user?.username || ''}</div>
        </div>
        ${navLinks.map(l => `
          <a href="${l.href}" class="mobile-menu__link ${isActive(l.href) ? 'active' : ''}">
            <span class="icon">${l.icon}</span>
            ${l.label.replace(/^[^\s]+\s/, '')}
          </a>
        `).join('')}
        <div class="mobile-menu__divider"></div>
        <button class="mobile-menu__link" onclick="logout()" style="color:var(--red-accent);">
          <span class="icon">🚪</span> Cerrar sesión
        </button>
      `;

      document.body.appendChild(menu);
    }
  }

  // ── Toggle del menú ───────────────────────────────────────────────────
  function toggleMenu() {
    const menu = document.getElementById('mobileMenu');
    const burger = document.querySelector('.navbar__hamburger');
    const isOpen = menu.classList.contains('open');

    menu.classList.toggle('open', !isOpen);
    burger.classList.toggle('open', !isOpen);
    document.body.style.overflow = isOpen ? '' : 'hidden';
  }

  // Cierra menú al hacer click en cualquier link del menú
  document.addEventListener('click', (e) => {
    const menu   = document.getElementById('mobileMenu');
    const burger = document.querySelector('.navbar__hamburger');
    if (!menu) return;

    if (e.target.closest('.mobile-menu__link') && !e.target.closest('button[onclick="logout()"]')) {
      menu.classList.remove('open');
      burger?.classList.remove('open');
      document.body.style.overflow = '';
    }

    // Cierra al hacer click fuera del menú
    if (menu.classList.contains('open') &&
        !e.target.closest('.mobile-menu') &&
        !e.target.closest('.navbar__hamburger')) {
      menu.classList.remove('open');
      burger?.classList.remove('open');
      document.body.style.overflow = '';
    }
  });

  // ── Carga balance en navbar y menú móvil ─────────────────────────────
  async function loadNavBalance() {
    try {
      const data = await VB.wallet.balance();
      const bal  = parseFloat(data.wallet.balance) - parseFloat(data.wallet.lockedBalance || 0);
      const fmt  = bal.toLocaleString('es-CR', { minimumFractionDigits: 2 });

      const navBal = document.getElementById('navBalance');
      if (navBal) navBal.textContent = fmt;

      const mobBal = document.getElementById('mobileBalance');
      if (mobBal) mobBal.textContent = fmt + ' BC';
    } catch { /* silencioso */ }
  }

  // ── Logout global ─────────────────────────────────────────────────────
  window.logout = function () {
    Auth.clear();
    window.location.href = './login.html';
  };

  // ── Init ─────────────────────────────────────────────────────────────
  buildNavbar();
  loadNavBalance();
})();