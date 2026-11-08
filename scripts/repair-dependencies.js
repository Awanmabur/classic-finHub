'use strict';
// Restore the reviewed lockfile; repairs must not silently upgrade packages or
// reintroduce dependencies removed from the application.
const {spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
function invoke(args){const npmCli=process.env.npm_execpath,exe=npmCli?process.execPath:process.platform==='win32'?'npm.cmd':'npm',argv=npmCli?[npmCli,...args]:args;const result=spawnSync(exe,argv,{cwd:root,stdio:'inherit',windowsHide:true,shell:!npmCli&&process.platform==='win32'});if(result.error)throw result.error;return result;}
function main({directory=root,run=invoke,log=console.log}={}){
 const files=['package.json','package-lock.json'].map(name=>path.join(directory,name));if(files.some(file=>!fs.existsSync(file)))throw Error('Both package.json and the reviewed package-lock.json are required');
 const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),before=files.map(hash);
 log('Restoring dependencies from the reviewed lockfile. Package versions will not be upgraded.');
 const installed=run(['ci','--ignore-scripts','--strict-ssl=true','--no-fund']);if(installed.status!==0)throw Error('Dependency installation failed. Check the registry/network output and retry before restarting the application.');
 if(files.some((file,index)=>hash(file)!==before[index]))throw Error('Package files changed unexpectedly. Review them before continuing.');
 log('Checking the installed dependency security advisories.');const audit=run(['audit','--audit-level=moderate']);if(audit.status!==0)throw Error('Dependency audit did not pass. Review npm audit; do not apply unreviewed forced upgrades.');
 log('Dependencies restored without changing the package files. Restart the application.');return 0;
}
if(require.main===module)try{process.exitCode=main();}catch(error){console.error('Dependency repair:',error.message);process.exitCode=1;}
module.exports={main};
