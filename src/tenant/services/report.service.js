const unavailable = require('../../utils/unavailableOperation');
module.exports = {
  list: () => unavailable('report list'),
  create: () => unavailable('report create'),
  update: () => unavailable('report update')
};
