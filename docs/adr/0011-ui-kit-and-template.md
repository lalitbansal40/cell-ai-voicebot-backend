# 0011 — UI kit & template

- **Status:** proposed
- **Date:** 2026-10-08

## Context

We want MUI (team knows it from AutoChatix). AutoChatix's frontend is based on the Mantis admin template: its `package.json` name is `mantis-react-ts` v2.1.0 and `README copy.md` says it is the "seed version of Mantis Theme". No LICENSE file is present in that repo. The Mantis **TypeScript** edition is distributed as part of the paid (Pro) package, so copying its code into a separate product may need its own license.

## Options considered

1. **Copy Mantis seed from AutoChatix** — fastest, but possible license violation for a new end product.
2. **Plain MUI + our own thin layout** — no license risk, a bit more work.
3. **Buy a Mantis license for this product** — legal reuse, small cost.

## Decision

Use **MUI latest stable** with **our own thin layout/theme**. **Do not copy Mantis code** until the user confirms the license allows reuse in this product (or buys one). Stays `proposed` until then.

## Consequences

- **Positive:** zero license risk.
- **Negative / trade-offs:** some layout/components to build ourselves.
- **Follow-ups:** user to confirm Mantis license (owner: project lead) → then accept or supersede this ADR.
