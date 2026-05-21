# Prisma + gibbons-postgresql

A minimal example showing how to let Prisma own the schema while
`@icazemier/gibbons-postgresql` manages the bitwise group/permission state
on top of it.

## Files

- `schema.prisma` — Prisma model definitions for the three tables the gibbons
  adapter reads/writes. Includes the `users` table with the bitmask columns,
  the slot tables for groups and permissions, and a JSONB metadata column for
  caller-supplied fields.

## Setup

```bash
# 1. Your usual Prisma flow creates the tables.
DATABASE_URL=postgresql://localhost:5432/myapp npx prisma migrate dev

# 2. Seed the slot rows. --skip-schema tells the gibbons CLI to
#    NOT run CREATE TABLE / CREATE EXTENSION (Prisma already did).
npx gibbons-postgresql init \
  --uri=postgresql://localhost:5432/myapp \
  --skip-schema
```

## Programmatic usage

```typescript
import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import {
  GibbonsPostgreSql,
  PostgreSqlSeeder,
  ConfigLoader,
} from '@icazemier/gibbons-postgresql';

const prisma = new PrismaClient();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const config = await ConfigLoader.load();

// One-time setup (e.g. in a post-migrate script). Idempotent.
const seeder = new PostgreSqlSeeder(pool, config);
await seeder.initialize({ skipSchema: true });

// Same adapter, same API as without Prisma.
const gibbons = new GibbonsPostgreSql(pool, config);
await gibbons.initialize();

// Create a user with Prisma (or with gibbons — either works).
const user = await prisma.user.create({
  data: {
    metadata: { name: 'Alice', email: 'alice@example.com' },
    groupsGibbon: Buffer.alloc(config.groupByteLength),
    permissionsGibbon: Buffer.alloc(config.permissionByteLength),
  },
});

// Allocate a permission + group + subscribe with gibbons.
const edit = await gibbons.allocatePermission({ name: 'posts.edit' });
const admins = await gibbons.allocateGroup({ name: 'Admins' });
await gibbons.subscribePermissionsToGroups(
  [admins.gibbonGroupPosition],
  [edit.gibbonPermissionPosition]
);
await gibbons.subscribeUsersToGroups({ id: user.id }, [
  admins.gibbonGroupPosition,
]);

// Read with Prisma — metadata stays nested, gibbons stay as Buffer.
const fresh = await prisma.user.findUnique({ where: { id: user.id } });
console.log(fresh?.metadata); // { name: 'Alice', email: 'alice@example.com' }
console.log(fresh?.groupsGibbon.length); // = config.groupByteLength
```

## Notes

- **Two pools, one database**. Prisma manages its own pool internally. Pass a
  separate `pg.Pool` to gibbons — the overhead is a handful of connections.
- **No shared transactions across libraries**. Prisma's `$transaction` callback
  gives you a Prisma client; gibbons' `withTransaction` gives you a `pg.PoolClient`.
  Run gibbons' transactional ops inside `withTransaction(pool, …)` and Prisma's
  inside `prisma.$transaction(…)`. They commit independently.
- **Querying users**. For attributes Prisma owns (its own dedicated columns
  alongside `metadata`), use Prisma's query API. Use `gibbons.findUsers({ id })`
  for ID lookup or `gibbons.findUsers({ metadata: { … } })` for filters on the
  shared metadata column.
- **Reading bitmasks from Prisma**. `permissionsGibbon`/`groupsGibbon` come back
  as `Buffer`. Decode with `Gibbon.decode(buf)` from `@icazemier/gibbons` to
  inspect bit positions.
