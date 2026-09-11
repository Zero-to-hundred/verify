# Z2H Verified

> **This is not the live verification path.** As of 11 September 2026, Z2H
> Verified runs inside the marketplace's own sandbox: a seller declares "built
> with Jetpack" on their listing and does nothing else. This repository is kept
> public at `v0` because the design was proven end to end here — including the
> certificate check that proves which account owns a repository — and it is the
> starting point if public, independently checkable verification is ever wanted
> again. It is never tagged `v1`.

This repository is the thing behind the **Z2H Verified** badge on a Zero to
Hundred listing. It is public so you can read it: a badge whose checks nobody can
inspect is worth nothing.

If you are a buyer wondering whether a badge means anything, this page is for you.

---

## What the badge claims

That on one specific commit of the seller's repository, all of this passed on a
clean machine with no accounts and no secrets:

| | |
|---|---|
| **setup** | a fresh clone starts, with no keys and no services to configure |
| **verify** | it typechecks, lints, passes its unit tests, and its colours clear WCAG AA in both themes |
| **acceptance** | every feature met its own written specification, against a real Postgres and a real server |
| **e2e** | the browser flows work |
| **grade** | a third party graded the code |
| **kit** | the parts that *decide* whether it passed are unmodified from the kit it was built on |

## What it does not claim

- **Not that the product is good.** It says the code does what its own
  specification says, not that the specification is worth anything.
- **Not that it is secure.** No audit.
- **Not that it still holds.** It covers one commit. The badge names which.

## Why you can believe it

The seller cannot run this. They can only *ask* for it.

Every step runs a tool directly, by path — never `pnpm verify` or `pnpm test`,
which are entries in the seller's own `package.json` and could be redefined as
`exit 0` in one line. The acceptance runner and the tool that writes the result
both come from **this** repository, checked out at a tag, not from theirs.

Then GitHub signs the result. The signature records which workflow produced it,
which repository was built, and which account owns that repository — values
stamped by GitHub's identity service, not written by anybody.

## Check it yourself

Download `attestation.json` and its bundle from the run linked on the listing:

```bash
cosign verify-blob   --bundle attestation.json.sigstore   --certificate-oidc-issuer https://token.actions.githubusercontent.com   --certificate-identity "https://github.com/Zero-to-hundred/verify/.github/workflows/verify.yml@refs/tags/v1"   attestation.json
```

If that fails, the badge is false. It is that simple, and you do not have to take
the marketplace's word for any of it.

To see the identity in full:

```bash
cosign verify-blob   --bundle attestation.json.sigstore   --certificate-oidc-issuer https://token.actions.githubusercontent.com   --certificate-identity "https://github.com/Zero-to-hundred/verify/.github/workflows/verify.yml@refs/tags/v1"   attestation.json
```

`buildSignerURI` must be this workflow. `sourceRepositoryOwnerID` is GitHub's
numeric id for the account that owns the code — the marketplace checks it against
the seller's linked account, which is how it knows the listing belongs to them.

## What is in here

| Path | |
|---|---|
| `.github/workflows/verify.yml` | the pipeline. Every step, in order. |
| `acceptance/` | the runner that checks each feature against its own spec. Vendored from the kit — `VENDORED_FROM` names the commit. |
| `compose/` | writes the attestation from the step outcomes. Reads nothing the seller could have written. |

## For sellers

One file in your repository, and nothing else:

```yaml
name: Z2H Verified
on:
  push:
    branches: [main]
jobs:
  verify:
    uses: Zero-to-hundred/verify/.github/workflows/verify.yml@v0
    with:
      kit-version: "0.1.0"
    permissions:
      contents: read
      id-token: write
      attestations: write
```

The repository must be owned by the GitHub **user account** linked to your Z2H
account. Organisation-owned repositories are not supported yet: the signature
records the organisation's id, not yours, so the marketplace cannot tell it is
you.

Push, wait for the run, then run `/publish-listing`.

**Your repository stays private.** The signature goes to the public Sigstore
transparency log, which records the repository name, the commit hash, the
signing workflow and the numeric id of the account that owns the repo — and
nothing else. Not your code, not the attestation's contents, not your results.
Because buyers cannot open a private repository, the badge links to a Zero to
Hundred verification page rather than to the run.

---

`v0` is the proving tag. It becomes `v1` once the chain has been verified
end to end.
