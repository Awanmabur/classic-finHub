(() => {
  const track = document.getElementById('businessCardsTrack');
  if (!track) return;
  const buttons = Array.from(document.querySelectorAll('[data-business-scroll]'));
  const update = () => {
    const max = Math.max(0, track.scrollWidth - track.clientWidth);
    for (const button of buttons) {
      const dir = Number(button.dataset.businessScroll);
      button.disabled = max < 2 || (dir < 0 ? track.scrollLeft <= 2 : track.scrollLeft >= max - 2);
    }
  };
  buttons.forEach(button => button.addEventListener('click', () => {
    const card = track.querySelector('.businessCard');
    const step = card ? card.getBoundingClientRect().width + 12 : track.clientWidth * 0.8;
    track.scrollBy({ left: Number(button.dataset.businessScroll) * step, behavior: 'smooth' });
  }));
  track.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
})();
