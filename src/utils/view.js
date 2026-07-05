const { tenants } = require('../data/store');

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

function currentTenant() {
  return tenants[0];
}

module.exports = { flash, consumeFlash, money, currentTenant };
