'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Content fingerprint changes after asset deployment, invalidating browser caches.
const root = path.join(__dirname,'..','..','public');
const hash = crypto.createHash('sha256');
function fingerprint(dir) {
  for (const entry of fs.readdirSync(path.join(root,dir), { withFileTypes:true }).sort((a,b)=>a.name.localeCompare(b.name))) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) fingerprint(relative);
    else if (entry.isFile()) {
      hash.update(`${relative}\0`);
      hash.update(fs.readFileSync(path.join(root,relative)));
    }
  }
}
for (const dir of ['css','js','images','vendor']) fingerprint(dir);
module.exports = hash.digest('hex').slice(0,12);
