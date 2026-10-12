// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {RouterTestBase} from "./utils/RouterTestBase.sol";
import {Vm} from "forge-std/Vm.sol";
import {PingRouter} from "../src/PingRouter.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {NoReturnToken} from "./mocks/NoReturnToken.sol";
import {FalseReturnToken} from "./mocks/FalseReturnToken.sol";
import {FeeOnTransferToken, BurnAllToken} from "./mocks/FeeOnTransferToken.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";
import {RevertingRecipient} from "./mocks/RevertingRecipient.sol";
import {BlocklistToken} from "./mocks/BlocklistToken.sol";

contract PingRouterTest is RouterTestBase {
    function testConstantsAndConstructor() public view {
        assertEq(router.NATIVE(), NATIVE);
        assertEq(router.MIN_ESCROW_DURATION(), 1 days);
        assertEq(router.MAX_ESCROW_DURATION(), 60 days);
        assertEq(router.MAX_CLAIM_TIP(), 0.001 ether);
        assertEq(router.MAX_ESCROW_FEE(), 0.001 ether);
        assertEq(router.signer(), signer);
        assertEq(router.feeRecipient(), feeRecipient);
        assertEq(router.escrowFee(), FEE);
    }

    function testConstructorRejectsInvalidSettings() public {
        vm.expectRevert(PingRouter.BadRecipient.selector);
        new PingRouter(address(0), feeRecipient, FEE);
        vm.expectRevert(PingRouter.BadRecipient.selector);
        new PingRouter(signer, address(0), FEE);
        vm.expectRevert(PingRouter.BadValue.selector);
        new PingRouter(signer, feeRecipient, 0.001 ether + 1);
        new PingRouter(signer, feeRecipient, 0.001 ether);
        new PingRouter(signer, feeRecipient, 0);
    }

    function testIndependentTypedDataDigests() public view {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("PingRouter"),
                keccak256("1"),
                block.chainid,
                address(router)
            )
        );
        PingRouter.SendAuth memory s = _sendAuth(NATIVE);
        bytes32 sh = keccak256(
            abi.encode(
                keccak256(
                    "SendAuth(bytes32 id,address sender,address recipient,address token,uint256 amount,uint256 deadline)"
                ),
                s.id,
                s.sender,
                s.recipient,
                s.token,
                s.amount,
                s.deadline
            )
        );
        assertEq(router.hashSendAuth(s), keccak256(abi.encodePacked("\x19\x01", domain, sh)));
        PingRouter.EscrowAuth memory e = _escrowAuth(NATIVE);
        bytes32 eh = keccak256(
            abi.encode(
                keccak256(
                    "EscrowAuth(bytes32 id,address sender,address token,uint256 amount,uint256 claimTip,uint64 expiresAt,uint256 deadline)"
                ),
                e.id,
                e.sender,
                e.token,
                e.amount,
                e.claimTip,
                e.expiresAt,
                e.deadline
            )
        );
        assertEq(router.hashEscrowAuth(e), keccak256(abi.encodePacked("\x19\x01", domain, eh)));
        PingRouter.ClaimAuth memory c = _claimAuth();
        bytes32 ch = keccak256(
            abi.encode(
                keccak256("ClaimAuth(bytes32 id,address recipient,address relayer,uint256 deadline)"),
                c.id,
                c.recipient,
                c.relayer,
                c.deadline
            )
        );
        assertEq(router.hashClaimAuth(c), keccak256(abi.encodePacked("\x19\x01", domain, ch)));
    }

    function testSendNative() public {
        PingRouter.SendAuth memory a = _sendAuth(NATIVE);
        uint256 beforeBalance = sender.balance;
        vm.expectEmit(true, true, true, true, address(router));
        emit PingRouter.Sent(a.id, sender, recipient, NATIVE, a.amount);
        _send(a);
        assertEq(sender.balance, beforeBalance - a.amount);
        assertEq(recipient.balance, a.amount);
        assertEq(address(router).balance, 0);
        assertTrue(router.usedIds(ID));
    }

    function testSendTokenDirectTransfer() public {
        PingRouter.SendAuth memory a = _sendAuth(address(token));
        uint256 beforeBalance = token.balanceOf(sender);
        vm.recordLogs();
        vm.expectEmit(true, true, true, true, address(router));
        emit PingRouter.Sent(a.id, sender, recipient, a.token, a.amount);
        _send(a);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 transfers;
        for (uint256 i; i < logs.length; i++) {
            if (
                logs[i].emitter == address(token) && logs[i].topics[0] == keccak256("Transfer(address,address,uint256)")
            ) {
                transfers++;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), sender);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), recipient);
                assertEq(abi.decode(logs[i].data, (uint256)), a.amount);
            }
        }
        assertEq(transfers, 1);
        assertEq(token.balanceOf(sender), beforeBalance - a.amount);
        assertEq(token.balanceOf(recipient), a.amount);
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(router.feesAccrued(), 0);
    }

    function testSendBadRecipients() public {
        PingRouter.SendAuth memory a = _sendAuth(NATIVE);
        a.recipient = address(0);
        _expectSend(a, a.amount, PingRouter.BadRecipient.selector);
        a.recipient = sender;
        _expectSend(a, a.amount, PingRouter.BadRecipient.selector);
        a.recipient = address(router);
        _expectSend(a, a.amount, PingRouter.BadRecipient.selector);
    }

    function testSendZeroAmount() public {
        PingRouter.SendAuth memory a = _sendAuth(NATIVE);
        a.amount = 0;
        _expectSend(a, 0, PingRouter.BadAmount.selector);
    }

    function testSendWrongValue() public {
        PingRouter.SendAuth memory a = _sendAuth(NATIVE);
        _expectSend(a, a.amount - 1, PingRouter.BadValue.selector);
        _expectSend(a, a.amount + 1, PingRouter.BadValue.selector);
        a.token = address(token);
        _expectSend(a, 1, PingRouter.BadValue.selector);
        assertFalse(router.usedIds(ID));
    }

    function testSendExpiredAndDeadlineBoundary() public {
        PingRouter.SendAuth memory a = _sendAuth(NATIVE);
        a.deadline = block.timestamp - 1;
        _expectSend(a, a.amount, PingRouter.Expired.selector);
        a.deadline = block.timestamp;
        _send(a);
    }

    function testSendNotSender() public {
        PingRouter.SendAuth memory a = _sendAuth(NATIVE);
        bytes memory sig = _signSend(a);
        vm.expectRevert(PingRouter.NotSender.selector);
        router.send{value: a.amount}(a, sig);
    }

    function testUsedIdsSharedAcrossSendAndEscrow() public {
        PingRouter.SendAuth memory s = _sendAuth(NATIVE);
        _send(s);
        _expectSend(s, s.amount, PingRouter.IdUsed.selector);
        PingRouter.EscrowAuth memory e = _escrowAuth(NATIVE);
        _expectEscrow(e, e.amount + TIP + FEE, PingRouter.IdUsed.selector);
        e.id = bytes32(uint256(2));
        _deposit(e);
        _expectEscrow(e, e.amount + TIP + FEE, PingRouter.IdUsed.selector);
        s.id = e.id;
        _expectSend(s, s.amount, PingRouter.IdUsed.selector);
    }

    function testEscrowSignatureCannotAuthorizeSend() public {
        PingRouter.SendAuth memory a = _sendAuth(NATIVE);
        bytes memory sig = _signEscrow(_escrowAuth(NATIVE));
        vm.expectRevert(PingRouter.BadSignature.selector);
        vm.prank(sender);
        router.send{value: a.amount}(a, sig);
    }

    function testCrossChainReplay() public {
        PingRouter.SendAuth memory a = _sendAuth(NATIVE);
        bytes memory sig = _signSend(a);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(PingRouter.BadSignature.selector);
        vm.prank(sender);
        router.send{value: a.amount}(a, sig);
    }

    function testCrossDeploymentReplay() public {
        PingRouter.SendAuth memory a = _sendAuth(NATIVE);
        bytes memory sig = _signSend(a);
        PingRouter other = new PingRouter(signer, feeRecipient, FEE);
        vm.expectRevert(PingRouter.BadSignature.selector);
        vm.prank(sender);
        other.send{value: a.amount}(a, sig);
    }

    function testHighSMalleabilityRejected() public {
        PingRouter.SendAuth memory a = _sendAuth(NATIVE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, router.hashSendAuth(a));
        bytes32 highS = bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s));
        bytes memory sig = abi.encodePacked(r, highS, v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(PingRouter.BadSignature.selector);
        vm.prank(sender);
        router.send{value: a.amount}(a, sig);
    }

    function testMalformedSignatureRejected() public {
        PingRouter.SendAuth memory a = _sendAuth(NATIVE);
        vm.expectRevert(PingRouter.BadSignature.selector);
        vm.prank(sender);
        router.send{value: a.amount}(a, "");
        // A 65-byte signature with an invalid v also recovers nothing.
        vm.expectRevert(PingRouter.BadSignature.selector);
        vm.prank(sender);
        router.send{value: a.amount}(a, abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(1)), uint8(29)));
    }

    function testSendWithoutApproval() public {
        vm.prank(sender);
        token.approve(address(router), 0);
        PingRouter.SendAuth memory a = _sendAuth(address(token));
        bytes memory sig = _signSend(a);
        vm.expectPartialRevert(bytes4(keccak256("ERC20InsufficientAllowance(address,uint256,uint256)")));
        vm.prank(sender);
        router.send(a, sig);
        assertFalse(router.usedIds(ID));
    }

    function testSendRevertingRecipient() public {
        PingRouter.SendAuth memory a = _sendAuth(NATIVE);
        a.recipient = address(new RevertingRecipient());
        _expectSend(a, a.amount, PingRouter.EthTransferFailed.selector);
        assertFalse(router.usedIds(ID));
    }

    function testNoReturnTokenAllFlows() public {
        NoReturnToken t = new NoReturnToken();
        t.mint(sender, 3e6);
        vm.prank(sender);
        t.approve(address(router), 3e6);
        _send(_sendAuth(address(t)));
        PingRouter.EscrowAuth memory e = _escrowAuth(address(t));
        e.id = bytes32(uint256(2));
        _deposit(e);
        PingRouter.ClaimAuth memory c = _claimAuth();
        c.id = e.id;
        _claim(c);
        e.id = bytes32(uint256(3));
        _deposit(e);
        vm.warp(e.expiresAt);
        router.refund(e.id);
        assertEq(t.balanceOf(recipient), 2e6);
        assertEq(t.balanceOf(sender), 1e6);
        assertEq(t.balanceOf(address(router)), 0);
    }

    function testFalseReturnTokenRejected() public {
        FalseReturnToken t = new FalseReturnToken();
        t.mint(sender, 1e6);
        vm.prank(sender);
        t.approve(address(router), 1e6);
        PingRouter.SendAuth memory s = _sendAuth(address(t));
        bytes memory sig = _signSend(s);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(t)));
        vm.prank(sender);
        router.send(s, sig);
        PingRouter.EscrowAuth memory e = _escrowAuth(address(t));
        sig = _signEscrow(e);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(t)));
        vm.prank(sender);
        router.escrow{value: TIP + FEE}(e, sig);
    }

    function testNonContractTokenRejected() public {
        _expectSend(_sendAuth(attacker), 0, PingRouter.NotToken.selector);
        _expectEscrow(_escrowAuth(attacker), TIP + FEE, PingRouter.NotToken.selector);
    }

    function testEscrowNative() public {
        PingRouter.EscrowAuth memory a = _escrowAuth(NATIVE);
        uint256 beforeBalance = sender.balance;
        vm.expectEmit(true, true, false, true, address(router));
        emit PingRouter.Escrowed(ID, sender, NATIVE, a.amount, TIP, FEE, a.expiresAt);
        _deposit(a);
        _assertOpen(a, a.amount);
        assertEq(address(router).balance, a.amount + TIP + FEE);
        assertEq(sender.balance, beforeBalance - a.amount - TIP - FEE);
        assertEq(router.feesAccrued(), FEE);
        assertEq(feeRecipient.balance, 0);
    }

    function testEscrowToken() public {
        PingRouter.EscrowAuth memory a = _escrowAuth(address(token));
        uint256 beforeBalance = sender.balance;
        vm.expectEmit(true, true, false, true, address(router));
        emit PingRouter.Escrowed(ID, sender, a.token, a.amount, TIP, FEE, a.expiresAt);
        _deposit(a);
        _assertOpen(a, a.amount);
        assertEq(address(router).balance, TIP + FEE);
        assertEq(sender.balance, beforeBalance - TIP - FEE);
        assertEq(token.balanceOf(address(router)), a.amount);
        assertEq(router.feesAccrued(), FEE);
    }

    function testEscrowWrongValue() public {
        PingRouter.EscrowAuth memory a = _escrowAuth(NATIVE);
        _expectEscrow(a, a.amount + TIP + FEE - 1, PingRouter.BadValue.selector);
        _expectEscrow(a, a.amount + TIP + FEE + 1, PingRouter.BadValue.selector);
        a.token = address(token);
        _expectEscrow(a, TIP + FEE - 1, PingRouter.BadValue.selector);
        _expectEscrow(a, TIP + FEE + 1, PingRouter.BadValue.selector);
    }

    function testEscrowExpiryBoundaries() public {
        PingRouter.EscrowAuth memory a = _escrowAuth(NATIVE);
        a.expiresAt = uint64(block.timestamp + 1 days - 1);
        _expectEscrow(a, a.amount + TIP + FEE, PingRouter.BadExpiry.selector);
        a.expiresAt = uint64(block.timestamp + 60 days + 1);
        _expectEscrow(a, a.amount + TIP + FEE, PingRouter.BadExpiry.selector);
        a.expiresAt = uint64(block.timestamp + 1 days);
        _deposit(a);
        a.id = bytes32(uint256(2));
        a.expiresAt = uint64(block.timestamp + 60 days);
        _deposit(a);
    }

    function testEscrowTipBoundaries() public {
        PingRouter.EscrowAuth memory a = _escrowAuth(NATIVE);
        a.claimTip = 0.001 ether + 1;
        _expectEscrow(a, a.amount + a.claimTip + FEE, PingRouter.TipTooHigh.selector);
        a.claimTip--;
        _deposit(a);
    }

    function testEscrowZeroAmountExpiredAndNotSender() public {
        PingRouter.EscrowAuth memory a = _escrowAuth(NATIVE);
        a.amount = 0;
        _expectEscrow(a, TIP + FEE, PingRouter.BadAmount.selector);
        a.amount = 1e6;
        a.deadline = block.timestamp - 1;
        _expectEscrow(a, a.amount + TIP + FEE, PingRouter.Expired.selector);
        a.deadline = block.timestamp;
        bytes memory sig = _signEscrow(a);
        vm.expectRevert(PingRouter.NotSender.selector);
        router.escrow{value: a.amount + TIP + FEE}(a, sig);
        _deposit(a);
    }

    function testEscrowFeeOnTransferStoresReceived() public {
        FeeOnTransferToken t = new FeeOnTransferToken();
        t.mint(sender, 1e6);
        vm.prank(sender);
        t.approve(address(router), 1e6);
        PingRouter.EscrowAuth memory a = _escrowAuth(address(t));
        vm.expectEmit(true, true, false, true, address(router));
        emit PingRouter.Escrowed(ID, sender, a.token, 990000, TIP, FEE, a.expiresAt);
        _deposit(a);
        _assertOpen(a, 990000);
        assertEq(t.balanceOf(address(router)), 990000);
        _claim(_claimAuth());
        assertEq(t.balanceOf(recipient), 980100);
    }

    function testEscrowNothingReceivedReverts() public {
        BurnAllToken t = new BurnAllToken();
        t.mint(sender, 1e6);
        vm.prank(sender);
        t.approve(address(router), 1e6);
        _expectEscrow(_escrowAuth(address(t)), TIP + FEE, PingRouter.NothingReceived.selector);
        assertFalse(router.usedIds(ID));
        assertEq(t.balanceOf(sender), 1e6);
    }

    function testClaimNativeRelayer() public {
        PingRouter.EscrowAuth memory e = _escrowAuth(NATIVE);
        _deposit(e);
        vm.expectEmit(true, true, true, true, address(router));
        emit PingRouter.Claimed(ID, recipient, relayer, NATIVE, e.amount, TIP);
        _claim(_claimAuth());
        _assertClosed(ID);
        assertEq(recipient.balance, e.amount);
        assertEq(relayer.balance, TIP);
        assertEq(address(router).balance, FEE);
        _expectEscrow(e, e.amount + TIP + FEE, PingRouter.IdUsed.selector);
    }

    function testClaimTokenSelfClaimAndZeroTip() public {
        PingRouter.EscrowAuth memory e = _escrowAuth(address(token));
        _deposit(e);
        PingRouter.ClaimAuth memory a = _claimAuth();
        a.relayer = recipient;
        _claim(a);
        assertEq(token.balanceOf(recipient), e.amount);
        assertEq(recipient.balance, TIP);
        _assertClosed(ID);
        e.id = bytes32(uint256(2));
        e.claimTip = 0;
        _deposit(e);
        a.id = e.id;
        _claim(a);
        assertEq(token.balanceOf(recipient), 2 * e.amount);
        assertEq(recipient.balance, TIP);
    }

    function testClaimDeadlineBoundary() public {
        _deposit(_escrowAuth(NATIVE));
        PingRouter.ClaimAuth memory a = _claimAuth();
        a.deadline = block.timestamp - 1;
        _expectClaim(a, PingRouter.Expired.selector);
        a.deadline = block.timestamp;
        _claim(a);
    }

    function testClaimExpiryBoundary() public {
        PingRouter.EscrowAuth memory e = _escrowAuth(NATIVE);
        _deposit(e);
        vm.warp(e.expiresAt);
        _expectClaim(_claimAuth(), PingRouter.EscrowExpired.selector);
        vm.warp(e.expiresAt + 1);
        _expectClaim(_claimAuth(), PingRouter.EscrowExpired.selector);
    }

    function testClaimBadRecipients() public {
        _deposit(_escrowAuth(NATIVE));
        PingRouter.ClaimAuth memory a = _claimAuth();
        a.recipient = address(0);
        _expectClaim(a, PingRouter.BadRecipient.selector);
        a.recipient = address(router);
        _expectClaim(a, PingRouter.BadRecipient.selector);
    }

    function testClaimUnknownDoubleAndAfterRefund() public {
        PingRouter.ClaimAuth memory a = _claimAuth();
        _expectClaim(a, PingRouter.NoEscrow.selector);
        _deposit(_escrowAuth(NATIVE));
        _claim(a);
        _expectClaim(a, PingRouter.NoEscrow.selector);
        PingRouter.EscrowAuth memory e = _escrowAuth(NATIVE);
        e.id = bytes32(uint256(2));
        _deposit(e);
        vm.warp(e.expiresAt);
        router.refund(e.id);
        a = _claimAuth();
        a.id = e.id;
        _expectClaim(a, PingRouter.NoEscrow.selector);
    }

    function testAttackerCannotRetargetVictimClaimOrTakeTip() public {
        _deposit(_escrowAuth(NATIVE));
        PingRouter.ClaimAuth memory a = _claimAuth();
        bytes memory sig = _signClaim(a);
        vm.expectRevert(PingRouter.NotRelayer.selector);
        vm.prank(attacker);
        router.claim(a, sig);
        a.recipient = attacker;
        vm.expectRevert(PingRouter.BadSignature.selector);
        vm.prank(relayer);
        router.claim(a, sig);
        a.recipient = recipient;
        a.relayer = attacker;
        vm.expectRevert(PingRouter.BadSignature.selector);
        vm.prank(attacker);
        router.claim(a, sig);
        // Even an explicitly authorized arbitrary relayer can only pay the signed victim.
        sig = _signClaim(a);
        vm.prank(attacker);
        router.claim(a, sig);
        assertEq(recipient.balance, 1e6);
        assertEq(attacker.balance, TIP);
    }

    function testClaimRejectingRecipientAndRelayerRollBack() public {
        _deposit(_escrowAuth(NATIVE));
        RevertingRecipient rejector = new RevertingRecipient();
        PingRouter.ClaimAuth memory a = _claimAuth();
        a.recipient = address(rejector);
        _expectClaim(a, PingRouter.EthTransferFailed.selector);
        _assertOpen(_escrowAuth(NATIVE), 1e6);
        a.recipient = recipient;
        a.relayer = address(rejector);
        bytes memory sig = _signClaim(a);
        vm.expectRevert(PingRouter.EthTransferFailed.selector);
        rejector.execute(address(router), abi.encodeCall(router.claim, (a, sig)));
        assertEq(recipient.balance, 0);
        _assertOpen(_escrowAuth(NATIVE), 1e6);
    }

    function testRefundNativeAtBoundaryPaysSenderOnly() public {
        PingRouter.EscrowAuth memory e = _escrowAuth(NATIVE);
        _deposit(e);
        vm.warp(e.expiresAt - 1);
        vm.expectRevert(PingRouter.NotExpired.selector);
        router.refund(ID);
        uint256 beforeBalance = sender.balance;
        vm.warp(e.expiresAt);
        vm.expectEmit(true, true, false, true, address(router));
        emit PingRouter.Refunded(ID, sender, NATIVE, e.amount, TIP);
        vm.prank(attacker);
        router.refund(ID);
        assertEq(sender.balance, beforeBalance + e.amount + TIP);
        assertEq(attacker.balance, 0);
        assertEq(address(router).balance, FEE);
        _assertClosed(ID);
        e.deadline = block.timestamp + 600;
        e.expiresAt = uint64(block.timestamp + 14 days);
        _expectEscrow(e, e.amount + TIP + FEE, PingRouter.IdUsed.selector);
    }

    function testRefundTokenAfterExpiryAndZeroTip() public {
        PingRouter.EscrowAuth memory e = _escrowAuth(address(token));
        e.claimTip = 0;
        _deposit(e);
        uint256 beforeBalance = token.balanceOf(sender);
        uint256 beforeEth = sender.balance;
        vm.warp(e.expiresAt + 1);
        vm.prank(attacker);
        router.refund(ID);
        assertEq(token.balanceOf(sender), beforeBalance + e.amount);
        assertEq(sender.balance, beforeEth);
        assertEq(token.balanceOf(attacker), 0);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function testRefundUnknownDoubleAndAfterClaim() public {
        vm.expectRevert(PingRouter.NoEscrow.selector);
        router.refund(ID);
        PingRouter.EscrowAuth memory e = _escrowAuth(NATIVE);
        _deposit(e);
        _claim(_claimAuth());
        vm.expectRevert(PingRouter.NoEscrow.selector);
        router.refund(ID);
        e.id = bytes32(uint256(2));
        _deposit(e);
        vm.warp(e.expiresAt);
        router.refund(e.id);
        vm.expectRevert(PingRouter.NoEscrow.selector);
        router.refund(e.id);
    }

    function testRefundRejectingSenderRollsBack() public {
        RevertingRecipient rejector = new RevertingRecipient();
        PingRouter.EscrowAuth memory e = _escrowAuth(NATIVE);
        e.sender = address(rejector);
        bytes memory sig = _signEscrow(e);
        rejector.execute{value: e.amount + TIP + FEE}(address(router), abi.encodeCall(router.escrow, (e, sig)));
        vm.warp(e.expiresAt);
        vm.expectRevert(PingRouter.EthTransferFailed.selector);
        router.refund(ID);
        _assertOpen(e, e.amount);
    }

    function testBlocklistedClaimsAndRefundsRecoverAfterUnfreeze() public {
        BlocklistToken t = new BlocklistToken();
        t.mint(sender, 2e6);
        vm.prank(sender);
        t.approve(address(router), 2e6);
        PingRouter.EscrowAuth memory e = _escrowAuth(address(t));
        _deposit(e);
        e.id = bytes32(uint256(2));
        _deposit(e);
        t.setBlocked(recipient, true);
        _expectClaim(_claimAuth(), BlocklistToken.Blocked.selector);
        t.setBlocked(recipient, false);
        _claim(_claimAuth());
        t.setBlocked(sender, true);
        vm.warp(e.expiresAt);
        vm.expectRevert(BlocklistToken.Blocked.selector);
        router.refund(e.id);
        _assertOpen(e, e.amount);
        t.setBlocked(sender, false);
        router.refund(e.id);
        _assertClosed(e.id);
    }

    function testWithdrawFeesAnyoneAndZeroSecondCall() public {
        _deposit(_escrowAuth(NATIVE));
        vm.expectEmit(true, false, false, true, address(router));
        emit PingRouter.FeesWithdrawn(feeRecipient, FEE);
        vm.prank(attacker);
        router.withdrawFees();
        assertEq(feeRecipient.balance, FEE);
        assertEq(router.feesAccrued(), 0);
        vm.expectEmit(true, false, false, true, address(router));
        emit PingRouter.FeesWithdrawn(feeRecipient, 0);
        router.withdrawFees();
        assertEq(feeRecipient.balance, FEE);
        assertEq(address(router).balance, 1e6 + TIP);
    }

    function testRejectingFeeRecipientCannotBlockDeposit() public {
        router = new PingRouter(signer, address(new RevertingRecipient()), FEE);
        PingRouter.EscrowAuth memory e = _escrowAuth(NATIVE);
        _deposit(e);
        vm.expectRevert(PingRouter.EthTransferFailed.selector);
        router.withdrawFees();
        assertEq(router.feesAccrued(), FEE);
        _claim(_claimAuth());
        assertEq(recipient.balance, e.amount);
    }

    function testPlainEthRejected() public {
        (bool ok,) = address(router).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(router).balance, 0);
    }

    function testReentrancyEveryEntryDuringEveryTokenFlow() public {
        ReentrantToken t = new ReentrantToken();
        t.mint(sender, 1e12);
        vm.prank(sender);
        t.approve(address(router), type(uint256).max);
        bytes[] memory payloads = new bytes[](5);
        payloads[0] = abi.encodeCall(router.send, (_sendAuth(address(t)), bytes("")));
        payloads[1] = abi.encodeCall(router.escrow, (_escrowAuth(address(t)), bytes("")));
        payloads[2] = abi.encodeCall(router.claim, (_claimAuth(), bytes("")));
        payloads[3] = abi.encodeCall(router.refund, (ID));
        payloads[4] = abi.encodeCall(router.withdrawFees, ());
        for (uint256 i; i < payloads.length; i++) {
            t.arm(address(router), payloads[i]);
            PingRouter.SendAuth memory s = _sendAuth(address(t));
            s.id = bytes32(i * 10 + 1);
            _send(s);
            _assertReentry(t);
            PingRouter.EscrowAuth memory e = _escrowAuth(address(t));
            e.id = bytes32(i * 10 + 2);
            _deposit(e);
            _assertReentry(t);
            PingRouter.ClaimAuth memory c = _claimAuth();
            c.id = e.id;
            _claim(c);
            _assertReentry(t);
            e.id = bytes32(i * 10 + 3);
            _deposit(e);
            vm.warp(e.expiresAt);
            router.refund(e.id);
            _assertReentry(t);
        }
        assertEq(t.attempts(), 25);
        assertEq(t.balanceOf(address(router)), 0);
    }

    function _assertReentry(ReentrantToken t) private view {
        assertFalse(t.succeeded());
        assertEq(t.result(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
    }

    function testFuzzAmountsTipsExpiriesAndIds(uint256 amount, uint256 tip, uint64 duration, bytes32 id, bool native_)
        public
    {
        amount = bound(amount, 1, 1e30);
        tip = bound(tip, 0, 0.001 ether);
        duration = uint64(bound(duration, 1 days, 60 days));
        PingRouter.EscrowAuth memory e = _escrowAuth(native_ ? NATIVE : address(token));
        e.id = id;
        e.amount = amount;
        e.claimTip = tip;
        e.expiresAt = uint64(block.timestamp + duration);
        _deposit(e);
        _assertOpen(e, amount);
        vm.warp(e.expiresAt);
        router.refund(id);
        _assertClosed(id);
        assertEq(address(router).balance, FEE);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function testFuzzSendAmountsAndIds(uint256 amount, bytes32 id, bool native_) public {
        PingRouter.SendAuth memory a = _sendAuth(native_ ? NATIVE : address(token));
        a.amount = bound(amount, 1, 1e30);
        a.id = id;
        _send(a);
        assertTrue(router.usedIds(id));
        assertEq(native_ ? recipient.balance : token.balanceOf(recipient), a.amount);
    }

    function testFuzzWrongSignerNeverPasses(uint256 key) public {
        key = bound(key, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        vm.assume(vm.addr(key) != signer);
        PingRouter.SendAuth memory s = _sendAuth(NATIVE);
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(key, router.hashSendAuth(s));
        vm.expectRevert(PingRouter.BadSignature.selector);
        vm.prank(sender);
        router.send{value: s.amount}(s, abi.encodePacked(r, ss, v));
        PingRouter.EscrowAuth memory e = _escrowAuth(NATIVE);
        (v, r, ss) = vm.sign(key, router.hashEscrowAuth(e));
        vm.expectRevert(PingRouter.BadSignature.selector);
        vm.prank(sender);
        router.escrow{value: e.amount + TIP + FEE}(e, abi.encodePacked(r, ss, v));
        _deposit(e);
        PingRouter.ClaimAuth memory c = _claimAuth();
        (v, r, ss) = vm.sign(key, router.hashClaimAuth(c));
        vm.expectRevert(PingRouter.BadSignature.selector);
        vm.prank(relayer);
        router.claim(c, abi.encodePacked(r, ss, v));
    }

    // Each field is mutated in every fuzz run (not randomly selected).
    function testFuzzSendEveryFieldIsSigned(bytes32 id, address who, uint256 number) public {
        PingRouter.SendAuth memory a = _sendAuth(NATIVE);
        bytes memory sig = _signSend(a);
        vm.assume(id != a.id);
        a.id = id;
        _rejectSendSig(a, sig);
        a.id = ID;
        vm.assume(who != sender && who != recipient && who != address(0) && who != address(router) && who != NATIVE);
        a.sender = who;
        _rejectSendSig(a, sig);
        a.sender = sender;
        a.recipient = who;
        _rejectSendSig(a, sig);
        a.recipient = recipient;
        a.token = who;
        _rejectSendSig(a, sig);
        a.token = NATIVE;
        number = bound(number, 1, 1e30);
        vm.assume(number != a.amount);
        a.amount = number;
        _rejectSendSig(a, sig);
        a.amount = 1e6;
        a.deadline += number;
        _rejectSendSig(a, sig);
    }

    function _rejectSendSig(PingRouter.SendAuth memory a, bytes memory sig) private {
        vm.expectRevert(PingRouter.BadSignature.selector);
        vm.prank(a.sender);
        router.send(a, sig);
    }

    function testFuzzEscrowEveryFieldIsSigned(bytes32 id, address who, uint64 number) public {
        PingRouter.EscrowAuth memory a = _escrowAuth(NATIVE);
        bytes memory sig = _signEscrow(a);
        vm.assume(id != a.id);
        a.id = id;
        _rejectEscrowSig(a, sig);
        a.id = ID;
        vm.assume(who != sender && who != NATIVE);
        a.sender = who;
        _rejectEscrowSig(a, sig);
        a.sender = sender;
        a.token = who;
        _rejectEscrowSig(a, sig);
        a.token = NATIVE;
        number = uint64(bound(number, 1, 1e15));
        vm.assume(number != a.amount && number != a.claimTip);
        a.amount = number;
        _rejectEscrowSig(a, sig);
        a.amount = 1e6;
        a.claimTip = number;
        _rejectEscrowSig(a, sig);
        a.claimTip = TIP;
        a.expiresAt += number;
        _rejectEscrowSig(a, sig);
        a.expiresAt = uint64(block.timestamp + 14 days);
        a.deadline += number;
        _rejectEscrowSig(a, sig);
    }

    function _rejectEscrowSig(PingRouter.EscrowAuth memory a, bytes memory sig) private {
        vm.expectRevert(PingRouter.BadSignature.selector);
        vm.prank(a.sender);
        router.escrow(a, sig);
    }

    function testFuzzClaimEveryFieldIsSigned(address who, uint256 delta) public {
        PingRouter.EscrowAuth memory e = _escrowAuth(NATIVE);
        _deposit(e);
        e.id = bytes32(uint256(2));
        _deposit(e);
        PingRouter.ClaimAuth memory a = _claimAuth();
        bytes memory sig = _signClaim(a);
        a.id = e.id;
        _rejectClaimSig(a, sig);
        a.id = ID;
        vm.assume(who != address(0) && who != address(router) && who != recipient && who != relayer);
        a.recipient = who;
        _rejectClaimSig(a, sig);
        a.recipient = recipient;
        a.relayer = who;
        _rejectClaimSig(a, sig);
        a.relayer = relayer;
        a.deadline += bound(delta, 1, 1e30);
        _rejectClaimSig(a, sig);
    }

    function _rejectClaimSig(PingRouter.ClaimAuth memory a, bytes memory sig) private {
        vm.expectRevert(PingRouter.BadSignature.selector);
        vm.prank(a.relayer);
        router.claim(a, sig);
    }
}
