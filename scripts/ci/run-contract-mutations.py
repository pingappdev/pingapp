#!/usr/bin/env python3
"""Run critical PingRouter mutants on a temporary copy of the contracts tree."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


IMAGE_DEFAULT = (
    "ghcr.io/foundry-rs/foundry:v1.5.1@sha256:"
    "3a70bfa9bd2c732a767bb60d12c8770b40e8f9b6cca28efc4b12b1be81c7f28e"
)
SEED = "11587915885060689942"
ROUTER_PATH = Path("src/PingRouter.sol")
EIP712_PATH = Path("lib/openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol")


@dataclass(frozen=True)
class Mutant:
    identifier: str
    category: str
    source_path: str
    target_test: str
    old_text: str
    new_text: str
    scope_start: str | None = None
    scope_end: str | None = None


def mutants() -> list[Mutant]:
    return [
        Mutant(
            "claim-recipient-to-relayer",
            "recipient authorization",
            str(ROUTER_PATH),
            "testAttackerCannotRetargetVictimClaimOrTakeTip",
            "_payToken(e.token, a.recipient, e.amount);",
            "_payToken(e.token, a.relayer, e.amount);",
            "function claim(",
            "function refund(",
        ),
        Mutant(
            "remove-relayer-caller-check",
            "relayer authorization",
            str(ROUTER_PATH),
            "testAttackerCannotRetargetVictimClaimOrTakeTip",
            "if (msg.sender != a.relayer) revert NotRelayer();",
            "",
            "function claim(",
            "function refund(",
        ),
        Mutant(
            "claim-tip-to-recipient",
            "relayer tip ownership",
            str(ROUTER_PATH),
            "testAttackerCannotRetargetVictimClaimOrTakeTip",
            "_payEth(a.relayer, e.claimTip);",
            "_payEth(a.recipient, e.claimTip);",
            "function claim(",
            "function refund(",
        ),
        Mutant(
            "domain-chain-id-constant",
            "EIP-712 chain domain",
            str(EIP712_PATH),
            "testCrossChainReplay",
            "_hashedVersion, block.chainid, address(this)",
            "_hashedVersion, uint256(0), address(this)",
            "function _buildDomainSeparator()",
            "function _EIP712Name()",
        ),
        Mutant(
            "domain-contract-constant",
            "EIP-712 contract domain",
            str(EIP712_PATH),
            "testCrossDeploymentReplay",
            "_hashedVersion, block.chainid, address(this)",
            "_hashedVersion, block.chainid, address(0)",
            "function _buildDomainSeparator()",
            "function _EIP712Name()",
        ),
        Mutant(
            "escrow-type-hash-to-send",
            "typed-data type separation",
            str(ROUTER_PATH),
            "testIndependentTypedDataDigests",
            "abi.encode(ESCROW_TYPEHASH, a.id",
            "abi.encode(SEND_TYPEHASH, a.id",
            "function _hashEscrowAuth(",
            "function _hashClaimAuth(",
        ),
        Mutant(
            "claim-type-hash-to-send",
            "typed-data type separation",
            str(ROUTER_PATH),
            "testIndependentTypedDataDigests",
            "abi.encode(CLAIM_TYPEHASH, a.id, a.recipient",
            "abi.encode(SEND_TYPEHASH, a.id, a.recipient",
            "function _hashClaimAuth(",
            "function _verify(",
        ),
        Mutant(
            "claim-recipient-omitted-from-signed-fields",
            "typed-data field binding",
            str(ROUTER_PATH),
            "testAttackerCannotRetargetVictimClaimOrTakeTip",
            "a.id, a.recipient, a.relayer, a.deadline",
            "a.id, a.relayer, a.relayer, a.deadline",
            "function _hashClaimAuth(",
            "function _verify(",
        ),
        Mutant(
            "remove-send-used-id-check",
            "replay protection",
            str(ROUTER_PATH),
            "testUsedIdsSharedAcrossSendAndEscrow",
            "if (usedIds[a.id]) revert IdUsed();",
            "",
            "function send(",
            "function escrow(",
        ),
        Mutant(
            "remove-escrow-used-id-check",
            "replay protection",
            str(ROUTER_PATH),
            "testUsedIdsSharedAcrossSendAndEscrow",
            "if (usedIds[a.id]) revert IdUsed();",
            "",
            "function escrow(",
            "function claim(",
        ),
        Mutant(
            "claim-allowed-at-expiry",
            "claim expiry boundary",
            str(ROUTER_PATH),
            "testClaimExpiryBoundary",
            "if (block.timestamp >= e.expiresAt) revert EscrowExpired();",
            "if (block.timestamp > e.expiresAt) revert EscrowExpired();",
            "function claim(",
            "function refund(",
        ),
        Mutant(
            "refund-rejected-at-expiry",
            "refund expiry boundary",
            str(ROUTER_PATH),
            "testRefundNativeAtBoundaryPaysSenderOnly",
            "if (block.timestamp < e.expiresAt) revert NotExpired();",
            "if (block.timestamp <= e.expiresAt) revert NotExpired();",
            "function refund(",
            "function withdrawOwed(",
        ),
        Mutant(
            "fee-on-transfer-requested-amount",
            "received-balance accounting",
            str(ROUTER_PATH),
            "testEscrowFeeOnTransferStoresReceived",
            "received = token.balanceOf(address(this)) - beforeBalance;",
            "received = a.amount;",
            "function escrow(",
            "function claim(",
        ),
        Mutant(
            "accept-zero-received-token",
            "received-balance accounting",
            str(ROUTER_PATH),
            "testEscrowNothingReceivedReverts",
            "if (received == 0) revert NothingReceived();",
            "if (false) revert NothingReceived();",
            "function escrow(",
            "function claim(",
        ),
        Mutant(
            "uncredited-withdraw-uses-total-owed",
            "owed-credit ownership",
            str(ROUTER_PATH),
            "testWithdrawOwedOnlyByCreditedSenderToChosenAddress",
            "uint256 amount = owedEth[msg.sender];",
            "uint256 amount = totalOwed;",
            "function withdrawOwed(",
            "function withdrawFees(",
        ),
        Mutant(
            "omit-total-owed-decrement",
            "owed-liability accounting",
            str(ROUTER_PATH),
            "testWithdrawOwedOnlyByCreditedSenderToChosenAddress",
            "totalOwed -= amount;",
            "",
            "function withdrawOwed(",
            "function withdrawFees(",
        ),
        Mutant(
            "omit-fee-accrual-reset",
            "fee liability accounting",
            str(ROUTER_PATH),
            "testWithdrawFeesAnyoneAndZeroSecondCall",
            "feesAccrued = 0;",
            "",
            "function withdrawFees(",
            "function hashSendAuth(",
        ),
        Mutant(
            "skip-signer-verification",
            "signature authorization",
            str(ROUTER_PATH),
            "testEscrowSignatureCannotAuthorizeSend",
            "if (recovered != signer) revert BadSignature();",
            "if (false) revert BadSignature();",
            "function _verify(",
            "function _payToken(",
        ),
        Mutant(
            "claim-does-not-delete-escrow",
            "claim finalization",
            str(ROUTER_PATH),
            "testClaimUnknownDoubleAndAfterRefund",
            "delete escrows[a.id];",
            "",
            "function claim(",
            "function refund(",
        ),
        Mutant(
            "refund-does-not-delete-escrow",
            "refund finalization",
            str(ROUTER_PATH),
            "testRefundUnknownDoubleAndAfterClaim",
            "delete escrows[id];",
            "",
            "function refund(",
            "function withdrawOwed(",
        ),
    ]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one mutation anchor, found {count}")
    return text.replace(old, new, 1)


def apply_mutation(source: str, mutant: Mutant) -> str:
    if mutant.scope_start is None:
        return replace_once(source, mutant.old_text, mutant.new_text, mutant.identifier)
    start = source.find(mutant.scope_start)
    if start < 0:
        raise RuntimeError(f"{mutant.identifier}: missing scope start")
    end = source.find(mutant.scope_end or "", start + len(mutant.scope_start))
    if end < 0:
        raise RuntimeError(f"{mutant.identifier}: missing scope end")
    scoped = source[start:end]
    changed = replace_once(scoped, mutant.old_text, mutant.new_text, mutant.identifier)
    return source[:start] + changed + source[end:]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def verify_baseline(log_path: Path, entries: list[Mutant]) -> None:
    if not log_path.is_file():
        raise RuntimeError(f"missing baseline Foundry test log: {log_path}")
    text = log_path.read_text(encoding="utf-8")
    missing = sorted({entry.target_test for entry in entries if not re.search(rf"\[PASS\] {re.escape(entry.target_test)}\(", text)})
    if missing:
        raise RuntimeError(f"baseline log does not show target tests passing: {', '.join(missing)}")


def run_mutant(
    mutant: Mutant,
    contract_tree: Path,
    runtime: Path,
    image: str,
    docker_cmd: list[str],
    uid: int,
    gid: int,
) -> tuple[str, str]:
    command = [
        *docker_cmd,
        "run",
        "--rm",
        "--cpus=1",
        "--memory=3g",
        "--user",
        f"{uid}:{gid}",
        "--env",
        "HOME=/ci-runtime",
        "--env",
        "NO_COLOR=1",
        "--env",
        "FOUNDRY_PROFILE=ci",
        "--volume",
        f"{runtime}:/ci-runtime",
        "--volume",
        f"{contract_tree}:/work",
        "--workdir",
        "/work",
        "--entrypoint",
        "forge",
        image,
        "test",
        "--match-path",
        "test/PingRouter.t.sol",
        "--match-test",
        mutant.target_test,
        "--fuzz-seed",
        SEED,
        "--out",
        f"/ci-runtime/out/{mutant.identifier}",
        "--cache-path",
        f"/ci-runtime/cache/{mutant.identifier}",
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=240, check=False)
    output = result.stdout + result.stderr
    if "Compiler run failed" in output or "Compiler error" in output or "failed to compile" in output.lower():
        return "compile_error", output
    test_match = re.search(rf"\[(PASS|FAIL)(?:\.|:)?[^\]]*\] {re.escape(mutant.target_test)}\(\)", output)
    if not test_match:
        if result.returncode != 0:
            return "execution_error", output
        return "missing_test", output
    if test_match.group(1) == "FAIL":
        return "killed", output
    if result.returncode == 0:
        return "survived", output
    return "execution_error", output


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]
    contracts_root = repo_root / "contracts"
    evidence_dir_value = os.environ.get("CI_EVIDENCE_DIR")
    if not evidence_dir_value:
        print("CI_EVIDENCE_DIR is required for mutation result retention.", file=sys.stderr)
        return 2
    evidence_dir = Path(evidence_dir_value).resolve()
    evidence_dir.mkdir(parents=True, exist_ok=True)
    log_dir = evidence_dir / "mutation-logs"
    log_dir.mkdir(parents=True, exist_ok=True)

    entries = mutants()
    baseline_log = Path(os.environ.get("AUD08_BASELINE_LOG", evidence_dir / "foundry-test.log"))
    try:
        verify_baseline(baseline_log, entries)
    except RuntimeError as exc:
        print(f"AUD-08 mutation gate failed: {exc}", file=sys.stderr)
        return 1

    image = os.environ.get("FOUNDRY_IMAGE", IMAGE_DEFAULT)
    if "@sha256:" not in image:
        print("AUD-08 mutation gate requires a digest-pinned Foundry image.", file=sys.stderr)
        return 1
    docker_cmd = shlex.split(os.environ.get("DOCKER", "docker"))
    if not docker_cmd:
        print("DOCKER command is empty.", file=sys.stderr)
        return 1

    source_hashes = {
        str(ROUTER_PATH): sha256((contracts_root / ROUTER_PATH).read_bytes()),
        str(EIP712_PATH): sha256((contracts_root / EIP712_PATH).read_bytes()),
    }
    original_source = {
        str(ROUTER_PATH): (contracts_root / ROUTER_PATH).read_bytes(),
        str(EIP712_PATH): (contracts_root / EIP712_PATH).read_bytes(),
    }

    results: list[dict[str, object]] = []
    uid, gid = os.getuid(), os.getgid()
    copy_unchanged = False
    with tempfile.TemporaryDirectory(prefix="pingapp-aud08-mutants-") as temp:
        temp_root = Path(temp)
        contract_tree = temp_root / "contracts"
        shutil.copytree(
            contracts_root,
            contract_tree,
            ignore=shutil.ignore_patterns("out", "cache", "broadcast"),
        )
        runtime = temp_root / "runtime"
        runtime.mkdir()

        for mutant in entries:
            # Reset the only two files this suite mutates before applying each isolated variant.
            for relative_path, content in original_source.items():
                (contract_tree / relative_path).write_bytes(content)
            target_path = contract_tree / mutant.source_path
            source_text = target_path.read_text(encoding="utf-8")
            target_path.write_text(apply_mutation(source_text, mutant), encoding="utf-8")

            try:
                status, output = run_mutant(mutant, contract_tree, runtime, image, docker_cmd, uid, gid)
            except (OSError, subprocess.TimeoutExpired) as exc:
                status, output = "execution_error", f"{type(exc).__name__}: {exc}"
            log_path = log_dir / f"{mutant.identifier}.log"
            log_path.write_text(output, encoding="utf-8")
            results.append(
                {
                    "id": mutant.identifier,
                    "category": mutant.category,
                    "targetTest": mutant.target_test,
                    "mutatedFile": mutant.source_path,
                    "status": status,
                    "log": str(log_path.name),
                }
            )
            print(f"AUD08_MUTATION {mutant.identifier} status={status} target={mutant.target_test}")

        # Restore the disposable source tree and verify it before TemporaryDirectory removes it.
        for relative_path, content in original_source.items():
            (contract_tree / relative_path).write_bytes(content)
        copy_unchanged = all(
            sha256((contract_tree / relative_path).read_bytes()) == digest
            for relative_path, digest in source_hashes.items()
        )

    unchanged = all(sha256((contracts_root / rel).read_bytes()) == digest for rel, digest in source_hashes.items())
    if not unchanged or not copy_unchanged:
        print("AUD-08 mutation gate detected a source tree that was not restored to its original bytes.", file=sys.stderr)

    viable = [item for item in results if item["status"] in {"killed", "survived"}]
    killed = [item for item in viable if item["status"] == "killed"]
    survivors = [item for item in viable if item["status"] == "survived"]
    invalid = [item for item in results if item["status"] not in {"killed", "survived"}]
    score = len(killed) / len(viable) if viable else 0.0
    report = {
        "schemaVersion": 1,
        "scope": "finite curated critical mutation set; not an exhaustive mutation score for the codebase",
        "requestedFuzzSeed": SEED,
        "foundryImage": image,
        "baselineTargetsVerified": len({entry.target_test for entry in entries}),
        "sourceHashes": source_hashes,
        "realCheckoutUnchanged": unchanged,
        "disposableCopyRestoredBeforeRemoval": copy_unchanged,
        "totals": {
            "proposed": len(entries),
            "viable": len(viable),
            "killed": len(killed),
            "survivors": len(survivors),
            "invalidOrCompileErrors": len(invalid),
            "score": round(score, 4),
        },
        "mutants": results,
        "survivors": survivors,
        "equivalentMutants": [],
    }
    report_path = evidence_dir / "mutation-report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if not unchanged or not copy_unchanged or invalid or survivors or score < 0.90 or len(killed) != len(entries):
        print(
            f"AUD-08 mutation gate failed: {len(killed)}/{len(entries)} killed, "
            f"{len(invalid)} invalid, {len(survivors)} survivors; report={report_path}",
            file=sys.stderr,
        )
        return 1
    print(
        f"AUD-08 mutation gate passed: {len(killed)}/{len(entries)} critical mutants killed; "
        f"report={report_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
