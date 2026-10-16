import {
  DEFAULT_RPC_URL,
  DeploymentProofError,
  verifyDeployment,
} from "./proof.mjs";

function parseRpcUrl(args) {
  let rpcUrl = DEFAULT_RPC_URL;
  let seenRpcUrl = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--rpc-url" || !args[index + 1] || seenRpcUrl) {
      throw new DeploymentProofError(
        "USAGE",
        "Usage: node post-deploy-check.mjs [--rpc-url https://public-rpc].",
      );
    }
    rpcUrl = args[index + 1];
    seenRpcUrl = true;
    index += 1;
  }
  let parsed;
  try {
    parsed = new URL(rpcUrl);
  } catch (error) {
    throw new DeploymentProofError(
      "USAGE",
      "RPC URL must be a valid HTTPS URL.",
      { cause: error },
    );
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new DeploymentProofError(
      "USAGE",
      "Use an HTTPS public RPC URL without embedded credentials.",
    );
  }
  return rpcUrl;
}

try {
  const rpcUrl = parseRpcUrl(process.argv.slice(2));
  const proof = await verifyDeployment({ rpcUrl });
  process.stdout.write(
    `${JSON.stringify({ status: "passed", ...proof }, null, 2)}\n`,
  );
} catch (error) {
  const failure =
    error instanceof DeploymentProofError
      ? { code: error.code, message: error.message }
      : { code: "CHECK_FAILED", message: "Read-only deployment proof failed." };
  process.stderr.write(`${JSON.stringify({ status: "failed", ...failure })}\n`);
  process.exitCode = 1;
}
