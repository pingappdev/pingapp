// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract RevertingRecipient {
    // Allows testing an escrow sender/relayer that subsequently rejects ETH.
    function execute(address target, bytes calldata payload) external payable returns (bytes memory) {
        (bool ok, bytes memory result) = target.call{value: msg.value}(payload);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        return result;
    }
}
