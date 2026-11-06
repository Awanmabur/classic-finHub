'use strict';
// The uploaded index.html is the design source. Preserve every style block in
// document order, including the late navy palette and all modal corrections.
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const START='/* BEGIN APPROVED INDEX.HTML CASCADE */';
const END='/* END APPROVED INDEX.HTML CASCADE */';
function approvedCascade(html){
 const blocks=[...html.replace(/\r\n/g,'\n').matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)];
 if(!blocks.length)throw new Error('The approved reference has no style blocks');
 return blocks.map((match,index)=>{
  const id=/\bid=["']([^"']+)["']/.exec(match[1])?.[1]||'initial-dashboard';
  // Relative URLs in inline CSS resolve against the HTML page. The external
  // stylesheet needs the same assets rooted at /images instead of /css/images.
  const css=match[2].replace(/url\((["']?)images\//g,'url($1/images/').replace(/[ \t]+$/gm,'');
  return `/* Approved block ${index+1}: ${id} */\n${css.trim()}\n`;
 }).join('\n');
}
function sync(){
 const file=path.join(root,'public/css/approved-tenant.css');
 const existing=fs.existsSync(file)?fs.readFileSync(file,'utf8'):START+'\n'+END+'\n';
 const start=existing.indexOf(START),end=existing.indexOf(END);
 if(start<0||end<start)throw new Error('Approved stylesheet markers are missing');
 const reference=fs.readFileSync(path.join(root,'index.html'),'utf8');
 const updated=existing.slice(0,start)+START+'\n'+approvedCascade(reference)+'\n'+existing.slice(end);
 fs.writeFileSync(file,updated);
 return updated;
}
if(require.main===module){sync();console.log('Approved tenant stylesheet synchronized from every index.html style block.');}
module.exports={approvedCascade,sync,START,END};
