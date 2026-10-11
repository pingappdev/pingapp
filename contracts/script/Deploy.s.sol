// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {Script} from "forge-std/Script.sol";
import {PingRouter} from "../src/PingRouter.sol";

contract Deploy is Script {
    function run() external returns (PingRouter router) {
        address signer = vm.envAddress("ROUTER_SIGNER");
        address feeRecipient = vm.envAddress("ROUTER_FEE_RECIPIENT");
        uint256 fee = vm.envOr("ROUTER_ESCROW_FEE_WEI", uint256(50000000000000));
        vm.startBroadcast();
        router = new PingRouter(signer, feeRecipient, fee);
        vm.stopBroadcast();
    }
}
