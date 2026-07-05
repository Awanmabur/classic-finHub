
(function(){
  const side = document.getElementById('sidePanel');
  const overlay = document.getElementById('menuOverlay');
  const menuBtn = document.getElementById('menuBtn');
  const closeMenu = () => { side?.classList.remove('show'); overlay?.classList.remove('show'); };
  menuBtn?.addEventListener('click', () => { side?.classList.add('show'); overlay?.classList.add('show'); });
  overlay?.addEventListener('click', closeMenu);

  const search = document.getElementById('search');
  search?.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    document.querySelectorAll('[data-search-row]').forEach((row) => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  document.querySelectorAll('[data-confirm]').forEach((el) => {
    el.addEventListener('click', (event) => {
      if (!confirm(el.getAttribute('data-confirm'))) event.preventDefault();
    });
  });

  const toast = document.querySelector('.toast');
  if (toast) setTimeout(() => toast.remove(), 5200);
})();
