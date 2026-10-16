import { buildHistoricalProof, DeploymentProofError } from "./proof.mjs";

try {
  const proof = buildHistoricalProof();
  const {
    creationInput,
    runtimeCode,
    constructorArgs,
    sourceNames,
    sourceHashes,
    ...summary
  } = proof;
  process.stdout.write(
    `${JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        status: "passed",
        scope:
          "Fresh Solidity standard-JSON rebuild of the reviewed 21-source deployment input.",
        ...summary,
        sourceNames,
        sourceHashes,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  const failure =
    error instanceof DeploymentProofError
      ? { code: error.code, message: error.message }
      : {
          code: "BUILD_FAILED",
          message: "Historical deployment rebuild failed.",
        };
  process.stderr.write(`${JSON.stringify({ status: "failed", ...failure })}\n`);
  process.exitCode = 1;
}
