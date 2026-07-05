module.exports = {
  list: () => [],
  create: (payload = {}) => ({ id: 'cashDrawer_' + Date.now(), ...payload, createdAt: new Date().toISOString() }),
  update: (id, payload = {}) => ({ id, ...payload, updatedAt: new Date().toISOString() })
};
