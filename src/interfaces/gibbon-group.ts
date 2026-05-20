import { Buffer } from 'node:buffer';
import { Gibbon } from '@icazemier/gibbons';

/**
 * Utility type that omits the `gibbonGroupPosition` field from a group-like type.
 * Used when allocating new groups where the position is assigned automatically.
 */
export type OmitGibbonGroupPosition<T extends { gibbonGroupPosition: number }> =
  Omit<T, 'gibbonGroupPosition'>;

/**
 * Represents a group row stored in PostgreSQL.
 * Each group has a unique position, an allocation status, and a bitwise permissions mask.
 *
 * Arbitrary metadata fields supplied by the caller are flattened onto this object
 * (e.g. `name`, `description`) and persisted in a JSONB column.
 */
export interface IGibbonGroup {
  /** Bitwise mask of permissions subscribed to this group */
  permissionsGibbon: Buffer | Gibbon;
  /** Unique 1-based position identifying this group in the bitwise system */
  gibbonGroupPosition: number;
  /** Whether this group slot has been allocated for use */
  gibbonIsAllocated: boolean;
  /** Arbitrary metadata fields persisted as JSONB */
  [key: string]: unknown;
}
