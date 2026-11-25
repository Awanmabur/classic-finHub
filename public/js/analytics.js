'use strict';

function drawTrend(canvas, days, selected, limit) {
  const context = canvas.getContext('2d');
  const {width, height} = canvas.getBoundingClientRect();
  if (!context || width <= 0 || height <= 14) return;
  const density = Math.min(window.devicePixelRatio || 1, 3);
  const targetWidth = Math.round(width * density);
  const targetHeight = Math.round(height * density);
  if (canvas.width !== targetWidth) canvas.width = targetWidth;
  if (canvas.height !== targetHeight) canvas.height = targetHeight;
  context.setTransform(density, 0, 0, density, 0, 0);
  context.clearRect(0, 0, width, height);
  context.lineJoin = context.lineCap = 'round';

  const styles = getComputedStyle(canvas);
  const currentColor = styles.getPropertyValue('--chart-current').trim();
  const previousColor = styles.getPropertyValue('--chart-previous').trim();
  const bottom = height - 7;
  const series = key => days.map((day, index) => ({
    x: (index + .5) * width / days.length,
    y: bottom - Number(day.dataset[key]) / limit * (bottom - 7)
  }));
  const current = series('current');
  const prior = series('previous');
  function trace(points) {
    const [start, ...rest] = points;
    context.beginPath();
    context.moveTo(start.x, start.y);
    for (const point of rest) context.lineTo(point.x, point.y);
  }
  trace(current);
  context.lineTo(current.at(-1).x, bottom);
  context.lineTo(current[0].x, bottom);
  context.closePath();
  const fill = context.createLinearGradient(0, 7, 0, bottom);
  fill.addColorStop(0, currentColor);
  fill.addColorStop(1, 'transparent');
  context.globalAlpha = .24;
  context.fillStyle = fill;
  context.fill();
  context.globalAlpha = 1;

  const index = days.indexOf(selected);
  const x = current[index].x;
  context.setLineDash([3, 4]);
  context.lineWidth = 1;
  context.strokeStyle = previousColor;
  trace([{x, y:7}, {x, y:bottom}]);
  context.stroke();

  context.setLineDash([5, 5]);
  context.lineWidth = 2;
  trace(prior);
  context.stroke();
  context.setLineDash([]);
  context.lineWidth = 2.5;
  context.strokeStyle = currentColor;
  trace(current);
  context.stroke();

  context.fillStyle = previousColor;
  context.fillRect(x - 5, prior[index].y - 5, 10, 10);
  context.beginPath();
  context.arc(x, current[index].y, 4, 0, Math.PI * 2);
  context.fillStyle = currentColor;
  context.fill();
  // Keep both values visible when the two periods have the same count.
  context.lineWidth = 1.4;
  context.strokeStyle = styles.color;
  context.stroke();
}

for (const plot of document.querySelectorAll('[data-analytics-plot]')) {
  const days = Array.from(plot.querySelectorAll('[data-analytics-day]'));
  const detail = plot.querySelector('[data-analytics-day-detail]');
  const canvas = plot.querySelector('[data-analytics-trend-line]');
  const controls = plot.querySelector('[data-analytics-controls]');
  const limit = Number(plot.dataset.axisLimit);
  let selected = days.find(day => day.getAttribute('aria-pressed') === 'true');
  if (!selected || !detail || !canvas || !controls || !(limit > 0)) continue;

  const fields = {
    currentDate: detail.querySelector('[data-current-date-text]'),
    currentCount: detail.querySelector('[data-current-count-text]'),
    previousDate: detail.querySelector('[data-previous-date-text]'),
    previousCount: detail.querySelector('[data-previous-count-text]')
  };

  const previous = controls.querySelector('[data-analytics-step="-1"]');
  const next = controls.querySelector('[data-analytics-step="1"]');
  const draw = () => drawTrend(canvas, days, selected, limit);
  function updateControls() {
    previous.setAttribute('aria-disabled', selected === days[0]);
    next.setAttribute('aria-disabled', selected === days.at(-1));
  }
  function select(button) {
    selected.setAttribute('aria-pressed', 'false');
    selected.tabIndex = -1;
    selected = button;
    selected.setAttribute('aria-pressed', 'true');
    selected.tabIndex = 0;
    for (const [key, target] of Object.entries(fields)) {
      target.textContent = selected.dataset[key];
    }
    updateControls();
    draw();
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
  for (const step of [previous, next]) {
    step.addEventListener('click', () => {
      if (step.getAttribute('aria-disabled') === 'true') return;
      select(days[days.indexOf(selected) + Number(step.dataset.analyticsStep)]);
    });
  }
  updateControls();
  controls.hidden = false;
  if (typeof ResizeObserver === 'function') new ResizeObserver(draw).observe(canvas);
  else window.addEventListener('resize', draw);
  draw();
}
