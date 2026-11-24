'use strict';

document.querySelectorAll('[data-treasury-observation]').forEach(form => {
  const time = form.elements.namedItem('observedAt');
  const preset = time.value;
  let submitted = false;
  form.addEventListener('submit', () => {
    // Keep the captured time on a retry with the same request reference.
    if (!submitted && time.value === preset) time.value = new Date().toISOString().slice(0, -1);
    submitted = true;
  });
});

function openLinkedSection() {
  const section = document.getElementById(location.hash.slice(1));
  if (section instanceof HTMLDetailsElement) section.open = true;
  if (location.hash === '#funding-history') {
    const history = document.querySelector('[data-treasury-history-link]');
    if (history) location.replace(history.href);
  }
}
window.addEventListener('hashchange', openLinkedSection);
openLinkedSection();
