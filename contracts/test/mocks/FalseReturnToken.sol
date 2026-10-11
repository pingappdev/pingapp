// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {MockERC20} from "./MockERC20.sol";

contract FalseReturnToken is MockERC20 {
    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}
