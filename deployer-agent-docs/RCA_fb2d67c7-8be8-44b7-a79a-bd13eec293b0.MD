# RCA — Deploy run fb2d67c7-8be8-44b7-a79a-bd13eec293b0 (iqfoam-business)

## Summary
The redeploy failed at the **build_image** step. The Vite frontend production build aborted because a source module that is imported does not exist in the repo.

## Failing step
`build_image` → Cloud Build step #2 `docker-build`, Dockerfile target `frontend-build` (`yarn build`).

## Exact error (from build logs)
```
vite v8.1.5 building client environment for production...
transforming...✓ 2957 modules transformed.
✗ Build failed in 1.05s
error during build:
[UNLOADABLE_DEPENDENCY] Could not load src/lib/blockYield.mjs
  ╭─[ src/pages/Production.jsx:10:59 ]
  10 │ import { assessBlockYield, expectedWhiteBlockYield } ...
  │                                                      ╰──── No such file or directory (os error 2)
```

## Root cause (verified in eph sandbox)
`frontend/src/pages/Production.jsx` line 10 imports:
```js
import { assessBlockYield, expectedWhiteBlockYield } from "@/lib/blockYield.mjs";
```
The target file `frontend/src/lib/blockYield.mjs` **does not exist**. Directory listing of `frontend/src/lib/` confirms no `blockYield*` file is present (many other `.mjs` modules exist, e.g. `attendanceHours.mjs`, `grv.mjs`, `invoicePricing.mjs`, but `blockYield.mjs` is absent). A repo-wide grep shows the only reference to `blockYield` is this import in `Production.jsx` — so the module was referenced but never created/committed (or was deleted).

This is a source-code defect, not a manifest, secret, tier, or platform issue.

## Required fix (Code — E1)
Create the missing module `frontend/src/lib/blockYield.mjs` exporting the two named functions used by `Production.jsx`:
- `assessBlockYield`
- `expectedWhiteBlockYield`

OR, if those functions live elsewhere / were renamed, correct the import path in `frontend/src/pages/Production.jsx:10` to point at the real module.

After the source is fixed and committed to the preview `/app`, redeploy.

## Not the cause (ruled out)
- Not a manifest issue — the Dockerfile/entrypoint/nginx are fine; the build ran and only failed inside the app's own `yarn build`.
- Not dependency resolution — `yarn install` and linking completed; 2957 modules transformed before the missing-file error.
- Not secrets/tier/infra.
