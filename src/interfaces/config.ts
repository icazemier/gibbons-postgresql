/**
 * Table name configuration for each entity type.
 */
export interface DbStructure {
  user: { tableName: string };
  group: { tableName: string };
  permission: { tableName: string };
}

/**
 * Configuration for the gibbons-postgresql library.
 */
export interface Config {
  /** PostgreSQL database name shared by all tables */
  dbName: string;
  /** Number of bytes for the permissions Gibbon (max permissions = byteLength * 8) */
  permissionByteLength: number;
  /** Number of bytes for the groups Gibbon (max groups = byteLength * 8) */
  groupByteLength: number;
  /** Concurrency limit for bulk PostgreSQL mutations */
  postgresqlMutationConcurrency: number;
  /** Table structure for each entity type */
  dbStructure: DbStructure;
}
