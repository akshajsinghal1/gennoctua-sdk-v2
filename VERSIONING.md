# SDK versioning

## Pinning (important for production)

Existing websites must **keep their current CDN pin** until they opt in to a new version.

| Pin | Who uses it | Notes |
|-----|-------------|-------|
| `@9687b9e` | Maui Jim, other live prod sites | **Stable — do not change** |
| `@v0.2.0` | Westside 5806 (measurement handoff test) | New measurement API |
| `@main` | **Never use in prod** | Moves on every push |

### jsDelivr CDN URL format

```
https://cdn.jsdelivr.net/gh/akshajsinghal1/gennoctua-sdk-v2@<TAG_OR_COMMIT>/dist/cdn/personalize.min.global.js
```

Examples:
- Stable prod: `@9687b9e`
- v0.2 measurement handoff: `@v0.2.0`

### npm package

```bash
npm install @gennoctua/personalize-core@0.2.0
```

## Release process

1. Work on branch `feature/measurement-handoff-v0.2` (or next feature branch)
2. Bump `package.json` version (semver)
3. Update `CHANGELOG.md`
4. `npm run build`
5. Merge to `main`
6. `git tag v0.2.0 && git push origin v0.2.0`
7. Opt-in sites update their CDN pin / npm version

## Breaking change policy

- **Minor (0.x):** new optional APIs (`measurement.*`) — old sites ignore them
- **Patch:** bug fixes, same pin safe to refresh if using tags not commits
- **Major (1.0):** TBD — will document migration path
