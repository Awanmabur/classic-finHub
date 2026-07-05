const { modules } = require('../../data/store');
function listModules() { return modules; }
function toggleModule(key) { const m = modules.find(x => x.key === key); if (m) m.status = m.status === 'active' ? 'inactive' : 'active'; return m; }
module.exports = { listModules, toggleModule };
