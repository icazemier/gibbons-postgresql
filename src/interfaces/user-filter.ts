/**
 * Supported scalar values that can appear in a {@link UserFilter}.
 */
export type FilterPrimitive = string | number | boolean | null;

/**
 * Comparison operators applied to a single metadata column.
 *
 * The bare-value shorthand (e.g. `{ email: "x@y.com" }`) is equivalent to `{ eq: "x@y.com" }`.
 */
export type MetadataComparator =
  | FilterPrimitive
  | FilterPrimitive[]
  | {
      eq?: FilterPrimitive;
      ne?: FilterPrimitive;
      in?: FilterPrimitive[];
      nin?: FilterPrimitive[];
      like?: string;
      ilike?: string;
      gt?: FilterPrimitive;
      gte?: FilterPrimitive;
      lt?: FilterPrimitive;
      lte?: FilterPrimitive;
      isNull?: boolean;
    };

/**
 * Identifier filter for the `id` column.
 *
 * Accepts a single UUID string, an array of UUIDs, or `{ in: [...] }`.
 */
export type IdFilter = string | string[] | { in: string[] };

/**
 * Filter shape for user lookups.
 *
 * - `id` filters the primary key column.
 * - `metadata` filters arbitrary fields stored in the JSONB metadata column.
 *
 * Top-level entries are combined with `AND`. Within `metadata`, each key is
 * compared to its column via `metadata->>'<key>'`.
 *
 * @example
 * ```typescript
 * { id: "11111111-1111-1111-1111-111111111111" }
 * { metadata: { email: "alice@example.com" } }
 * { metadata: { name: { ilike: "%Cooper%" } } }
 * { metadata: { age: { gte: 18 }, role: { in: ["admin", "editor"] } } }
 * ```
 */
export interface UserFilter {
  id?: IdFilter;
  metadata?: Record<string, MetadataComparator>;
}
