
function flash(req, type, message) {
  req.session.flash = { type, message };
}

function consumeFlash(req) {
  const value = req.session.flash;
  delete req.session.flash;
  return value;
}

function money(currency, amount) {
  return `${currency || 'UGX'} ${Number(amount || 0).toLocaleString()}`;
}

function formatUtcDate(value, fallback = 'Unknown date') {
  // Missing legacy timestamps must not become the Unix epoch or break a page.
  if (!(value instanceof Date) && typeof value !== 'number' && typeof value !== 'string') return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

module.exports = { flash, consumeFlash, money, formatUtcDate };
