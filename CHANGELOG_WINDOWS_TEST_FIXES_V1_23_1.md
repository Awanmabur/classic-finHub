# v1.23.1 — Windows regression and backup test execution

- Node-based `mongodump` and `mongorestore` fixtures run via Node on Windows without shell execution.
- Strict backup behavior, authenticated encryption and offsite verification are unchanged.
- Cash report test recognizes 403 for unauthorized assigned branch scope.
- Production SEO test explicitly enables crawler indexing, irrespective of developer defaults.
- Prevents a transient unhandled rejection when a database-tool subprocess cannot start.
- See `docs/WINDOWS_TEST_COMPATIBILITY_V1_23_1.md` for limitations.
