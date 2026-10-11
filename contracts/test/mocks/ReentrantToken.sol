// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {MockERC20} from "./MockERC20.sol";

contract ReentrantToken is MockERC20 {
    address public target;
    bytes public payload;
    bool public succeeded;
    bytes public result;
    uint256 public attempts;

    function arm(address target_, bytes memory payload_) external {
        target = target_;
        payload = payload_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (target != address(0) && from != address(0)) {
            attempts++;
            (succeeded, result) = target.call(payload);
        }
    }
}
