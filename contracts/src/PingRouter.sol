// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title PingRouter
/// @notice Ownerless signed sends and expiring escrows, with no phone data on chain.
/// @dev The immutable signer authorizes sends and decides which wallet may claim.
/// A compromised signer can redirect unclaimed escrows, but cannot block expired
/// refunds or pull allowances from anyone other than the caller of send/escrow.
/// Tokens sent directly to the router (outside escrow) are stuck forever: there
/// is no sweep and no owner. Rebasing tokens are unsupported, as amounts can drift.
/// Blocklisted tokens can prevent claims/refunds until the token unfreezes.
/// Stock-token transfer restrictions can make send/escrow/claim revert cleanly.
contract PingRouter is EIP712("PingRouter", "1"), ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    uint64 public constant MIN_ESCROW_DURATION = 1 days;
    uint64 public constant MAX_ESCROW_DURATION = 60 days;
    uint256 public constant MAX_CLAIM_TIP = 0.001 ether;
    uint256 public constant MAX_ESCROW_FEE = 0.001 ether;

    bytes32 public constant SEND_TYPEHASH = keccak256(
        "SendAuth(bytes32 id,address sender,address recipient,address token,uint256 amount,uint256 deadline)"
    );
    bytes32 public constant ESCROW_TYPEHASH = keccak256(
        "EscrowAuth(bytes32 id,address sender,address token,uint256 amount,uint256 claimTip,uint64 expiresAt,uint256 deadline)"
    );
    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("ClaimAuth(bytes32 id,address recipient,address relayer,uint256 deadline)");

    address public immutable signer;
    address public immutable feeRecipient;
    uint256 public immutable escrowFee;

    struct SendAuth {
        bytes32 id;
        address sender;
        address recipient;
        address token;
        uint256 amount;
        uint256 deadline;
    }

    struct EscrowAuth {
        bytes32 id;
        address sender;
        address token;
        uint256 amount;
        uint256 claimTip;
        uint64 expiresAt;
        uint256 deadline;
    }

    struct ClaimAuth {
        bytes32 id;
        address recipient;
        address relayer;
        uint256 deadline;
    }

    struct Escrow {
        address sender;
        uint64 expiresAt;
        address token;
        uint256 amount;
        uint256 claimTip;
    }

    mapping(bytes32 => bool) public usedIds;
    mapping(bytes32 => Escrow) public escrows;
    uint256 public feesAccrued;

    event Sent(bytes32 indexed id, address indexed sender, address indexed recipient, address token, uint256 amount);
    event Escrowed(
        bytes32 indexed id,
        address indexed sender,
        address token,
        uint256 amount,
        uint256 claimTip,
        uint256 fee,
        uint64 expiresAt
    );
    event Claimed(
        bytes32 indexed id,
        address indexed recipient,
        address indexed relayer,
        address token,
        uint256 amount,
        uint256 claimTip
    );
    event Refunded(bytes32 indexed id, address indexed sender, address token, uint256 amount, uint256 claimTip);
    event FeesWithdrawn(address indexed to, uint256 amount);

    error Expired();
    error NotSender();
    error IdUsed();
    error BadSignature();
    error BadValue();
    error BadAmount();
    error BadRecipient();
    error BadExpiry();
    error TipTooHigh();
    error NotToken();
    error NoEscrow();
    error NotExpired();
    error EscrowExpired();
    error NotRelayer();
    error EthTransferFailed();
    error NothingReceived();

    constructor(address signer_, address feeRecipient_, uint256 escrowFee_) {
        if (signer_ == address(0) || feeRecipient_ == address(0)) revert BadRecipient();
        if (escrowFee_ > MAX_ESCROW_FEE) revert BadValue();
        signer = signer_;
        feeRecipient = feeRecipient_;
        escrowFee = escrowFee_;
    }

    function send(SendAuth calldata a, bytes calldata sig) external payable nonReentrant {
        if (block.timestamp > a.deadline) revert Expired();
        if (msg.sender != a.sender) revert NotSender();
        if (a.recipient == address(0) || a.recipient == a.sender || a.recipient == address(this)) {
            revert BadRecipient();
        }
        if (a.amount == 0) revert BadAmount();
        if (usedIds[a.id]) revert IdUsed();
        _verify(_hashSendAuth(a), sig);
        usedIds[a.id] = true;

        if (a.token == NATIVE) {
            if (msg.value != a.amount) revert BadValue();
            _payEth(a.recipient, a.amount);
        } else {
            if (msg.value != 0) revert BadValue();
            if (a.token.code.length == 0) revert NotToken();
            IERC20(a.token).safeTransferFrom(msg.sender, a.recipient, a.amount);
        }
        emit Sent(a.id, a.sender, a.recipient, a.token, a.amount);
    }

    function escrow(EscrowAuth calldata a, bytes calldata sig) external payable nonReentrant {
        if (block.timestamp > a.deadline) revert Expired();
        if (msg.sender != a.sender) revert NotSender();
        if (a.amount == 0) revert BadAmount();
        if (usedIds[a.id]) revert IdUsed();
        _verify(_hashEscrowAuth(a), sig);
        if (a.claimTip > MAX_CLAIM_TIP) revert TipTooHigh();
        if (a.expiresAt < block.timestamp + MIN_ESCROW_DURATION || a.expiresAt > block.timestamp + MAX_ESCROW_DURATION) revert BadExpiry();

        // Reserve the id before calling token code; a revert rolls it back.
        usedIds[a.id] = true;
        uint256 received;
        if (a.token == NATIVE) {
            if (msg.value != a.amount + a.claimTip + escrowFee) revert BadValue();
            received = a.amount;
        } else {
            if (msg.value != a.claimTip + escrowFee) revert BadValue();
            if (a.token.code.length == 0) revert NotToken();
            IERC20 token = IERC20(a.token);
            uint256 beforeBalance = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), a.amount);
            received = token.balanceOf(address(this)) - beforeBalance;
            if (received == 0) revert NothingReceived();
        }
        escrows[a.id] = Escrow(msg.sender, a.expiresAt, a.token, received, a.claimTip);
        feesAccrued += escrowFee;
        emit Escrowed(a.id, msg.sender, a.token, received, a.claimTip, escrowFee, a.expiresAt);
    }

    function claim(ClaimAuth calldata a, bytes calldata sig) external nonReentrant {
        if (block.timestamp > a.deadline) revert Expired();
        if (msg.sender != a.relayer) revert NotRelayer();
        Escrow memory e = escrows[a.id];
        if (e.sender == address(0)) revert NoEscrow();
        if (block.timestamp >= e.expiresAt) revert EscrowExpired();
        if (a.recipient == address(0) || a.recipient == address(this)) revert BadRecipient();
        _verify(_hashClaimAuth(a), sig);
        delete escrows[a.id];
        _payToken(e.token, a.recipient, e.amount);
        if (e.claimTip > 0) _payEth(a.relayer, e.claimTip);
        emit Claimed(a.id, a.recipient, a.relayer, e.token, e.amount, e.claimTip);
    }

    function refund(bytes32 id) external nonReentrant {
        Escrow memory e = escrows[id];
        if (e.sender == address(0)) revert NoEscrow();
        if (block.timestamp < e.expiresAt) revert NotExpired();
        delete escrows[id];
        _payToken(e.token, e.sender, e.amount);
        if (e.claimTip > 0) _payEth(e.sender, e.claimTip);
        emit Refunded(id, e.sender, e.token, e.amount, e.claimTip);
    }

    function withdrawFees() external nonReentrant {
        uint256 amount = feesAccrued;
        feesAccrued = 0;
        _payEth(feeRecipient, amount);
        emit FeesWithdrawn(feeRecipient, amount);
    }

    function hashSendAuth(SendAuth calldata a) external view returns (bytes32) {
        return _hashSendAuth(a);
    }

    function hashEscrowAuth(EscrowAuth calldata a) external view returns (bytes32) {
        return _hashEscrowAuth(a);
    }

    function hashClaimAuth(ClaimAuth calldata a) external view returns (bytes32) {
        return _hashClaimAuth(a);
    }

    function _hashSendAuth(SendAuth calldata a) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(SEND_TYPEHASH, a.id, a.sender, a.recipient, a.token, a.amount, a.deadline))
        );
    }

    function _hashEscrowAuth(EscrowAuth calldata a) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(ESCROW_TYPEHASH, a.id, a.sender, a.token, a.amount, a.claimTip, a.expiresAt, a.deadline)
            )
        );
    }

    function _hashClaimAuth(ClaimAuth calldata a) private view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, a.id, a.recipient, a.relayer, a.deadline)));
    }

    function _verify(bytes32 digest, bytes calldata sig) private view {
        if (ECDSA.recover(digest, sig) != signer) revert BadSignature();
    }

    function _payToken(address token, address to, uint256 amount) private {
        if (token == NATIVE) _payEth(to, amount);
        else IERC20(token).safeTransfer(to, amount);
    }

    function _payEth(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
