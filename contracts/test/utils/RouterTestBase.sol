// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {PingRouter} from "../../src/PingRouter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

abstract contract RouterTestBase is Test {
    PingRouter internal router;
    MockERC20 internal token;
    uint256 internal signerKey;
    address internal signer;
    address internal sender;
    address internal recipient;
    address internal relayer;
    address internal feeRecipient;
    address internal attacker;
    address internal constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    uint256 internal constant FEE = 0.00005 ether;
    uint256 internal constant TIP = 0.00002 ether;
    bytes32 internal constant ID = keccak256("first send");

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        Vm.Wallet memory wallet = vm.createWallet("router signer");
        signerKey = wallet.privateKey;
        signer = wallet.addr;
        sender = makeAddr("sender");
        recipient = makeAddr("recipient");
        relayer = makeAddr("relayer");
        feeRecipient = makeAddr("fees");
        attacker = makeAddr("attacker");
        router = new PingRouter(signer, feeRecipient, FEE);
        token = new MockERC20();
        vm.deal(sender, 1e32);
        vm.deal(address(this), 1e32);
        token.mint(sender, 1e32);
        vm.prank(sender);
        token.approve(address(router), type(uint256).max);
    }

    function _sendAuth(address asset) internal view returns (PingRouter.SendAuth memory) {
        return PingRouter.SendAuth(ID, sender, recipient, asset, 1e6, block.timestamp + 600);
    }

    function _escrowAuth(address asset) internal view returns (PingRouter.EscrowAuth memory) {
        return
            PingRouter.EscrowAuth(ID, sender, asset, 1e6, TIP, uint64(block.timestamp + 14 days), block.timestamp + 600);
    }

    function _claimAuth() internal view returns (PingRouter.ClaimAuth memory) {
        return PingRouter.ClaimAuth(ID, recipient, relayer, block.timestamp + 600);
    }

    function _sign(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signSend(PingRouter.SendAuth memory a) internal view returns (bytes memory) {
        return _sign(router.hashSendAuth(a));
    }

    function _signEscrow(PingRouter.EscrowAuth memory a) internal view returns (bytes memory) {
        return _sign(router.hashEscrowAuth(a));
    }

    function _signClaim(PingRouter.ClaimAuth memory a) internal view returns (bytes memory) {
        return _sign(router.hashClaimAuth(a));
    }

    function _send(PingRouter.SendAuth memory a) internal {
        bytes memory sig = _signSend(a);
        vm.prank(a.sender);
        router.send{value: a.token == NATIVE ? a.amount : 0}(a, sig);
    }

    function _deposit(PingRouter.EscrowAuth memory a) internal {
        bytes memory sig = _signEscrow(a);
        uint256 value = (a.token == NATIVE ? a.amount : 0) + a.claimTip + router.escrowFee();
        vm.prank(a.sender);
        router.escrow{value: value}(a, sig);
    }

    function _claim(PingRouter.ClaimAuth memory a) internal {
        bytes memory sig = _signClaim(a);
        vm.prank(a.relayer);
        router.claim(a, sig);
    }

    function _expectSend(PingRouter.SendAuth memory a, uint256 value, bytes4 error_) internal {
        bytes memory sig = _signSend(a);
        vm.expectRevert(error_);
        vm.prank(a.sender);
        router.send{value: value}(a, sig);
    }

    function _expectEscrow(PingRouter.EscrowAuth memory a, uint256 value, bytes4 error_) internal {
        bytes memory sig = _signEscrow(a);
        vm.expectRevert(error_);
        vm.prank(a.sender);
        router.escrow{value: value}(a, sig);
    }

    function _expectClaim(PingRouter.ClaimAuth memory a, bytes4 error_) internal {
        bytes memory sig = _signClaim(a);
        vm.expectRevert(error_);
        vm.prank(a.relayer);
        router.claim(a, sig);
    }

    function _assertOpen(PingRouter.EscrowAuth memory a, uint256 received) internal view {
        (address from, uint64 expires, address asset, uint256 amount, uint256 tip) = router.escrows(a.id);
        assertEq(from, a.sender);
        assertEq(expires, a.expiresAt);
        assertEq(asset, a.token);
        assertEq(amount, received);
        assertEq(tip, a.claimTip);
        assertTrue(router.usedIds(a.id));
    }

    function _assertClosed(bytes32 id) internal view {
        (address from,,,,) = router.escrows(id);
        assertEq(from, address(0));
        assertTrue(router.usedIds(id));
    }
}
