// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {MockERC20} from "./MockERC20.sol";

contract FeeOnTransferToken is MockERC20 {
    function _update(address from, address to, uint256 value) internal override {
        uint256 fee = from != address(0) && to != address(0) ? value / 100 : 0;
        if (fee > 0) super._update(from, address(0), fee);
        super._update(from, to, value - fee);
    }
}

contract BurnAllToken is MockERC20 {
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, from == address(0) ? to : address(0), value);
    }
}
