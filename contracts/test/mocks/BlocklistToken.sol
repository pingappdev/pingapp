// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {MockERC20} from "./MockERC20.sol";

contract BlocklistToken is MockERC20 {
    mapping(address => bool) public blocked;
    error Blocked();

    function setBlocked(address who, bool value) external {
        blocked[who] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from] || blocked[to]) revert Blocked();
        super._update(from, to, value);
    }
}
