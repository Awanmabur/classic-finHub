#!/usr/bin/env node
'use strict';
// Targeted prevention for the credential-shaped Atlas examples that triggered
// GitHub alerts. GitHub secret scanning remains necessary for other secret types.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
function scanText(source){
 const findings=[];
 const pattern=/mongodb(?:\+srv)?:\/\/[^\s/@<>"'`]+:[^\s@<>"'`]+@[^\s/<>"'`?]*\.mongodb\.net(?=[:/?\s"'`<>]|$)/gi;
 for(const [index,line] of String(source).split(/\r?\n/).entries()){
  pattern.lastIndex=0;
  if(pattern.test(line))findings.push({line:index+1,kind:'credential-shaped-atlas-uri'});
 }
 return findings;
}
function checkRepository(root){
 const names=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024}).split('\0');
 const findings=[];let checked=0;
 for(const name of new Set(names.filter(Boolean))){
  const file=path.resolve(root,name);
  if(!file.startsWith(path.resolve(root)+path.sep))continue;
  let data;try{if(!fs.lstatSync(file).isFile())continue;data=fs.readFileSync(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(data.includes(0))continue;
  checked++;
  for(const finding of scanText(data.toString('utf8')))findings.push({file:name,...finding});
 }
 return {checked,findings};
}
function main(){
 const result=checkRepository(path.resolve(__dirname,'..'));
 if(result.findings.length){
  for(const finding of result.findings)console.error(`${finding.file}:${finding.line}: credential-shaped Atlas URI; keep connection strings in private configuration.`);
  process.exitCode=1;
 }else console.log(`Credential-shaped Atlas URI check passed for ${result.checked} text files.`);
}
if(require.main===module)main();
module.exports={scanText,checkRepository};
