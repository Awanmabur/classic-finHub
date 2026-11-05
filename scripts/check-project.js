const fs=require('fs');const path=require('path');const { spawnSync }=require('child_process');
const ejs=require('ejs');
let count=0;
function scan(root){ for(const d of fs.readdirSync(root,{withFileTypes:true})){
  if(d.isDirectory())scan(path.join(root,d.name));
  else if(d.name.endsWith('.js')){
    const full=path.join(root,d.name);const r=spawnSync(process.execPath,['--check',full],{encoding:'utf8'});
    if(r.status!==0)throw new Error(full+' syntax error: '+r.stderr);count++;
  } else if(d.name.endsWith('.ejs')) { const full=path.join(root,d.name);ejs.compile(fs.readFileSync(full,'utf8'),{filename:full}); count++; }
}}
for(const d of ['src','scripts','tests'])scan(path.join(__dirname,'..',d));
console.log(`Static checks passed for ${count} JS and EJS files`);
