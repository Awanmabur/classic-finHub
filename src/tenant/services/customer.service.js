const unavailable = require('../../utils/unavailableOperation');
module.exports = {
  list: () => unavailable('customer list'),
  create: () => unavailable('customer create'),
  update: () => unavailable('customer update')
};
