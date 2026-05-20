# Semantic Versioning Guide

This project uses automated semantic versioning with [semantic-release](https://semantic-release.gitbook.io/).

## How It Works

Version bumps are **automatically determined** by your commit messages using [Conventional Commits](https://www.conventionalcommits.org/).

### Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

#### Types and Version Bumps

| Type | Version Bump | Description | Example |
|------|--------------|-------------|---------|
| `feat` | **MINOR** (0.x.0) | New feature | `feat: add updateUserMetadata method` |
| `fix` | **PATCH** (0.0.x) | Bug fix | `fix: correct type error in validation` |
| `perf` | **PATCH** (0.0.x) | Performance improvement | `perf: optimize gibbon decoding` |
| `docs` | **PATCH** (0.0.x) | Documentation only | `docs: update quickstart guide` |
| `refactor` | **PATCH** (0.0.x) | Code refactoring | `refactor: simplify permission logic` |
| `test` | No release | Test changes | `test: add error handling tests` |
| `build` | No release | Build system changes | `build: update dependencies` |
| `ci` | No release | CI configuration | `ci: add release workflow` |
| `chore` | No release | Maintenance tasks | `chore: update dev dependencies` |
| `revert` | **PATCH** (0.0.x) | Revert previous commit | `revert: revert feat: add X` |

#### Breaking Changes = MAJOR (x.0.0)

Add `BREAKING CHANGE:` in the footer or `!` after type:

```bash
feat!: change API signature for validateUser

BREAKING CHANGE: validateUser now requires Buffer instead of Uint8Array
```

## Branch Strategy

| Branch | Release Type | Example Version |
|--------|--------------|-----------------|
| `main` / `master` | Stable releases | `1.0.0`, `1.1.0`, `2.0.0` |
| `development` | Beta pre-releases | `1.1.0-beta.1`, `1.1.0-beta.2` |

## Pre-release Testing

Test what version would be released without actually releasing:

```bash
npm run release:dry
```

## GitHub Secrets Required

For CI/CD to work, ensure these secrets are set in GitHub repo settings:

- `NPM_TOKEN` - npm authentication token for publishing
- `GITHUB_TOKEN` - Automatically provided by GitHub Actions
