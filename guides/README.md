# @icazemier/gibbons-postgresql

> Bitwise user groups and permissions management for PostgreSQL

[![CI](https://github.com/icazemier/gibbons-postgresql/actions/workflows/ci.yml/badge.svg)](https://github.com/icazemier/gibbons-postgresql/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@icazemier/gibbons-postgresql)](https://www.npmjs.com/package/@icazemier/gibbons-postgresql)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Overview

gibbons-postgresql is a Node.js library that manages user groups and permissions using bitwise operations for maximum efficiency. It provides a PostgreSQL persistence layer on top of [@icazemier/gibbons](https://github.com/icazemier/gibbons), handling:

- Pre-allocated permission and group slots with automatic position management
- Bitwise storage of group memberships and permissions using PostgreSQL `BYTEA` fields
- Cascading permission updates when group memberships change
- `PgCursor`-based queries (compatible with Node.js streams via `.stream()`)
- A CLI tool for database initialization
- Dual ESM and CommonJS builds

## Installation

```bash
npm install @icazemier/gibbons-postgresql pg
```

`pg` is a peer dependency — you must install it alongside this library.

## Concepts

### How it works

Instead of join tables or arrays, gibbons-postgresql stores group memberships and permissions as bitwise masks (`BYTEA` buffers). Each group and permission occupies a numbered "position" (1-based). A user's group membership is a single `BYTEA` field where bit N means "member of group N". Similarly for permissions.

The database is pre-populated with a fixed number of group and permission "slots" (determined by byte length in config). Slots are **allocated** when you create a group/permission and **deallocated** when you remove them.

### Entities

- **Permissions**: Named capabilities (e.g., "can-edit", "admin"). Pre-allocated slots.
- **Groups**: Collections of permissions (e.g., "editors", "admins"). Pre-allocated slots with a bitwise permissions mask.
- **Users**: Rows with a `groups_gibbon` (group membership mask) and `permissions_gibbon` (aggregated permissions mask), plus a free-form `metadata` JSONB column.

## Quick Start

### 1. Configuration

Create a `.gibbons-postgresqlrc.json` in your project root:

```json
{
  "permissionByteLength": 128,
  "groupByteLength": 128,
  "postgresqlMutationConcurrency": 50,
  "dbStructure": {
    "user":       { "tableName": "users" },
    "group":      { "tableName": "groups" },
    "permission": { "tableName": "permissions" }
  }
}
```

This gives you up to 1024 permissions (128 × 8) and 1024 groups.

### 2. Initialize the database

```bash
npx gibbons-postgresql init --uri=postgresql://localhost:5432/myapp
```

Or programmatically:

```typescript
import { Pool } from "pg";
import { PostgreSqlSeeder, ConfigLoader } from "@icazemier/gibbons-postgresql";

const config = await ConfigLoader.load();
const pool = new Pool({ connectionString: "postgresql://localhost:5432/myapp" });
const seeder = new PostgreSqlSeeder(pool, config);
await seeder.initialize();
```

### 3. Use the library

```typescript
import { GibbonsPostgreSql, ConfigLoader } from "@icazemier/gibbons-postgresql";

const config = await ConfigLoader.load();
const gibbons = new GibbonsPostgreSql("postgresql://localhost:5432/myapp", config);
await gibbons.initialize();

// Allocate permissions
const canRead = await gibbons.allocatePermission({ name: "can-read" });
const canWrite = await gibbons.allocatePermission({ name: "can-write" });
const canDelete = await gibbons.allocatePermission({ name: "can-delete" });

// Allocate a group
const editors = await gibbons.allocateGroup({ name: "editors" });

// Subscribe permissions to the group
await gibbons.subscribePermissionsToGroups(
  [editors.gibbonGroupPosition],
  [canRead.gibbonPermissionPosition, canWrite.gibbonPermissionPosition]
);

// Create a user
const user = await gibbons.createUser({
  name: "Alice",
  email: "alice@example.com",
});

// Subscribe user to the group
await gibbons.subscribeUsersToGroups(
  { metadata: { email: "alice@example.com" } },
  [editors.gibbonGroupPosition]
);

// Validate permissions
const [alice] = await gibbons
  .findUsers({ metadata: { email: "alice@example.com" } })
  .toArray();

const hasReadWrite = gibbons.validateUserPermissionsForAllPermissions(
  alice.permissionsGibbon,
  [canRead.gibbonPermissionPosition, canWrite.gibbonPermissionPosition]
);
console.log(hasReadWrite); // true

const hasDelete = gibbons.validateUserPermissionsForAnyPermissions(
  alice.permissionsGibbon,
  [canDelete.gibbonPermissionPosition]
);
console.log(hasDelete); // false
```

## API Reference

All public methods are on the `GibbonsPostgreSql` class. Position arguments accept `GibbonLike` which is `Gibbon | Array<number> | Buffer`.

### Permissions

| Method | Returns | Description |
|--------|---------|-------------|
| `allocatePermission(data)` | `Promise<IGibbonPermission>` | Allocate next available permission slot with custom data |
| `deallocatePermissions(positions)` | `Promise<void>` | Deallocate permissions and cascade-remove from groups and users |
| `findPermissions(positions)` | `PgCursor<IGibbonPermission>` | Find permission rows by positions |
| `findAllAllocatedPermissions()` | `PgCursor<IGibbonPermission>` | List all allocated permissions |
| `updatePermissionMetadata(position, data)` | `Promise<IGibbonPermission \| null>` | Update custom fields on a permission |
| `validateAllocatedPermissions(positions, allocated?)` | `Promise<boolean>` | Check if positions are allocated |

### Groups

| Method | Returns | Description |
|--------|---------|-------------|
| `allocateGroup(data)` | `Promise<IGibbonGroup>` | Allocate next available group slot with custom data |
| `deallocateGroups(positions)` | `Promise<void>` | Deallocate groups and remove membership from users |
| `findGroups(positions)` | `PgCursor<IGibbonGroup>` | Find group rows by positions |
| `findGroupsByPermissions(permissions, allocated?)` | `PgCursor<IGibbonGroup>` | Find groups that have specific permissions |
| `findAllAllocatedGroups()` | `PgCursor<IGibbonGroup>` | List all allocated groups |
| `updateGroupMetadata(position, data)` | `Promise<IGibbonGroup \| null>` | Update custom fields on a group |
| `subscribePermissionsToGroups(groups, permissions)` | `Promise<void>` | Add permissions to groups (cascades to users) |
| `unsubscribePermissionsFromGroups(groups, permissions)` | `Promise<void>` | Remove permissions from groups (recalculates users) |
| `validateAllocatedGroups(positions, allocated?)` | `Promise<boolean>` | Check if positions are allocated |

### Users

| Method | Returns | Description |
|--------|---------|-------------|
| `createUser(data)` | `Promise<IGibbonUser>` | Create a new user with empty group/permission gibbons |
| `removeUser(filter)` | `Promise<number>` | Remove users matching `UserFilter` |
| `findUsers(filter)` | `PgCursor<IGibbonUser>` | Find users by `UserFilter` |
| `findUsersByGroups(groups)` | `PgCursor<IGibbonUser>` | Find users subscribed to specific groups |
| `findUsersByPermissions(permissions)` | `PgCursor<IGibbonUser>` | Find users with specific permissions |
| `updateUserMetadata(filter, data)` | `Promise<IGibbonUser \| null>` | Update custom fields on a user |
| `subscribeUsersToGroups(filter, groups)` | `Promise<void>` | Subscribe users to groups (adds permissions) |
| `unsubscribeUsersFromGroups(filter, groups)` | `Promise<void>` | Unsubscribe users from groups (recalculates permissions) |

### Validation (synchronous, in-memory)

| Method | Returns | Description |
|--------|---------|-------------|
| `validateUserGroupsForAllGroups(userGroups, groups)` | `boolean` | Check user has ALL specified groups |
| `validateUserGroupsForAnyGroups(userGroups, groups)` | `boolean` | Check user has ANY of specified groups |
| `validateUserPermissionsForAllPermissions(userPerms, perms)` | `boolean` | Check user has ALL specified permissions |
| `validateUserPermissionsForAnyPermissions(userPerms, perms)` | `boolean` | Check user has ANY of specified permissions |
| `getPermissionsGibbonForGroups(groups)` | `Promise<Gibbon>` | Get aggregated permissions Gibbon for given groups |

## Streaming

All `find*` methods return a `PgCursor<T>` which supports async iteration, `.toArray()`, and Node.js streams:

```typescript
// Async iteration
for await (const user of gibbons.findUsersByGroups([1, 2])) {
  console.log(user.name);
}

// Node.js stream (object mode)
import { pipeline } from "stream";

const readable = gibbons.findUsersByGroups([1, 2]).stream();
pipeline(readable, myTransform, myWritable, (err) => {
  if (err) console.error(err);
});

// Collect all rows at once
const users = await gibbons.findUsersByGroups([1, 2]).toArray();
```

## CLI

```bash
# Initialize database (creates tables, installs helper function, seeds slots)
npx gibbons-postgresql init --uri=postgresql://localhost:5432/myapp

# Use a custom config file
npx gibbons-postgresql init --uri=postgresql://localhost:5432/myapp --config=./my-config.json

# Skip schema creation (when Prisma/Drizzle/Flyway already created the tables)
npx gibbons-postgresql init --uri=postgresql://localhost:5432/myapp --skip-schema
```

## Configuration

Configuration is loaded via [cosmiconfig](https://github.com/davidtheclark/cosmiconfig). It searches for:

- `.gibbons-postgresqlrc.json`
- `.gibbons-postgresqlrc.yaml`
- `gibbons-postgresql.config.js`
- `"gibbons-postgresql"` key in `package.json`

### Config Interface

```typescript
interface Config {
  permissionByteLength: number; // Max permissions = byteLength * 8
  groupByteLength: number;      // Max groups = byteLength * 8
  postgresqlMutationConcurrency: number;
  dbStructure: {
    user:       { tableName: string }; // e.g. "users" or "myschema.users"
    group:      { tableName: string };
    permission: { tableName: string };
  };
}
```

## License

MIT
