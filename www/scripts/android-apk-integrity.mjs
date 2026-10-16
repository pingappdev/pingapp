#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, constants, createReadStream, readdirSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const usage = `Android APK integrity metadata (read-only; does not sign or modify APKs)

Signed release metadata:
  node android-apk-integrity.mjs generate-signed \\
    --apk <file.apk> --version <version> --asset-url <pinned-release-url> --output <file.json>
  node android-apk-integrity.mjs verify-signed --apk <file.apk> --manifest <file.json>

Unsigned CI build metadata:
  node android-apk-integrity.mjs generate-unsigned \\
    --apk <file.apk> --source-revision <full-git-sha> --output <file.json>
  node android-apk-integrity.mjs verify-unsigned --apk <file.apk> --manifest <file.json>

Options --apksigner and --aapt can select Android SDK Build Tools explicitly.
They are otherwise resolved from PATH, ANDROID_HOME, or ANDROID_SDK_ROOT.
`;

function fail(message) {
  throw new Error(message);
}

function parseArgs(args) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage);
    process.exit(0);
  }

  const options = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!flag.startsWith("--")) fail(`Unexpected argument: ${flag}`);
    const name = flag.slice(2);
    if (options.has(name)) fail(`Option repeated: ${flag}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for ${flag}`);
    options.set(name, value);
    index += 1;
  }

  return { command, options };
}

function option(options, name, required = true) {
  const value = options.get(name);
  if (!value && required) fail(`Required option missing: --${name}`);
  return value;
}

function checkOptions(options, allowed) {
  for (const name of options.keys()) {
    if (!allowed.has(name)) fail(`Unknown option: --${name}`);
  }
}

function resolveTool(explicit, environmentName, toolName) {
  const configured = explicit ?? process.env[environmentName];
  if (configured) {
    if (configured.endsWith(path.sep + "build-tools")) {
      const toolPath = findSdkToolPath(configured, toolName);
      if (toolPath) return toolPath;
      fail(`${environmentName} does not contain an executable ${toolName}: ${configured}`);
    }
    try {
      accessSync(configured, constants.X_OK);
      return configured;
    } catch {
      fail(`${environmentName} path is not an executable file: ${configured}`);
    }
  }

  for (const sdkRoot of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (!sdkRoot) continue;
    const toolPath = findSdkToolPath(path.join(sdkRoot, "build-tools"), toolName);
    if (toolPath) return toolPath;
  }

  return toolName;
}

function findSdkToolPath(buildToolsRoot, toolName) {
  try {
    // Search newest installed Build Tools first; callers can pin an exact
    // SDK path through --apksigner/--aapt when a specific tool is required.
    const versions = readdirSync(buildToolsRoot).sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true }),
    );
    for (const version of versions) {
      const toolPath = path.join(buildToolsRoot, version, toolName);
      try {
        accessSync(toolPath, constants.X_OK);
        return toolPath;
      } catch {
        // Keep looking through installed SDK Build Tools versions.
      }
    }
  } catch {
    // This SDK root is absent or incomplete; try the other one or PATH.
  }
  return undefined;
}

function runTool(tool, args, purpose) {
  const result = spawnSync(tool, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error?.code === "ENOENT") {
    fail(`${purpose}: ${tool} is not available; install Android SDK Build Tools or pass its path`);
  }
  if (result.error) fail(`${purpose}: ${result.error.message}`);
  return result;
}

async function artifactDigest(apkPath) {
  let info;
  try {
    info = await stat(apkPath);
  } catch {
    fail(`APK not found: ${apkPath}`);
  }
  if (!info.isFile() || info.size < 1) fail("APK path must be a nonempty regular file");

  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(apkPath)) hash.update(chunk);
  } catch (error) {
    fail(`Could not read APK: ${error.message}`);
  }

  return { fileName: path.basename(apkPath), sizeBytes: info.size, sha256: hash.digest("hex") };
}

function validateVersion(version) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(version ?? "")) {
    fail(
      "Version must be a nonempty release identifier using letters, numbers, '.', '+', '_' or '-'",
    );
  }
  return version;
}

function validatePinnedAssetUrl(assetUrl, version, fileName) {
  let parsed;
  try {
    parsed = new URL(assetUrl);
  } catch {
    fail("Asset URL must be an absolute HTTPS URL");
  }
  if (parsed.protocol !== "https:") fail("Asset URL must use HTTPS");
  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  const releaseIndex = segments.findIndex(
    (segment, index) => segment === "releases" && segments[index + 1] === "download",
  );
  if (releaseIndex < 0 || segments[releaseIndex + 2] !== version) {
    fail(`Asset URL must be pinned to the /releases/download/${version}/ tag`);
  }
  if (segments.at(-1) !== fileName) fail("Asset URL filename must match the APK filename");
  return parsed.toString();
}

function signerCertificate(apkPath, explicitApksigner) {
  const apksigner = resolveTool(explicitApksigner, "APKSIGNER", "apksigner");
  const result = runTool(
    apksigner,
    ["verify", "--verbose", "--print-certs", apkPath],
    "APK signature verification failed",
  );
  if (result.status !== 0) {
    fail(
      `APK signature verification failed: ${(result.stderr || result.stdout).trim() || "apksigner returned a failure"}`,
    );
  }
  if (!/^Verifies$/m.test(result.stdout)) fail("apksigner did not confirm the APK signature");
  if (!/^Number of signers: 1$/m.test(result.stdout)) fail("Expected exactly one APK signer");

  const match = result.stdout.match(/^Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F:]+)$/m);
  const certificateSha256 = match?.[1].replaceAll(":", "").toLowerCase();
  if (!certificateSha256 || !/^[0-9a-f]{64}$/.test(certificateSha256)) {
    fail("Could not read the signer's SHA-256 certificate fingerprint");
  }
  return certificateSha256;
}

async function writeJson(outputPath, data, apkPath) {
  if (path.resolve(outputPath) === path.resolve(apkPath))
    fail("Metadata output must not overwrite the APK");
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
}

async function readManifest(manifestPath) {
  let value;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail(`Could not read valid metadata JSON: ${error.message}`);
  }
  if (value?.schemaVersion !== 1 || !value.artifact || !value.signature) {
    fail("Unsupported or incomplete APK metadata schema");
  }
  return value;
}

async function generateSigned(options) {
  checkOptions(options, new Set(["apk", "version", "asset-url", "output", "apksigner"]));
  const apkPath = option(options, "apk");
  const digest = await artifactDigest(apkPath);
  const version = validateVersion(option(options, "version"));
  const assetUrl = validatePinnedAssetUrl(option(options, "asset-url"), version, digest.fileName);
  const certificateSha256 = signerCertificate(apkPath, option(options, "apksigner", false));
  const manifest = {
    schemaVersion: 1,
    artifact: { ...digest, version, assetUrl },
    signature: { status: "verified", signerCount: 1, certificateSha256 },
    provenance: { status: "not-established-by-this-manifest" },
  };
  await writeJson(option(options, "output"), manifest, apkPath);
  process.stdout.write(`Wrote signed APK identity metadata for ${digest.fileName}\n`);
}

async function verifySigned(options) {
  checkOptions(options, new Set(["apk", "manifest", "apksigner"]));
  const apkPath = option(options, "apk");
  const manifest = await readManifest(option(options, "manifest"));
  const artifact = manifest.artifact;
  const version = validateVersion(artifact.version);
  validatePinnedAssetUrl(artifact.assetUrl, version, artifact.fileName);
  if (
    manifest.signature.status !== "verified" ||
    manifest.signature.signerCount !== 1 ||
    !/^[0-9a-f]{64}$/.test(manifest.signature.certificateSha256 ?? "")
  ) {
    fail("Metadata must pin one verified APK signer certificate");
  }

  const actual = await artifactDigest(apkPath);
  if (actual.fileName !== artifact.fileName) fail("APK filename does not match metadata");
  if (actual.sizeBytes !== artifact.sizeBytes)
    fail(`APK size does not match metadata (${actual.sizeBytes} bytes)`);
  if (actual.sha256 !== artifact.sha256) fail("APK SHA-256 does not match metadata");
  const certificateSha256 = signerCertificate(apkPath, option(options, "apksigner", false));
  if (certificateSha256 !== manifest.signature.certificateSha256) {
    fail("APK signer certificate SHA-256 does not match metadata");
  }
  process.stdout.write(`Verified signed APK identity and certificate for ${artifact.version}\n`);
}

function manifestPackage(apkPath, explicitAapt) {
  const aapt = resolveTool(explicitAapt, "AAPT", "aapt");
  const result = runTool(aapt, ["dump", "badging", apkPath], "APK manifest inspection failed");
  if (result.status !== 0)
    fail(`aapt could not inspect APK: ${(result.stderr || result.stdout).trim()}`);
  const match = result.stdout.match(
    /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']*)'/m,
  );
  if (!match) fail("aapt did not report Android package name and version");
  return { packageName: match[1], versionCode: Number(match[2]), versionName: match[3] };
}

function assertUnsigned(apkPath, explicitApksigner) {
  const apksigner = resolveTool(explicitApksigner, "APKSIGNER", "apksigner");
  const result = runTool(
    apksigner,
    ["verify", "--verbose", "--print-certs", apkPath],
    "Unsigned APK verification failed",
  );
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !/^DOES NOT VERIFY$/m.test(output)) {
    fail(
      "Expected a valid APK without a signing certificate; it is signed or apksigner could not classify it",
    );
  }
}

async function generateUnsigned(options) {
  checkOptions(
    options,
    new Set(["apk", "source-revision", "expected-package", "output", "apksigner", "aapt"]),
  );
  const apkPath = option(options, "apk");
  const sourceRevision = option(options, "source-revision").toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceRevision)) {
    fail("Source revision must be a full 40-character Git SHA or 64-character Git object id");
  }
  const digest = await artifactDigest(apkPath);
  const androidManifest = manifestPackage(apkPath, option(options, "aapt", false));
  if (
    option(options, "expected-package", false) &&
    androidManifest.packageName !== options.get("expected-package")
  ) {
    fail(`Unexpected Android package: ${androidManifest.packageName}`);
  }
  assertUnsigned(apkPath, option(options, "apksigner", false));
  const manifest = {
    schemaVersion: 1,
    artifact: { ...digest, androidManifest },
    signature: { status: "unsigned" },
    sourceRevision,
    provenance: { status: "not-established-by-this-sidecar", attestationSubject: digest.fileName },
  };
  await writeJson(option(options, "output"), manifest, apkPath);
  process.stdout.write(`Wrote digest metadata for unsigned APK ${digest.fileName}\n`);
}

async function verifyUnsigned(options) {
  checkOptions(options, new Set(["apk", "manifest", "apksigner", "aapt"]));
  const apkPath = option(options, "apk");
  const manifest = await readManifest(option(options, "manifest"));
  const artifact = manifest.artifact;
  if (
    manifest.signature.status !== "unsigned" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(manifest.sourceRevision ?? "")
  ) {
    fail("Metadata does not describe an unsigned CI APK with a full source revision");
  }
  const actual = await artifactDigest(apkPath);
  if (actual.fileName !== artifact.fileName) fail("APK filename does not match metadata");
  if (actual.sizeBytes !== artifact.sizeBytes)
    fail(`APK size does not match metadata (${actual.sizeBytes} bytes)`);
  if (actual.sha256 !== artifact.sha256) fail("APK SHA-256 does not match metadata");
  const androidManifest = manifestPackage(apkPath, option(options, "aapt", false));
  if (JSON.stringify(androidManifest) !== JSON.stringify(artifact.androidManifest)) {
    fail("Android package identity does not match metadata");
  }
  assertUnsigned(apkPath, option(options, "apksigner", false));
  process.stdout.write(`Verified unsigned APK identity for ${manifest.sourceRevision}\n`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "generate-signed":
      await generateSigned(options);
      break;
    case "verify-signed":
      await verifySigned(options);
      break;
    case "generate-unsigned":
      await generateUnsigned(options);
      break;
    case "verify-unsigned":
      await verifyUnsigned(options);
      break;
    default:
      fail(`Unknown command: ${command}\n\n${usage}`);
  }
}

main().catch((error) => {
  process.stderr.write(`APK integrity check failed: ${error.message}\n`);
  process.exitCode = 1;
});
