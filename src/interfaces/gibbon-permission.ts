/**
 * Represents a permission row stored in PostgreSQL.
 * Each permission has a unique position and an allocation status.
 *
 * Arbitrary metadata fields supplied by the caller are flattened onto this object
 * (e.g. `name`, `description`) and persisted in a JSONB column.
 */
export interface IGibbonPermission {
  /** Unique 1-based position identifying this permission in the bitwise system */
  gibbonPermissionPosition: number;
  /** Whether this permission slot has been allocated for use */
  gibbonIsAllocated: boolean;
  /** Arbitrary metadata fields persisted as JSONB */
  [key: string]: unknown;
}
