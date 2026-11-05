const unavailable = require('../../utils/unavailableOperation');
module.exports = {
  list: () => unavailable('role list'),
  create: () => unavailable('role create'),
  update: () => unavailable('role update')
};
