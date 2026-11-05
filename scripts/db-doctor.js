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
