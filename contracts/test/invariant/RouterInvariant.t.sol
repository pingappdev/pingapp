// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {RouterTestBase} from "../utils/RouterTestBase.sol";
import {Test} from "forge-std/Test.sol";
import {PingRouter} from "../../src/PingRouter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {RevertingRecipient} from "../mocks/RevertingRecipient.sol";

contract RouterHandler is Test {
    struct Entry {
        bytes32 id;
        address token;
        uint256 amount;
        uint256 tip;
        uint64 expires;
        address from;
        bool closed;
    }
    Entry[] public entries;
    PingRouter public immutable router;
    address private immutable sender;
    address private immutable recipient;
    uint256 private immutable signerKey;
    uint256 private immutable fee;
    address private constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address[3] private assets;
    uint256 public nativeOpen;
    uint256 public tipsOpen;
    uint256 public feesOpen;
    uint256 public owedOpen;
    // A sender smart wallet that rejects ETH, so its refunds are credited.
    RevertingRecipient public immutable rejector = new RevertingRecipient();
    mapping(address => uint256) public tokensOpen;

    constructor(PingRouter router_, uint256 key, address sender_, address recipient_, MockERC20 t1, MockERC20 t2) {
        router = router_;
        signerKey = key;
        sender = sender_;
        recipient = recipient_;
        fee = router_.escrowFee();
        assets = [NATIVE, address(t1), address(t2)];
        vm.deal(sender, 1e38);
        t1.mint(sender, 1e38);
        t2.mint(sender, 1e38);
        vm.startPrank(sender);
        t1.approve(address(router), type(uint256).max);
        t2.approve(address(router), type(uint256).max);
        vm.stopPrank();
        t1.mint(address(rejector), 1e38);
        t2.mint(address(rejector), 1e38);
        rejector.execute(address(t1), abi.encodeCall(t1.approve, (address(router), type(uint256).max)));
        rejector.execute(address(t2), abi.encodeCall(t2.approve, (address(router), type(uint256).max)));
    }

    function send(uint256 asset, uint256 amount) external {
        address token = assets[asset % 3];
        amount = bound(amount, 1, 1e30);
        bytes32 id = bytes32(entries.length + 1);
        PingRouter.SendAuth memory a = PingRouter.SendAuth(id, sender, recipient, token, amount, block.timestamp + 600);
        bytes memory sig = _sign(router.hashSendAuth(a));
        vm.prank(sender);
        router.send{value: token == NATIVE ? amount : 0}(a, sig);
        entries.push(Entry(id, token, amount, 0, 0, sender, true));
    }

    function escrow(uint256 asset, uint256 amount, uint256 tip, uint256 duration, bool rejecting) external {
        address token = assets[asset % 3];
        address from = rejecting ? address(rejector) : sender;
        amount = bound(amount, 1, 1e30);
        tip = bound(tip, 0, 0.001 ether);
        uint64 expires = uint64(block.timestamp + bound(duration, 1 days, 60 days));
        bytes32 id = bytes32(entries.length + 1);
        PingRouter.EscrowAuth memory a =
            PingRouter.EscrowAuth(id, from, token, amount, tip, expires, block.timestamp + 600);
        bytes memory sig = _sign(router.hashEscrowAuth(a));
        uint256 value = (token == NATIVE ? amount : 0) + tip + fee;
        if (rejecting) {
            vm.deal(address(this), address(this).balance + value);
            rejector.execute{value: value}(address(router), abi.encodeCall(router.escrow, (a, sig)));
        } else {
            vm.prank(sender);
            router.escrow{value: value}(a, sig);
        }
        entries.push(Entry(id, token, amount, tip, expires, from, false));
        if (token == NATIVE) nativeOpen += amount;
        else tokensOpen[token] += amount;
        tipsOpen += tip;
        feesOpen += fee;
    }

    function claim(uint256 index) external {
        if (entries.length == 0) return;
        Entry storage e = entries[index % entries.length];
        if (e.closed || block.timestamp >= e.expires) return;
        PingRouter.ClaimAuth memory a = PingRouter.ClaimAuth(e.id, recipient, address(this), block.timestamp + 600);
        router.claim(a, _sign(router.hashClaimAuth(a)));
        _close(e);
    }

    function refund(uint256 index) external {
        if (entries.length == 0) return;
        Entry storage e = entries[index % entries.length];
        if (e.closed || block.timestamp < e.expires) return;
        router.refund(e.id);
        if (e.from == address(rejector)) owedOpen += (e.token == NATIVE ? e.amount : 0) + e.tip;
        _close(e);
    }

    function withdrawOwed() external {
        if (owedOpen == 0) return;
        rejector.execute(address(router), abi.encodeCall(router.withdrawOwed, (recipient)));
        owedOpen = 0;
    }

    function withdraw() external {
        router.withdrawFees();
        feesOpen = 0;
    }

    function warp(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 0, 61 days));
    }

    function _close(Entry storage e) private {
        e.closed = true;
        if (e.token == NATIVE) nativeOpen -= e.amount;
        else tokensOpen[e.token] -= e.amount;
        tipsOpen -= e.tip;
    }

    function _sign(bytes32 digest) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function assertIdsNeverReappear() external view {
        for (uint256 i; i < entries.length; i++) {
            Entry memory e = entries[i];
            assertTrue(router.usedIds(e.id));
            (address from, uint64 expires, address token, uint256 amount, uint256 tip) = router.escrows(e.id);
            if (e.closed) {
                assertEq(from, address(0));
                assertEq(amount, 0);
                assertEq(tip, 0);
            } else {
                assertEq(from, e.from);
                assertEq(expires, e.expires);
                assertEq(token, e.token);
                assertEq(amount, e.amount);
                assertEq(tip, e.tip);
            }
        }
    }
    receive() external payable {}
}

contract RouterInvariantTest is RouterTestBase {
    RouterHandler private handler;
    MockERC20 private token2;

    function setUp() public override {
        super.setUp();
        token2 = new MockERC20();
        handler = new RouterHandler(router, signerKey, sender, recipient, token, token2);
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.send.selector;
        selectors[1] = handler.escrow.selector;
        selectors[2] = handler.claim.selector;
        selectors[3] = handler.refund.selector;
        selectors[4] = handler.withdraw.selector;
        selectors[5] = handler.warp.selector;
        selectors[6] = handler.withdrawOwed.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariantNativeSolvent() public view {
        assertEq(
            address(router).balance,
            handler.nativeOpen() + handler.tipsOpen() + router.feesAccrued() + router.totalOwed()
        );
        assertEq(router.totalOwed(), handler.owedOpen());
        assertEq(router.owedEth(address(handler.rejector())), handler.owedOpen());
        assertEq(router.feesAccrued(), handler.feesOpen());
    }

    function invariantTokensSolvent() public view {
        assertEq(token.balanceOf(address(router)), handler.tokensOpen(address(token)));
        assertEq(token2.balanceOf(address(router)), handler.tokensOpen(address(token2)));
    }

    function invariantFinalizedIdsNeverReappear() public view {
        handler.assertIdsNeverReappear();
    }
}
