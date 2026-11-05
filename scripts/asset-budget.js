#!/usr/bin/env node
'use strict';
const fs=require('fs');const path=require('path');
const root=path.resolve(__dirname,'..');
const budgets = {'public/images/bg.webp':250000,'public/images/prt.webp':350000,'public/images/fx.webp':75000};
for(const [name,limit] of Object.entries(budgets)){
  const size=fs.statSync(path.join(root,name)).size;
  if(size>limit)throw new Error(`${name} exceeds ${limit} bytes (${size})`);
  console.log(`${name}: ${size} bytes / budget ${limit}`);
}
const html=fs.readFileSync(path.join(root,'src/views/original/home.ejs'),'utf8');
for(const old of ['bg.jpg','prt.jpg','fx.jpg'])if(html.includes('/images/'+old))throw new Error('Unoptimized hero image referenced: '+old);
console.log('Marketing image budgets: PASS');
