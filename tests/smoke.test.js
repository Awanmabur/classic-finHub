const fs = require('fs');
const path = require('path');
const required = [
  'src/app.js','src/server.js','src/views/layouts/dashboard.ejs','src/views/platform/marketplace/index.ejs','src/views/tenant/marketplace/index.ejs','src/platform/models/Tenant.js','src/tenant/schemas/MoneyTransfer.schema.js'
];
let ok = true;
for (const file of required) {
  const full = path.join(__dirname, '..', file);
  if (!fs.existsSync(full)) { console.error(`Missing ${file}`); ok = false; }
}
if (!ok) process.exit(1);
console.log('ClassicFin Hub smoke test passed.');
