import { execFileSync, execSync } from "child_process";
import { fileURLToPath } from "url";

const lernaCli = fileURLToPath(import.meta.resolve("lerna/cli"));

/**
 * Run a lerna CLI command using the locally installed version of lerna.
 */
function runLerna(args) {
  execFileSync(process.execPath, [lernaCli, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
}

/**
 * Publish the packages, retrying on failure. `lerna publish from-package` only
 * publishes versions that are missing from the registry, so retrying after a
 * partial failure is safe.
 */
function publishWithRetry(attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Uploads are serialized because the platform packages contain large
      // native binaries. Publishing them in parallel (lerna's default is one
      // upload per CPU core) makes the npm registry drop connections while the
      // request body is still being written, which might surface as `write EPIPE`.
      runLerna(["publish", "from-package", "--yes", "--concurrency", "1"]);
      return;
    } catch (error) {
      if (attempt === attempts) {
        throw error;
      }
      console.warn(`⚠️  Publish attempt ${attempt} failed, retrying (${attempt + 1}/${attempts})...`);
    }
  }
}

/**
 * Define a static set of versions that are supported. This means that only new
 * binaries for these versions will be released.
 */
const supportedVersions = ["14.24.0", "15.19.0", "16.15.0", "17.11.0", "18.6.0"];

/**
 * Accept a particular affix that should be appended to the version number. The
 * affix will be automatically prefixed with `-`
 */
const affix = process.argv[2] ? `-${process.argv[2]}` : "";

/**
 * Parse --versions flag from argv, e.g. --versions 16.13.0,17.9.0,18.3.0
 */
function parseVersionsArg() {
  const versionsFlag = process.argv.indexOf("--versions");
  if (versionsFlag === -1) {
    return null;
  }
  const value = process.argv[versionsFlag + 1];
  if (!value || value.startsWith("--")) {
    console.error("❌ --versions flag requires a comma-separated list of versions, e.g. --versions 16.13.0,17.9.0");
    process.exit(1);
  }
  return value.split(",").map((v) => v.trim());
}

/**
 * Verify that the user is authenticated with npm. Exits the process if not.
 */
function checkNpmAuth() {
  try {
    const user = execSync("npm whoami", { stdio: "pipe" }).toString().trim();
    console.log(`✅ Logged in to npm as: ${user}`);
  } catch {
    console.error("❌ Not logged in to npm. Please run `npm login` before releasing.");
    process.exit(1);
  }
}

/**
 * Verify that the package README matches the root README. NPM renders the
 * package README on the package page, so the two must not drift apart.
 * Exits the process if they differ.
 */
function checkReadmesMatch() {
  try {
    execFileSync(
      "git",
      ["diff", "--no-index", "--", "README.md", "packages/embedded-postgres/README.md"],
      { stdio: "pipe" },
    );
  } catch (error) {
    if (error.status === 1) {
      console.error("❌ The root README and packages/embedded-postgres/README.md have diverged:");
      console.error(error.stdout.toString());
      process.exit(1);
    }
    throw error;
  }
  console.log("✅ READMEs are in sync.");
}

/**
 * Verify that the working tree has no uncommitted changes. Exits the process if dirty.
 */
function checkCleanWorkingTree() {
  const output = execSync("git status --porcelain", { stdio: "pipe" }).toString().trim();
  if (output.length > 0) {
    console.error("❌ Working tree has uncommitted changes. Please commit or stash them before releasing:");
    console.error(output);
    process.exit(1);
  }
  console.log("✅ Working tree is clean.");
}

/**
 * Main executor function
 */
async function main() {
  // Run pre-flight checks before touching anything
  console.log("🔍 Running pre-flight checks...");
  checkNpmAuth();
  checkCleanWorkingTree();
  checkReadmesMatch();
  console.log("✅ All pre-flight checks passed.\n");

  // Determine which versions to release
  const versions = parseVersionsArg() ?? supportedVersions;

  if (parseVersionsArg()) {
    console.log(`ℹ️  Using versions from --versions flag: ${versions.join(", ")}`);
  }

  // Loop through each version
  for await (let pgVersion of versions) {
    // Create version number from pgVersion and affix
    const version = `${pgVersion}${affix}`;
    const [major, minor, patch] = pgVersion.split(".");

    // Log start
    console.log(`🔄 Processing v${version}...`);

    // Compile the scripts in all repositories
    runLerna(["run", "build"]);

    // Download the new versions in all repositories
    runLerna(["run", "download", "--parallel", "--", pgVersion, "--all"]);

    // Release the newly downloaded releases
    runLerna(["version", version, "--yes", "--force-publish"]);

    // Publish the packages
    publishWithRetry();

    // Log success
    console.log(`✅ Processing v${version} complete.`);
  }
}

main();
