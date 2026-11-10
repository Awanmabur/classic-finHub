'use strict';
const mongoose = require('mongoose');
const env = require('../src/config/env');
const { verifyReplicaPrimary, DEV_TIPS } = require('../src/config/mongoTopology');

async function main() {
  const connection = await mongoose.createConnection(env.mongoPlatformUri, {
    serverSelectionTimeoutMS: 5000, maxPoolSize: 2, autoIndex: false
  }).asPromise();
  try {
    const hello = await connection.db.admin().command({ hello: 1 });
    const result = verifyReplicaPrimary(hello);
    console.log(`PASS: MongoDB ${result.replicaSet} has a writable primary.`);
    console.log(`PASS: Connection is ready for transactions (deployment permissions and multi-document writes still need a live integration test).`);
    const samples=[];
    for(let index=0;index<5;index++){
      const began=performance.now();await connection.db.command({ping:1},{timeoutMS:5000});samples.push(performance.now()-began);
    }
    const ordered=samples.sort((a,b)=>a-b),median=Math.round(ordered[2]),slowest=Math.round(ordered.at(-1));
    console.log(`MongoDB network round trip: median ${median} ms; slowest ${slowest} ms (5 read-only pings from this machine).`);
    if(median>250)console.log('Database network latency is high. Run the application near the Atlas cluster region and check the connection from the machine serving requests.');
  } finally {
    await connection.close();
  }
}
main().catch(error => {
  console.error('Database check failed:', error.message);
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Server selection timed out/i.test(error.message)) {
    console.error('MongoDB is unreachable. Check whether the server is running, the URI, firewall and port.');
    console.error(DEV_TIPS);
  }
  process.exitCode = 1;
});
