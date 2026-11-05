const unavailable = require('../../utils/unavailableOperation');
module.exports = {
  list: () => unavailable('expense list'),
  create: () => unavailable('expense create'),
  update: () => unavailable('expense update')
};
