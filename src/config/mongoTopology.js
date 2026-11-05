'use strict';

const DEV_TIPS = 'Use `npm run db:dev:up` then `npm run dev:local` for isolated local MongoDB, or configure your existing mongod with replication.replSetName: rs0, restart it and run `rs.initiate()` once in mongosh. Run `npm run db:doctor` to check your connection.';

function verifyReplicaPrimary(hello) {
  if (!hello || typeof hello !== 'object') {
    throw new Error('MongoDB topology could not be verified. '+DEV_TIPS);
  }
  if (!hello.setName) {
    throw new Error('MongoDB is running as a standalone server. Multi-document financial writes require a replica set. '+DEV_TIPS);
  }
  if (hello.isWritablePrimary !== true) {
    throw new Error(`MongoDB replica set ${hello.setName} is not ready for writes (no writable primary). Check rs.status() and connectivity; financial writes remain blocked.`);
  }
  return { replicaSet: hello.setName, writablePrimary: true };
}
module.exports = { verifyReplicaPrimary, DEV_TIPS };
