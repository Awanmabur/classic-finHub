const body = document.body;
const cursor = document.querySelector('.cursor-glow');
const menuBtn = document.getElementById('menuBtn');
const mobilePanel = document.getElementById('mobilePanel');
const themeToggle = document.getElementById('themeToggle');
const themeToggleMobile = document.getElementById('themeToggleMobile');
const year = document.getElementById('year');

if (year) year.textContent = new Date().getFullYear();

function setThemeIcon() {
  const dark = body.classList.contains('dark');
  [themeToggle, themeToggleMobile].forEach((btn) => {
    if (!btn) return;
    const icon = btn.querySelector('i');
    if (icon) icon.className = dark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
  });
}

function toggleTheme() {
  body.classList.toggle('dark');
  try { localStorage.setItem('classicFinHubTheme', body.classList.contains('dark') ? 'dark' : 'light'); } catch (_) { /* Storage may be disabled; the current page still works. */ }
  setThemeIcon();
}

try { if (localStorage.getItem('classicFinHubTheme') === 'dark') body.classList.add('dark'); } catch (_) { /* Use the default theme when storage is unavailable. */ }
setThemeIcon();

themeToggle?.addEventListener('click', toggleTheme);
themeToggleMobile?.addEventListener('click', toggleTheme);

function setMobileMenu(open) {
  mobilePanel?.classList.toggle('open', open);
  menuBtn?.setAttribute('aria-expanded', String(open));
  menuBtn?.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}
menuBtn?.setAttribute('aria-controls', 'mobilePanel');
setMobileMenu(false);
menuBtn?.addEventListener('click', () => setMobileMenu(!mobilePanel?.classList.contains('open')));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && mobilePanel?.classList.contains('open')) { setMobileMenu(false); menuBtn?.focus(); }
});

mobilePanel?.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => setMobileMenu(false));
});

document.querySelectorAll('.faq-item').forEach((item) => {
  item.setAttribute('aria-expanded', String(item.classList.contains('open')));
  item.addEventListener('click', () => {
    document.querySelectorAll('.faq-item').forEach((other) => {
      if (other !== item) { other.classList.remove('open'); other.setAttribute('aria-expanded', 'false'); }
    });
    item.classList.toggle('open');
    item.setAttribute('aria-expanded', String(item.classList.contains('open')));
  });
});

const revealObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('show');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.14 }) : null;

document.querySelectorAll('.reveal').forEach((el) => { if(revealObserver) revealObserver.observe(el); else el.classList.add('show'); });

const sections = [...document.querySelectorAll('section[id]')];
const railLinks = [...document.querySelectorAll('.side-rail nav a[href^="#"]')];
const activeObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    railLinks.forEach((link) => {
      link.classList.toggle('active', link.getAttribute('href') === `#${entry.target.id}`);
    });
  });
}, { rootMargin: '-35% 0px -55% 0px' }) : null;
sections.forEach((section) => activeObserver?.observe(section));

window.addEventListener('mousemove', (event) => {
  if (!cursor) return;
  cursor.style.left = `${event.clientX}px`;
  cursor.style.top = `${event.clientY}px`;
});

// Clean scroll progress + smoother section motion
const progressBar = document.createElement('div');
progressBar.className = 'scroll-progress';
document.body.appendChild(progressBar);

function updateScrollProgress() {
  const total = document.documentElement.scrollHeight - window.innerHeight;
  const percent = total > 0 ? (window.scrollY / total) * 100 : 0;
  progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
}

updateScrollProgress();
window.addEventListener('scroll', updateScrollProgress, { passive: true });

document.querySelectorAll('.service-tile, .step, .person, .review-stack blockquote, .contact-grid a').forEach((el, index) => {
  el.style.transitionDelay = `${Math.min(index * 35, 180)}ms`;
});

// Mark the correct top-nav item on inner pages so pages do not show the wrong active state.
const currentFile = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
document.querySelectorAll('.legal-nav-links a').forEach((link) => {
  const href = (link.getAttribute('href') || '').split('#')[0].toLowerCase();
  if (!href) return;
  link.classList.toggle('active', href === currentFile);
});
