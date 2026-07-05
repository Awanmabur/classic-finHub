module.exports = {
  list: () => [],
  create: (payload = {}) => ({ id: 'notification_' + Date.now(), ...payload, createdAt: new Date().toISOString() }),
  update: (id, payload = {}) => ({ id, ...payload, updatedAt: new Date().toISOString() })
};
