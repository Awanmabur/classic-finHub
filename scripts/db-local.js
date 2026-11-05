'use strict';
/** Start/stop a loopback-only MongoDB development replica set with Docker Desktop.
 *  Never modifies existing mongod Windows services or removes database volumes.
 */
const path = require('path');
const { spawnSync } = require('child_process');
const composePath = path.resolve(__dirname, '../deploy/compose.dev.yml');
const EVAL_INIT = String.raw`try {
  const status = rs.status();
  if (status.set !== 'rs0') throw Error('Unexpected replica set name: '+status.set);
  print('Replica set already initialized: '+status.set);
} catch(e) {
  if (e.code !== 94 && e.codeName !== 'NotYetInitialized') throw e;
  printjson(rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27018'}]}));
}`;
const EVAL_READY = `if (!db.hello().isWritablePrimary) quit(2); print('MongoDB replica set PRIMARY ready.');`;
function docker(args, { silent = false } = {}) {
  const result = spawnSync('docker', args, { encoding:'utf8', stdio: silent ? 'pipe' : 'inherit', windowsHide:true });
  if (result.error) throw new Error('Docker CLI not available. Install and launch Docker Desktop, or configure a native MongoDB replica set. '+result.error.message);
  if (result.status !== 0 && !silent) throw new Error(`Docker command failed (exit ${result.status}). Check Docker Desktop status and whether port 27018 is free.`);
  return result;
}
function run(operation = 'up') {
  if (!['up','down','status'].includes(operation)) throw new Error('Usage: node scripts/db-local.js [up|down|status]');
  const base = ['compose', '-f', composePath];
  if (operation === 'down') {
    docker([...base,'down']);
    console.log('Stopped local MongoDB; development data volume was preserved.');
    return;
  }
  if (operation === 'status') {
    docker([...base, 'ps']);
    return;
  }
  docker([...base,'up','-d','--wait']);
  docker([...base,'exec','-T','mongo','mongosh','--port','27018','--quiet','--eval',EVAL_INIT]);
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = docker([...base,'exec','-T','mongo','mongosh','--port','27018','--quiet','--eval',EVAL_READY], { silent:true });
    if (status.status === 0) {
      process.stdout.write(status.stdout || 'MongoDB is ready.\n');
      console.log('Local development URI: mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
      console.log('Run `npm run dev:local` or configure MONGO_PLATFORM_URI in your .env file.');
      return;
    }
    spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500)'],{stdio:'ignore'});
  }
  throw new Error('Replica set is not PRIMARY yet. Run `npm run db:dev:status` and inspect the Docker logs.');
}
if (require.main === module) {
  try { run(process.argv[2] || 'up'); } catch(e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { run };
