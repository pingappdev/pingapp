// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {Script} from "forge-std/Script.sol";
import {PingRouter} from "../src/PingRouter.sol";

/// @notice Owner-only deployment. Every constructor value is immutable, so each
/// one must be set explicitly and is checked before anything is broadcast.
contract Deploy is Script {
    function run() external returns (PingRouter) {
        return deploy(
            vm.envUint("ROUTER_CHAIN_ID"),
            vm.envAddress("ROUTER_SIGNER"),
            vm.envAddress("ROUTER_FEE_RECIPIENT"),
            vm.envUint("ROUTER_ESCROW_FEE_WEI")
        );
    }

    function deploy(uint256 chainId, address signer, address feeRecipient, uint256 fee)
        public
        returns (PingRouter router)
    {
        require(block.chainid == chainId, "Deploy: unexpected chain id");
        // A contract address can never produce the ECDSA signatures the router checks.
        require(signer.code.length == 0, "Deploy: signer must be an EOA");
        require(signer != feeRecipient, "Deploy: signer and fee recipient must differ");
        _checkAcceptsEth(feeRecipient);
        vm.startBroadcast();
        router = new PingRouter(signer, feeRecipient, fee);
        vm.stopBroadcast();
    }

    /// @dev Simulation only (before broadcast): fees sent to a recipient that
    /// rejects ETH would be stranded forever.
    function _checkAcceptsEth(address to) internal {
        vm.deal(address(this), 1);
        (bool ok,) = to.call{value: 1}("");
        require(ok, "Deploy: fee recipient rejects ETH");
    }
}
