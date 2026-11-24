'use strict';

for (const plot of document.querySelectorAll('[data-analytics-plot]')) {
  const days = Array.from(plot.querySelectorAll('[data-analytics-day]'));
  const detail = plot.querySelector('[data-analytics-day-detail]');
  let selected = days.find(day => day.getAttribute('aria-pressed') === 'true');
  if (!selected || !detail) continue;

  const fields = {
    currentDate: detail.querySelector('[data-current-date-text]'),
    currentCount: detail.querySelector('[data-current-count-text]'),
    previousDate: detail.querySelector('[data-previous-date-text]'),
    previousCount: detail.querySelector('[data-previous-count-text]')
  };

  function select(button) {
    selected.setAttribute('aria-pressed', 'false');
    selected.tabIndex = -1;
    selected = button;
    selected.setAttribute('aria-pressed', 'true');
    selected.tabIndex = 0;
    for (const [key, target] of Object.entries(fields)) {
      target.textContent = selected.dataset[key];
    }
  }

  for (const day of days) {
    day.tabIndex = day === selected ? 0 : -1;
    day.addEventListener('click', () => {
      select(day);
      day.focus({preventScroll: true});
    });
    day.addEventListener('keydown', event => {
      const index = days.indexOf(day);
      const next = {
        ArrowLeft: Math.max(0, index - 1),
        ArrowRight: Math.min(days.length - 1, index + 1),
        Home: 0,
        End: days.length - 1
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(days[next]);
      selected.focus({preventScroll: true});
    });
  }
}
