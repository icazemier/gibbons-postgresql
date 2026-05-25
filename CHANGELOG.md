## 1.0.0 (2026-05-25)

### ✨ Features

* add Bun and Deno runtime compatibility ([638f4b8](https://github.com/icazemier/gibbons-postgresql/commit/638f4b8798200e2372ce2defcda05f78ad3d8cb5))
* implement PostgreSQL adapter for @icazemier/gibbons ([9d3f541](https://github.com/icazemier/gibbons-postgresql/commit/9d3f5413e2a939e62c815333244c402f62ef41b8))
* skipSchema option for externally-managed tables ([e2ba254](https://github.com/icazemier/gibbons-postgresql/commit/e2ba25411933a95ffa68a1bf43cbfa1a30b00ed5))
* support schema-qualified table names ([5dfc433](https://github.com/icazemier/gibbons-postgresql/commit/5dfc43370affdfba056e15fd516311faf911e1f9))

### 🐛 Bug Fixes

* add @semantic-release/git, expand coverage, and polish engine/docs ([6bfe370](https://github.com/icazemier/gibbons-postgresql/commit/6bfe370108a8a18ecf9dd8e47a4c8f64cd1aa93d))
* exclude compat/ from Node tsconfig and ESLint ([887187b](https://github.com/icazemier/gibbons-postgresql/commit/887187be1dbc1f04d97f419e69b982879f43c0dc))
* harden security boundaries ([2703f0f](https://github.com/icazemier/gibbons-postgresql/commit/2703f0fb586bc65a8dd4021677cd7c36647058b1))
* **jsr:** add version constraints to all npm specifiers in deno.json ([f66be51](https://github.com/icazemier/gibbons-postgresql/commit/f66be51e4850323df53b9c90c4a4f55b48191370))
* **tsconfig:** move lib inside compilerOptions ([3a4b9bb](https://github.com/icazemier/gibbons-postgresql/commit/3a4b9bb232336fbc61e5540a39b1ab6feef9aea9))

### 📚 Documentation

* add usage example and contributor guides ([43b43ae](https://github.com/icazemier/gibbons-postgresql/commit/43b43ae1890dc84ecff2428d3a37fd890800f372))
* align public API and JSDoc with gibbons-mongodb ([6e5c762](https://github.com/icazemier/gibbons-postgresql/commit/6e5c7622a96f6a72e9b11e98ff802609da9eb13c))
* document Prisma integration patterns ([9ec81a4](https://github.com/icazemier/gibbons-postgresql/commit/9ec81a4412ab549e9f0a6c83eaf30dce77e5efbe))
* expand guides to match gibbons-mongodb parity ([0637bcb](https://github.com/icazemier/gibbons-postgresql/commit/0637bcb201d36a5fa7126c71b93e8330f4b5eaef))
* fix TypeDoc — export missing public types and resolve all build warnings ([40e9675](https://github.com/icazemier/gibbons-postgresql/commit/40e967585f8762bd24ed92c24660b26707b183af))
* state supported PostgreSQL and Node versions ([fb42aa5](https://github.com/icazemier/gibbons-postgresql/commit/fb42aa59635cee965f10f329ed45d9e6e810ca0a))

### ♻️ Code Refactoring

* stream scan+update loops via PgCursor instead of queryRows ([9e7af2f](https://github.com/icazemier/gibbons-postgresql/commit/9e7af2f99127318dd7dcafc5a2d73a4203a5aa71))
* surface cleanup errors via AggregateError ([a693f67](https://github.com/icazemier/gibbons-postgresql/commit/a693f6745845a8dc07a2f7d2fa4eeefb43e1fc68))

## [1.0.0-beta.5](https://github.com/icazemier/gibbons-postgresql/compare/v1.0.0-beta.4...v1.0.0-beta.5) (2026-05-25)

### 🐛 Bug Fixes

* **jsr:** add version constraints to all npm specifiers in deno.json ([f66be51](https://github.com/icazemier/gibbons-postgresql/commit/f66be51e4850323df53b9c90c4a4f55b48191370))

## [1.0.0-beta.4](https://github.com/icazemier/gibbons-postgresql/compare/v1.0.0-beta.3...v1.0.0-beta.4) (2026-05-25)

### 🐛 Bug Fixes

* add @semantic-release/git, expand coverage, and polish engine/docs ([6bfe370](https://github.com/icazemier/gibbons-postgresql/commit/6bfe370108a8a18ecf9dd8e47a4c8f64cd1aa93d))

### 📚 Documentation

* fix TypeDoc — export missing public types and resolve all build warnings ([40e9675](https://github.com/icazemier/gibbons-postgresql/commit/40e967585f8762bd24ed92c24660b26707b183af))

# Changelog

All notable changes to this project will be documented in this file. See [Conventional Commits](https://www.conventionalcommits.org/) for commit guidelines.
