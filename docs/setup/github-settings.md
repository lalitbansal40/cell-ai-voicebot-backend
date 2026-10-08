# GitHub Settings (manual — project lead)

CI workflows (`.github/workflows/ci.yml`) only run on GitHub after the branches are pushed. These settings must be applied by hand in the GitHub UI for **both** repos:

- Backend: <https://github.com/lalitbansal40/cell-ai-voicebot-backend/settings>
- Frontend: <https://github.com/lalitbansal40/cell-ai-voicebot-frontend/settings>

## 1. Push the branches

```bash
# in each repo
git push -u origin main dev feature/phase-0-setup
```

## 2. Default branch

Settings → General → Default branch → **`main`**. (Currently the remote `HEAD` points at `feature/phase-0-setup`.)

## 3. Branch protection (Settings → Branches → Add rule, or Rulesets)

Apply to **`main`** and **`dev`**:

- [x] Require a pull request before merging (1 approval once a second developer joins; 0 while solo)
- [x] Require status checks to pass: **`verify`**, **`secrets-scan`**, **`commitlint`** (checks appear after the first CI run)
- [x] Require branches to be up to date before merging
- [x] Require linear history
- [x] Block force pushes
- [x] Restrict deletions
- [ ] (optional) Require signed commits

## 4. Security (Settings → Code security)

- [x] Dependency graph
- [x] Dependabot alerts
- [x] Dependabot security updates
- [x] Secret scanning
- [x] Push protection (blocks pushes containing secrets)

Dependabot version updates are configured in `.github/dependabot.yml` (weekly, Monday, Asia/Kolkata). TypeScript minor/major and ESLint major updates are ignored on purpose — upgrade them manually (see ADR 0002 / CHANGELOG).

## 5. Actions (Settings → Actions → General)

- Allow GitHub Actions; workflow permissions: **Read repository contents** (the workflow requests extra permissions per job).
- No repository secrets are needed yet (`gitleaks-action` needs no license for personal-account repos).

## 6. After the first CI run

- Add the CI badge to each README: `![CI](https://github.com/lalitbansal40/<repo>/actions/workflows/ci.yml/badge.svg)`.
- Re-check that the required status check names match the job names above.
