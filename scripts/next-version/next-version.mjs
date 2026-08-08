// Computes the version each package in a changesets workspace should be published under for an
// in-flight prerelease build.
//
// Why this exists: the build templates stamp a prerelease suffix onto whatever version the
// repository currently carries, and that version is the *last released* one. Straight after a
// stable release of 1.0.0 that produces `1.0.0-beta.<stamp>` — which sorts BELOW the 1.0.0 already
// on the registry, so the prerelease looks like a downgrade and never surfaces as "newer" to anyone
// tracking prereleases. The fix is to base it on the version the pending changesets are heading for
// (1.1.0-beta.<stamp>) rather than the one already out the door.
//
// For every workspace package the computed version is:
//
//   * <next version from the pending changesets>-<tag>.<stamp>, when changesets bump the package;
//   * <current version, patch-bumped>-<tag>.<stamp>, when they do not — still strictly above the
//     last stable release, so a prerelease never sorts below it.
//
// In changesets pre mode the planned version already carries a `-<pretag>.N` suffix; it is stripped
// so the stamp is the only prerelease part. The two tags then interleave by name, which is fine:
// neither can fall below the last stable release, which is the property that matters.
//
// This reads the target workspace purely as data (changesets' API takes a cwd), so it does not care
// what the target repo has installed and never mutates it.
//
// Usage: node next-version.mjs --cwd=<workspace root> [--tag=beta] [--nuget-package=<name>]
//
// Writes `<slug>=<version>` lines plus a `versions` JSON map to $GITHUB_OUTPUT, and a readable
// table to stdout.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import getReleasePlan from "@changesets/get-release-plan";
import { getPackages } from "@manypkg/get-packages";
import semver from "semver";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const eq = a.indexOf("=");
    return eq === -1 ? [a.replace(/^--/, ""), ""] : [a.slice(2, eq), a.slice(eq + 1)];
  }),
);
const cwd = resolve(args.get("cwd") || process.cwd());
const tag = args.get("tag") || "beta";
// Optional: the name of a synthetic package standing in for a non-npm artifact (e.g. a shared NuGet
// version). Its version is echoed under the extra `nuget` key so callers need not slugify a name.
const nugetPackage = args.get("nuget-package") || "";

// The tag lands inside a semver prerelease identifier and inside $GITHUB_OUTPUT lines, so anything
// outside this set is rejected up front rather than producing an unparseable version or smuggling a
// newline into the step's outputs.
if (!/^[a-zA-Z0-9-]+$/.test(tag)) {
  throw new Error(
    `--tag must be a semver prerelease identifier ([A-Za-z0-9-]), got: ${JSON.stringify(tag)}`,
  );
}

// `@changesets/get-release-plan` ships as CJS; the default export lands one level deep under ESM.
const releasePlanOf = typeof getReleasePlan === "function" ? getReleasePlan : getReleasePlan.default;

const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14); // YYYYMMDDHHmmss, UTC
const { releases } = await releasePlanOf(cwd);
const planned = new Map(releases.map((r) => [r.name, r.newVersion]));
const { packages } = await getPackages(cwd);

// `@bielu/scalar-signalr` -> `bielu_scalar_signalr`. Underscores rather than dashes on purpose:
// GitHub Actions expressions read `-` as subtraction, so a dashed output key could only be read
// back with `outputs['...']` index syntax.
const slugify = (name) => name.replace(/^@/, "").replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase();

const versions = {};
const outputs = new Map();
const rows = [];

for (const pkg of packages) {
  const { name, version: current, private: isPrivate } = pkg.packageJson;
  const plannedVersion = planned.get(name);

  let base;
  let reason;
  if (plannedVersion) {
    base = stripPrerelease(plannedVersion);
    reason = `changesets bump ${current} -> ${plannedVersion}`;
  } else if (semver.prerelease(current)) {
    // Already an unreleased prerelease (e.g. pre mode): its release part is not out yet, so it is
    // a valid base on its own and must not be bumped again.
    base = stripPrerelease(current);
    reason = "no changesets; current version is an unreleased prerelease";
  } else {
    base = semver.inc(current, "patch");
    reason = `no changesets; patch-bumped past the released ${current}`;
  }

  const version = `${base}-${tag}.${stamp}`;
  versions[name] = version;
  outputs.set(slugify(name), version);
  rows.push({ package: name, published: isPrivate ? "no (private)" : "yes", version, reason });
}

// Set the `nuget` alias here rather than inside the loop: a package whose slug is literally `nuget`
// would otherwise occupy the key, and the check below would accept a --nuget-package that matched
// nothing while emitting some other package's version under it.
if (nugetPackage) {
  if (!Object.hasOwn(versions, nugetPackage)) {
    throw new Error(
      `--nuget-package=${nugetPackage} does not match any workspace package. Found: ` +
        Object.keys(versions).join(", "),
    );
  }
  outputs.set("nuget", versions[nugetPackage]);
}

console.table(rows);

// `versions` is the escape hatch for callers whose package set this workflow cannot know up front:
// read it with fromJSON(...)['@scope/name'].
outputs.set("versions", JSON.stringify(versions));

const lines = [...outputs].map(([key, value]) => `${key}=${value}`);
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, { flag: "a" });
} else {
  console.log(lines.join("\n"));
}

function stripPrerelease(version) {
  const parsed = semver.parse(version);
  if (!parsed) throw new Error(`Not a semver version: ${version}`);
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}
