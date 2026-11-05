'use strict';
const fsp=require('node:fs/promises');
const path=require('node:path');
async function loadSecretToken(filename){
  if(!filename||!path.isAbsolute(filename))throw new Error('OPS_ALERT_TOKEN_FILE must be an absolute 0600 token file');
  const stat=await fsp.lstat(filename);
  if(!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)!==0))throw new Error('Operational alert token file must be owner-only and a regular file');
  const token=(await fsp.readFile(filename,'utf8')).trim();
  if(token.length<24||token.length>1024||/[\r\n]/.test(token))throw new Error('Operational alert token is invalid');
  return token;
}
module.exports={loadSecretToken};
