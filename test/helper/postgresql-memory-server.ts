export class PostgreSqlTestServer {
  static get uri(): string {
    const uri = process.env.PG_URI;
    if (!uri) {
      throw new Error(
        'PG_URI not set. Ensure globalSetup (test/helper/setup.ts) is configured in vitest.'
      );
    }
    return uri;
  }
}
