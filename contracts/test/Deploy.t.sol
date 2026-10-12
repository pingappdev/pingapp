// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {PingRouter} from "../src/PingRouter.sol";
import {RevertingRecipient} from "./mocks/RevertingRecipient.sol";

contract DeployScriptTest is Test {
    uint256 internal constant FEE = 50000000000000;
    Deploy internal script;
    address internal signer = makeAddr("signer");
    address internal fees = makeAddr("fees");

    function setUp() public {
        script = new Deploy();
    }

    function testDeploysWithExplicitValues() public {
        PingRouter router = script.deploy(block.chainid, signer, fees, FEE);
        assertEq(router.signer(), signer);
        assertEq(router.feeRecipient(), fees);
        assertEq(router.escrowFee(), FEE);
    }

    function testRejectsWrongChain() public {
        vm.expectRevert(bytes("Deploy: unexpected chain id"));
        script.deploy(block.chainid + 1, signer, fees, FEE);
    }

    function testRejectsContractSigner() public {
        address contractSigner = address(new RevertingRecipient());
        vm.expectRevert(bytes("Deploy: signer must be an EOA"));
        script.deploy(block.chainid, contractSigner, fees, FEE);
    }

    function testRejectsSignerAsFeeRecipient() public {
        vm.expectRevert(bytes("Deploy: signer and fee recipient must differ"));
        script.deploy(block.chainid, signer, signer, FEE);
    }

    function testRejectsFeeRecipientThatRejectsEth() public {
        address rejecting = address(new RevertingRecipient());
        vm.expectRevert(bytes("Deploy: fee recipient rejects ETH"));
        script.deploy(block.chainid, signer, rejecting, FEE);
    }
}
