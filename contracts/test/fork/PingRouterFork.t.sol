// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {RouterTestBase} from "../utils/RouterTestBase.sol";
import {PingRouter} from "../../src/PingRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

contract PingRouterForkTest is RouterTestBase {
    address private constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address private constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    // CRM, selected from the dev registry on 2026-10-11.
    address private constant STOCK = 0xd95B44124e475743a7589e68F3D74008A5536D44;
    bool private enabled;

    function setUp() public override {
        if (!vm.envExists("ROBINHOOD_RPC_URL")) return;
        string memory url = vm.envString("ROBINHOOD_RPC_URL");
        if (bytes(url).length == 0) return;
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, forkBlock);
        uint256 timestamp = block.timestamp;
        super.setUp();
        vm.warp(timestamp);
        enabled = true;
    }

    modifier forkOnly() {
        vm.skip(!enabled);
        _;
    }

    function testForkEthSendClaimRefund() public forkOnly {
        _flows(NATIVE, 0.01 ether);
    }

    function testForkUsdgSendClaimRefund() public forkOnly {
        _flows(USDG, 10e6);
    }

    function testForkWethSendClaimRefund() public forkOnly {
        _flows(WETH, 0.01 ether);
    }

    function _flows(address asset, uint256 amount) private {
        if (asset != NATIVE) {
            assertGt(asset.code.length, 0);
            deal(asset, sender, 3 * amount);
            vm.prank(sender);
            IERC20(asset).approve(address(router), 3 * amount);
        }
        uint256 senderBefore = _balance(asset, sender);
        uint256 recipientBefore = _balance(asset, recipient);
        uint256 ethBefore = sender.balance;
        PingRouter.SendAuth memory s = _sendAuth(asset);
        s.amount = amount;
        _send(s);
        assertEq(_balance(asset, recipient), recipientBefore + amount);
        assertEq(_balance(asset, address(router)), 0);
        PingRouter.EscrowAuth memory e = _escrowAuth(asset);
        e.amount = amount;
        e.id = bytes32(uint256(2));
        _deposit(e);
        _assertOpen(e, amount);
        PingRouter.ClaimAuth memory c = _claimAuth();
        c.id = e.id;
        _claim(c);
        _assertClosed(e.id);
        assertEq(_balance(asset, recipient), recipientBefore + 2 * amount);
        assertEq(relayer.balance, TIP);
        e.id = bytes32(uint256(3));
        _deposit(e);
        vm.warp(e.expiresAt);
        vm.prank(attacker);
        router.refund(e.id);
        _assertClosed(e.id);
        assertEq(_balance(asset, sender), senderBefore - 2 * amount - (asset == NATIVE ? TIP + 2 * FEE : 0));
        assertEq(sender.balance, ethBefore - (asset == NATIVE ? 2 * amount : 0) - TIP - 2 * FEE);
        assertEq(attacker.balance, 0);
        assertEq(address(router).balance, 2 * FEE);
        if (asset != NATIVE) assertEq(IERC20(asset).balanceOf(address(router)), 0);
        emit log_named_uint("fork block", block.number);
    }

    function testForkStockSendEscrowClaimBehavior() public forkOnly {
        assertGt(STOCK.code.length, 0);
        uint256 amount = 10 ** IERC20Metadata(STOCK).decimals();
        deal(STOCK, sender, 3 * amount);
        vm.prank(sender);
        IERC20(STOCK).approve(address(router), 3 * amount);
        PingRouter.SendAuth memory s = _sendAuth(STOCK);
        s.amount = amount;
        bytes memory sig = _signSend(s);
        uint256 beforeBalance = IERC20(STOCK).balanceOf(sender);
        vm.prank(sender);
        try router.send(s, sig) {
            assertEq(IERC20(STOCK).balanceOf(recipient), amount);
            assertEq(IERC20(STOCK).balanceOf(sender), beforeBalance - amount);
            assertTrue(router.usedIds(s.id));
            emit log("CRM send: success");
        } catch (bytes memory reason) {
            assertGt(reason.length, 0, "stock send must revert cleanly");
            assertFalse(router.usedIds(s.id));
            assertEq(IERC20(STOCK).balanceOf(sender), beforeBalance);
            assertEq(IERC20(STOCK).balanceOf(recipient), 0);
            emit log("CRM send: clean revert");
            emit log_bytes(reason);
        }
        assertEq(IERC20(STOCK).balanceOf(address(router)), 0);
        PingRouter.EscrowAuth memory e = _escrowAuth(STOCK);
        e.id = bytes32(uint256(2));
        e.amount = amount;
        sig = _signEscrow(e);
        beforeBalance = IERC20(STOCK).balanceOf(sender);
        vm.prank(sender);
        try router.escrow{value: TIP + FEE}(e, sig) {
            _assertOpen(e, amount);
            emit log("CRM escrow: success");
        } catch (bytes memory reason) {
            assertGt(reason.length, 0, "stock escrow must revert cleanly");
            assertFalse(router.usedIds(e.id));
            assertEq(IERC20(STOCK).balanceOf(sender), beforeBalance);
            assertEq(address(router).balance, 0);
            assertEq(router.feesAccrued(), 0);
            emit log("CRM escrow: clean revert");
            emit log_bytes(reason);
            PingRouter.ClaimAuth memory missing = _claimAuth();
            missing.id = e.id;
            _expectClaim(missing, PingRouter.NoEscrow.selector);
            emit log("CRM claim: NoEscrow after rejected deposit");
            return;
        }
        PingRouter.ClaimAuth memory c = _claimAuth();
        c.id = e.id;
        sig = _signClaim(c);
        uint256 recipientBefore = IERC20(STOCK).balanceOf(recipient);
        vm.prank(relayer);
        try router.claim(c, sig) {
            assertEq(IERC20(STOCK).balanceOf(recipient), recipientBefore + amount);
            assertEq(relayer.balance, TIP);
            _assertClosed(e.id);
            emit log("CRM claim: success");
        } catch (bytes memory reason) {
            assertGt(reason.length, 0, "stock claim must revert cleanly");
            _assertOpen(e, amount);
            assertEq(IERC20(STOCK).balanceOf(recipient), recipientBefore);
            assertEq(relayer.balance, 0);
            emit log("CRM claim: clean revert");
            emit log_bytes(reason);
        }
        emit log_named_uint("fork block", block.number);
    }

    function _balance(address asset, address who) private view returns (uint256) {
        return asset == NATIVE ? who.balance : IERC20(asset).balanceOf(who);
    }
}
