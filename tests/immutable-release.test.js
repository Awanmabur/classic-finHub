'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const script=path.join(__dirname,'../deploy/release.sh');
const previous='example.org/classicfin@sha256:'+'a'.repeat(64);
const newest='example.org/classicfin@sha256:'+'b'.repeat(64);
const bad='example.org/classicfin@sha256:'+'c'.repeat(64);
async function setup(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cfh-release-test-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const bin=path.join(dir,'bin');await fs.mkdir(bin);
 for(const [name,contents] of Object.entries({
  docker:`#!/usr/bin/env bash\nset -e\nif [[ "$1" == "pull" && "\${FAKE_PULL_FAIL:-}" == "1" ]]; then exit 1; fi\nif [[ "$1" == "compose" ]]; then\n  if [[ " $* " == *" up -d "* ]]; then printf '%s' "$CLASSICFIN_IMAGE" >"$FAKE_ACTIVE"; fi\n  if [[ " $* " == *" exec -T "* && "$CLASSICFIN_IMAGE" == "$FAKE_BAD" ]]; then exit 1; fi\nfi\nexit 0\n`,
  curl:'#!/usr/bin/env bash\nexit 0\n',
  sleep:'#!/usr/bin/env bash\nexit 0\n'
 })){
  const file=path.join(bin,name);await fs.writeFile(file,contents,{mode:0o700});await fs.chmod(file,0o700);
 }
 for(const file of ['web.env','worker.env','notification.env','compose.yml'])await fs.writeFile(path.join(dir,file),'# mock\n');
 const stateDir=path.join(dir,'state');await fs.mkdir(stateDir);
 const active=path.join(dir,'active');
 const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CLASSICFIN_COMPOSE_FILE:path.join(dir,'compose.yml'),CLASSICFIN_STATE_DIR:stateDir,
  CLASSICFIN_ENV_FILE:path.join(dir,'web.env'),CLASSICFIN_WORKER_ENV_FILE:path.join(dir,'worker.env'),CLASSICFIN_NOTIFICATION_ENV_FILE:path.join(dir,'notification.env'),CLASSICFIN_HOST_PORT:'3500',
  FAKE_ACTIVE:active,FAKE_BAD:bad};
 return {dir,stateDir,active,env};
}
const run=env=>spawnSync('bash',[script],{env,encoding:'utf8',timeout:10000});
test('immutable release refuses mutable image tags and the unapproved initial deployment', {skip:process.platform==='win32'},async t=>{
 const x=await setup(t);
 assert.notEqual(run({...x.env,CLASSICFIN_RELEASE_IMAGE:'classicfin-hub:latest'}).status,0);
 assert.notEqual(run({...x.env,CLASSICFIN_RELEASE_IMAGE:newest}).status,0);
});
test('immutable release updates web and worker only after readiness', {skip:process.platform==='win32'},async t=>{
 const x=await setup(t);await fs.writeFile(path.join(x.stateDir,'current-image'),previous);
 const result=run({...x.env,CLASSICFIN_RELEASE_IMAGE:newest});
 assert.equal(result.status,0,result.stderr);
 assert.equal((await fs.readFile(path.join(x.stateDir,'current-image'),'utf8')).trim(),newest);
 assert.equal((await fs.readFile(x.active,'utf8')).trim(),newest);
});
test('failed worker readiness rolls web and worker back to the previous image', {skip:process.platform==='win32'},async t=>{
 const x=await setup(t);await fs.writeFile(path.join(x.stateDir,'current-image'),previous);
 const result=run({...x.env,CLASSICFIN_RELEASE_IMAGE:bad});
 assert.notEqual(result.status,0,'must not report success for an unhealthy deployment');
 assert.match(result.stderr,/restoring previous immutable image/);
 assert.equal((await fs.readFile(path.join(x.stateDir,'current-image'),'utf8')).trim(),previous);
 assert.equal((await fs.readFile(x.active,'utf8')).trim(),previous);
});
test('failed image pull leaves the running deployment and saved rollback target untouched', {skip:process.platform==='win32'},async t=>{
 const x=await setup(t);await fs.writeFile(path.join(x.stateDir,'current-image'),previous);await fs.writeFile(x.active,previous);
 const result=run({...x.env,CLASSICFIN_RELEASE_IMAGE:newest,FAKE_PULL_FAIL:'1'});
 assert.notEqual(result.status,0);assert.doesNotMatch(result.stderr,/restoring previous immutable image/);
 assert.equal(await fs.readFile(x.active,'utf8'),previous);assert.equal((await fs.readFile(path.join(x.stateDir,'current-image'),'utf8')).trim(),previous);
});
