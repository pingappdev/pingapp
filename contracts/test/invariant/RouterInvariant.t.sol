// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RouterTestBase} from "../utils/RouterTestBase.sol";
import {Test} from "forge-std/Test.sol";
import {PingRouter} from "../../src/PingRouter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {RevertingRecipient} from "../mocks/RevertingRecipient.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract RouterHandler is Test {
    using Strings for uint256;

    struct Entry {
        bytes32 id;
        address token;
        uint256 amount;
        uint256 tip;
        uint64 expires;
        address from;
    }

    uint256 private constant MAX_OPEN_ESCROWS = 32;
    address private constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    Entry[] private openEntries;
    bytes32[] private issuedIds;
    bytes32 private sequenceDigest;
    uint256 private nextId;
    PingRouter public immutable router;
    address private immutable sender;
    address private immutable recipient;
    uint256 private immutable signerKey;
    uint256 private immutable fee;
    MockERC20 private immutable tokenA;
    MockERC20 private immutable tokenB;
    RevertingRecipient public immutable rejector = new RevertingRecipient();

    uint256 public handlerCalls;
    uint256 public routerCallAttempts;
    uint256 public routerTransitions;
    uint256 public noOpCalls;
    uint256 public unexpectedReverts;

    uint256 public sendCalls;
    uint256 public sendSuccesses;
    uint256 public sendNoOps;
    uint256 public escrowCalls;
    uint256 public escrowSuccesses;
    uint256 public escrowNoOps;
    uint256 public claimCalls;
    uint256 public claimSuccesses;
    uint256 public claimNoOps;
    uint256 public refundCalls;
    uint256 public refundSuccesses;
    uint256 public refundNoOps;
    uint256 public withdrawFeeCalls;
    uint256 public withdrawFeeSuccesses;
    uint256 public withdrawFeeNoOps;
    uint256 public warpCalls;
    uint256 public warpSuccesses;
    uint256 public warpNoOps;
    uint256 public withdrawOwedCalls;
    uint256 public withdrawOwedSuccesses;
    uint256 public withdrawOwedNoOps;

    uint256 public nativeOpen;
    uint256 public tipsOpen;
    uint256 public feesOpen;
    uint256 public owedOpen;
    mapping(address => uint256) public tokensOpen;

    constructor(
        PingRouter router_,
        uint256 key,
        address sender_,
        address recipient_,
        MockERC20 tokenA_,
        MockERC20 tokenB_
    ) {
        router = router_;
        signerKey = key;
        sender = sender_;
        recipient = recipient_;
        tokenA = tokenA_;
        tokenB = tokenB_;
        fee = router_.escrowFee();

        vm.deal(sender, 1e38);
        tokenA.mint(sender, 1e38);
        tokenB.mint(sender, 1e38);
        vm.startPrank(sender);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
        vm.stopPrank();
        tokenA.mint(address(rejector), 1e38);
        tokenB.mint(address(rejector), 1e38);
        rejector.execute(address(tokenA), abi.encodeCall(tokenA.approve, (address(router), type(uint256).max)));
        rejector.execute(address(tokenB), abi.encodeCall(tokenB.approve, (address(router), type(uint256).max)));
    }

    function send(uint256 assetSeed, uint256 amountSeed) external {
        handlerCalls++;
        _recordStep();
        sendCalls++;
        address asset = _asset(assetSeed);
        uint256 amount = bound(amountSeed, 1, 1e30);
        bytes32 id = _nextId();
        PingRouter.SendAuth memory auth =
            PingRouter.SendAuth(id, sender, recipient, asset, amount, block.timestamp + 600);
        bytes memory sig = _sign(router.hashSendAuth(auth));

        routerCallAttempts++;
        vm.prank(sender);
        try router.send{value: asset == NATIVE ? amount : 0}(auth, sig) {
            _recordId(id);
            sendSuccesses++;
            routerTransitions++;
        } catch {
            unexpectedReverts++;
        }
    }

    function escrow(uint256 assetSeed, uint256 amountSeed, uint256 tipSeed, uint256 durationSeed, bool rejecting)
        external
    {
        handlerCalls++;
        _recordStep();
        escrowCalls++;
        if (openEntries.length >= MAX_OPEN_ESCROWS) {
            _recordNoOp(1);
            return;
        }

        address asset = _asset(assetSeed);
        address from = rejecting ? address(rejector) : sender;
        uint256 amount = bound(amountSeed, 1, 1e30);
        uint256 tip = bound(tipSeed, 0, 0.001 ether);
        uint64 expires = uint64(block.timestamp + bound(durationSeed, 1 days, 60 days));
        bytes32 id = _nextId();
        PingRouter.EscrowAuth memory auth =
            PingRouter.EscrowAuth(id, from, asset, amount, tip, expires, block.timestamp + 600);
        bytes memory sig = _sign(router.hashEscrowAuth(auth));
        uint256 value = (asset == NATIVE ? amount : 0) + tip + fee;

        if (rejecting) {
            vm.deal(address(this), address(this).balance + value);
            routerCallAttempts++;
            try rejector.execute{value: value}(address(router), abi.encodeCall(router.escrow, (auth, sig))) {
                _recordEscrow(id, asset, amount, tip, expires, from);
            } catch {
                unexpectedReverts++;
            }
        } else {
            vm.prank(sender);
            routerCallAttempts++;
            try router.escrow{value: value}(auth, sig) {
                _recordEscrow(id, asset, amount, tip, expires, from);
            } catch {
                unexpectedReverts++;
            }
        }
    }

    function claim(uint256 indexSeed) external {
        handlerCalls++;
        _recordStep();
        claimCalls++;
        (uint256 index, bool found) = _findEligible(indexSeed, false);
        if (!found) {
            _recordNoOp(2);
            return;
        }

        Entry memory entry = openEntries[index];
        PingRouter.ClaimAuth memory auth =
            PingRouter.ClaimAuth(entry.id, recipient, address(this), block.timestamp + 600);
        bytes memory sig = _sign(router.hashClaimAuth(auth));
        routerCallAttempts++;
        try router.claim(auth, sig) {
            _closeAndRemove(index, entry);
            claimSuccesses++;
            routerTransitions++;
        } catch {
            unexpectedReverts++;
        }
    }

    function refund(uint256 indexSeed) external {
        handlerCalls++;
        _recordStep();
        refundCalls++;
        (uint256 index, bool found) = _findEligible(indexSeed, true);
        if (!found) {
            _recordNoOp(3);
            return;
        }

        Entry memory entry = openEntries[index];
        routerCallAttempts++;
        try router.refund(entry.id) {
            if (entry.from == address(rejector)) {
                owedOpen += (entry.token == NATIVE ? entry.amount : 0) + entry.tip;
            }
            _closeAndRemove(index, entry);
            refundSuccesses++;
            routerTransitions++;
        } catch {
            unexpectedReverts++;
        }
    }

    function withdrawFees() external {
        handlerCalls++;
        _recordStep();
        withdrawFeeCalls++;
        if (feesOpen == 0) {
            _recordNoOp(4);
            return;
        }
        routerCallAttempts++;
        try router.withdrawFees() {
            feesOpen = 0;
            withdrawFeeSuccesses++;
            routerTransitions++;
        } catch {
            unexpectedReverts++;
        }
    }

    function warp(uint256 secondsSeed) external {
        handlerCalls++;
        _recordStep();
        warpCalls++;
        uint256 secondsToAdvance = bound(secondsSeed, 1, 61 days);
        vm.warp(block.timestamp + secondsToAdvance);
        warpSuccesses++;
    }

    function withdrawOwed() external {
        handlerCalls++;
        _recordStep();
        withdrawOwedCalls++;
        if (owedOpen == 0) {
            _recordNoOp(6);
            return;
        }
        routerCallAttempts++;
        try rejector.execute(address(router), abi.encodeCall(router.withdrawOwed, (recipient))) {
            owedOpen = 0;
            withdrawOwedSuccesses++;
            routerTransitions++;
        } catch {
            unexpectedReverts++;
        }
    }

    function assertIdsAndOpenEscrows(uint256 sampleSeed) external view {
        uint256 idSampleCount = issuedIds.length < 4 ? issuedIds.length : 4;
        for (uint256 i; i < idSampleCount; i++) {
            assertTrue(router.usedIds(issuedIds[(sampleSeed + i) % issuedIds.length]));
        }
        uint256 sampleCount = openEntries.length < 4 ? openEntries.length : 4;
        for (uint256 i; i < sampleCount; i++) {
            Entry memory entry = openEntries[(sampleSeed + i) % openEntries.length];
            (address from, uint64 expires, address asset, uint256 amount, uint256 tip) = router.escrows(entry.id);
            assertEq(from, entry.from);
            assertEq(expires, entry.expires);
            assertEq(asset, entry.token);
            assertEq(amount, entry.amount);
            assertEq(tip, entry.tip);
            assertTrue(router.usedIds(entry.id));
        }
    }

    function assertEveryIssuedId() external view {
        for (uint256 i; i < issuedIds.length; i++) assertTrue(router.usedIds(issuedIds[i]));
    }

    function currentSequenceId() external view returns (bytes32) {
        return sequenceDigest;
    }

    function assertSequenceMetrics(uint256 expectedCalls) external view {
        assertEq(handlerCalls, expectedCalls, "handler call count differs from profile");
        assertEq(routerCallAttempts, routerTransitions + unexpectedReverts, "router call accounting mismatch");
        assertEq(routerCallAttempts + noOpCalls + warpSuccesses, handlerCalls, "handler action accounting mismatch");
        assertEq(routerTransitions + noOpCalls + unexpectedReverts + warpSuccesses, handlerCalls, "campaign accounting mismatch");
        assertEq(unexpectedReverts, 0, "router call unexpectedly reverted");
    }

    function metricsJson(string memory property, uint256 seed, uint256 runs, uint256 depth)
        external
        view
        returns (string memory)
    {
        return string.concat(_campaignJson(property, seed, runs, depth), ",\"actions\":{", _actionCountersJson(), "}}");
    }

    function _campaignJson(string memory property, uint256 seed, uint256 runs, uint256 depth)
        private
        view
        returns (string memory)
    {
        string memory identity = string.concat(
            "{\"property\":\"", property, "\",\"sequenceId\":\"",
            uint256(sequenceDigest).toHexString(32), "\",\"seed\":\"", seed.toString(), "\",\"runs\":", runs.toString(), ",\"depth\":", depth.toString()
        );
        return string.concat(
            identity,
            ",\"calls\":", handlerCalls.toString(), ",\"routerCallAttempts\":", routerCallAttempts.toString(),
            ",\"routerTransitions\":", routerTransitions.toString(), ",\"noOps\":", noOpCalls.toString(),
            ",\"unexpectedReverts\":", unexpectedReverts.toString()
        );
    }

    function _actionCountersJson() private view returns (string memory) {
        string memory sendsAndEscrows = string.concat(
            "\"send\":",
            _actionJson(sendCalls, sendSuccesses, sendNoOps),
            ",\"escrow\":",
            _actionJson(escrowCalls, escrowSuccesses, escrowNoOps)
        );
        string memory remaining = string.concat(
            ",\"claim\":",
            _actionJson(claimCalls, claimSuccesses, claimNoOps),
            ",\"refund\":",
            _actionJson(refundCalls, refundSuccesses, refundNoOps),
            ",\"withdrawFees\":",
            _actionJson(withdrawFeeCalls, withdrawFeeSuccesses, withdrawFeeNoOps),
            ",\"warp\":",
            _actionJson(warpCalls, warpSuccesses, warpNoOps),
            ",\"withdrawOwed\":",
            _actionJson(withdrawOwedCalls, withdrawOwedSuccesses, withdrawOwedNoOps)
        );
        return string.concat(sendsAndEscrows, remaining);
    }

    function _actionJson(uint256 calls, uint256 successes, uint256 noOps) private pure returns (string memory) {
        return string(
            abi.encodePacked(
                "{\"calls\":",
                calls.toString(),
                ",\"successes\":",
                successes.toString(),
                ",\"noOps\":",
                noOps.toString(),
                "}"
            )
        );
    }

    function _asset(uint256 assetSeed) private view returns (address) {
        uint256 choice = assetSeed % 3;
        if (choice == 0) return NATIVE;
        return choice == 1 ? address(tokenA) : address(tokenB);
    }

    function _recordStep() private {
        sequenceDigest = keccak256(abi.encodePacked(sequenceDigest, msg.data));
    }

    function _nextId() private returns (bytes32) {
        nextId++;
        return bytes32(nextId);
    }

    function _recordId(bytes32 id) private {
        issuedIds.push(id);
    }

    function _recordEscrow(bytes32 id, address asset, uint256 amount, uint256 tip, uint64 expires, address from)
        private
    {
        openEntries.push(Entry(id, asset, amount, tip, expires, from));
        _recordId(id);
        if (asset == NATIVE) nativeOpen += amount;
        else tokensOpen[asset] += amount;
        tipsOpen += tip;
        feesOpen += fee;
        escrowSuccesses++;
        routerTransitions++;
    }

    function _findEligible(uint256 indexSeed, bool expired) private view returns (uint256 index, bool found) {
        uint256 length = openEntries.length;
        if (length == 0) return (0, false);
        uint256 start = indexSeed % length;
        for (uint256 offset; offset < length; offset++) {
            uint256 candidate = (start + offset) % length;
            bool canRun = expired ? block.timestamp >= openEntries[candidate].expires : block.timestamp < openEntries[candidate].expires;
            if (canRun) return (candidate, true);
        }
    }

    function _closeAndRemove(uint256 index, Entry memory entry) private {
        if (entry.token == NATIVE) nativeOpen -= entry.amount;
        else tokensOpen[entry.token] -= entry.amount;
        tipsOpen -= entry.tip;
        uint256 last = openEntries.length - 1;
        if (index != last) openEntries[index] = openEntries[last];
        openEntries.pop();
    }

    function _recordNoOp(uint8 action) private {
        noOpCalls++;
        if (action == 1) escrowNoOps++;
        else if (action == 2) claimNoOps++;
        else if (action == 3) refundNoOps++;
        else if (action == 4) withdrawFeeNoOps++;
        else if (action == 6) withdrawOwedNoOps++;
    }

    function _sign(bytes32 digest) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    receive() external payable {}
}

contract RouterInvariantTest is RouterTestBase {
    using Strings for uint256;

    uint256 private constant DEFAULT_CAMPAIGN_RUNS = 256;
    uint256 private constant DEFAULT_CAMPAIGN_DEPTH = 64;
    uint256 private constant DEFAULT_CAMPAIGN_SEED = 0xA0D08C1A20261016;

    RouterHandler private handler;
    MockERC20 private token2;
    uint256 private campaignRuns;
    uint256 private campaignDepth;
    uint256 private campaignSeed;
    string private metricsPath;

    function setUp() public override {
        super.setUp();
        campaignRuns = vm.envOr("AUD08_CAMPAIGN_RUNS", DEFAULT_CAMPAIGN_RUNS);
        campaignDepth = vm.envOr("AUD08_CAMPAIGN_DEPTH", DEFAULT_CAMPAIGN_DEPTH);
        campaignSeed = vm.envOr("AUD08_CAMPAIGN_SEED", DEFAULT_CAMPAIGN_SEED);
        metricsPath = vm.envOr("AUD08_METRICS_PATH", string(""));
        token2 = new MockERC20();
        handler = new RouterHandler(router, signerKey, sender, recipient, token, token2);
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.send.selector;
        selectors[1] = handler.escrow.selector;
        selectors[2] = handler.claim.selector;
        selectors[3] = handler.refund.selector;
        selectors[4] = handler.withdrawFees.selector;
        selectors[5] = handler.warp.selector;
        selectors[6] = handler.withdrawOwed.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariantNativeSolvent() public {
        assertEq(
            address(router).balance,
            handler.nativeOpen() + handler.tipsOpen() + router.feesAccrued() + router.totalOwed()
        );
        assertEq(router.totalOwed(), handler.owedOpen());
        assertEq(router.owedEth(address(handler.rejector())), handler.owedOpen());
        assertEq(router.feesAccrued(), handler.feesOpen());
        _recordSequence("invariantNativeSolvent");
    }

    function invariantTokensSolvent() public {
        assertEq(token.balanceOf(address(router)), handler.tokensOpen(address(token)));
        assertEq(token2.balanceOf(address(router)), handler.tokensOpen(address(token2)));
        _recordSequence("invariantTokensSolvent");
    }

    function invariantFinalizedIdsNeverReappear() public {
        handler.assertIdsAndOpenEscrows(uint256(uint160(address(this))));
        _recordSequence("invariantFinalizedIdsNeverReappear");
    }

    function afterInvariant() public view {
        handler.assertSequenceMetrics(campaignDepth);
        handler.assertEveryIssuedId();
    }

    function _recordSequence(string memory property) private {
        if (handler.handlerCalls() != campaignDepth) return;
        handler.assertSequenceMetrics(campaignDepth);
        handler.assertEveryIssuedId();
        if (bytes(metricsPath).length == 0) return;
        bytes32 sequenceId = handler.currentSequenceId();
        string memory markerPath = string.concat(
            metricsPath, ".", property, "-", uint256(sequenceId).toHexString(32), ".seen"
        );
        if (vm.isFile(markerPath)) return;
        vm.writeFile(markerPath, "recorded");
        vm.writeLine(
            metricsPath,
            handler.metricsJson(property, campaignSeed, campaignRuns, campaignDepth)
        );
    }
}
