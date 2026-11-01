# Releasing AgentRelay

The version-one CLI is packaged as a standalone npm tarball. It bundles all runtime JavaScript dependencies;
users need Node 22.13+ and Git, but do not need pnpm or this source checkout. The VS Code extension belongs to version two.

## Build and install locally

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm release:pack
pnpm release:smoke
npm install -g ./release/agentrelay-cli-0.1.0-alpha.0.tgz
agentrelay --version
agentrelay doctor
```

The pack command creates a tarball, a SHA-256 sidecar and `release/manifest.json`. The smoke test installs that
tarball offline into a temporary directory, then exercises checkpoints, hook installation and cleanup in an isolated project.
Output is ignored by Git. Repeated local builds use new staging directories and replace the version's tarball.
The source manifests stay private; the generated manifest is installable and contains no `workspace:` dependencies.

## Signed draft releases

1. Update `apps/cli/package.json` and `packages/core/src/version.ts` to the same version; update the workspace
   package versions and changelog when cutting a new release.
2. Commit the intended source and lockfile, then push a matching `v<version>` tag after review.
3. `.github/workflows/release.yml` builds/tests the source and installs the package on Windows, macOS and Linux,
   on Node 22 and 24. A separate job builds the distributed artifact and generates its signed provenance.
4. The workflow creates a **draft** GitHub release with the tarball, checksum and manifest. Review it, then publish
   the draft from GitHub. A manual workflow run validates and uploads artifacts without creating a release.

The packaging step refuses a tag that disagrees with the CLI version. Signing uses GitHub OIDC and artifact
attestations; no long-lived signing secret is needed. The repository must support attestations: GitHub's current
availability rules require a public repository on Free/Pro/Team, or Enterprise Cloud for private repositories.
See [GitHub's attestation documentation](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

Verify a downloaded artifact against the actual hosting repository:

```sh
gh attestation verify agentrelay-cli-0.1.0-alpha.0.tgz -R OWNER/REPOSITORY
npm install -g ./agentrelay-cli-0.1.0-alpha.0.tgz
```

This is a signed provenance attestation for the JavaScript package. No platform executable is produced.
Local packaging does not create a signature; the GitHub job does. SHA-256 sidecars alone do not authenticate a publisher.

## npm registry publication

GitHub tarballs can be installed directly. Optional registry publication is a separate reviewed action:

```sh
npm publish ./release/agentrelay-cli-0.1.0-alpha.0.tgz --access public --tag alpha
```

The publisher needs rights to the `@agentrelay` scope. The generated package is MIT-licensed and includes `LICENSE`
and the bundled dependency license notices. The workflow does not publish to npm automatically.

## Measurements

The expanded benchmark harness is ready, but cold-resume and Codex results require paid/live agent calls and
long idle periods. Use the preview in [the benchmark guide](../packages/benchmarks/README.md) before starting runs.
Do not replace the original measurements with projections or synthetic results.
