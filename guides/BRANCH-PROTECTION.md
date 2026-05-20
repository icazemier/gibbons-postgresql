# Branch Protection Setup Guide

This document explains how to configure GitHub branch protection rules to prevent faulty pushes and maintain code quality.

## Quick Setup

Go to your GitHub repository:
1. Navigate to **Settings** → **Branches**
2. Click **Add branch protection rule**
3. Apply the settings below

## Recommended Branch Protection Rules

### For `main` Branch

**Branch name pattern:** `main`

- Require a pull request before merging (require approvals: 1)
- Require status checks to pass before merging
  - `test (20.x)`, `test (22.x)`, `test (24.x)`
- Require conversation resolution before merging
- Require linear history (optional)
- Include administrators
- Disable force pushes
- Disable deletions

### For `development` Branch

Same as `main` but with slightly relaxed rules (allow maintainers to bypass approvals for hotfixes if desired).

## Additional Security Measures

- Enable CODEOWNERS (already configured at `.github/CODEOWNERS`)
- Require two-factor authentication for all contributors
- Enable Dependabot alerts and security updates
- Enable secret scanning with push protection
