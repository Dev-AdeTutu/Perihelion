// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { MockERC20, MockEndpoint } from "./PerihelionEscrow.t.sol";

/// @dev Stateless property tests for the escrow's value-handling and guards.
contract PerihelionEscrowFuzzTest is Test {
    PerihelionEscrow internal escrow;
    MockERC20 internal token;
    MockEndpoint internal endpoint;

    uint32 internal constant STELLAR_EID = 30_316;
    bytes32 internal constant STELLAR_PEER = bytes32(uint256(0x57E11A));

    uint256 internal userPk = 0xA11CE;
    address internal user;
    address internal solver = address(0x5012E5);

    function setUp() public {
        endpoint = new MockEndpoint();
        escrow = new PerihelionEscrow(address(endpoint), STELLAR_EID);
        escrow.setPeer(STELLAR_PEER);
        token = new MockERC20();
        user = vm.addr(userPk);

        token.mint(user, type(uint128).max);
        vm.prank(user);
        token.approve(address(escrow), type(uint256).max);
        escrow.setAssetAllowed(address(token), true);
        vm.deal(solver, 100 ether);
    }

    function _intent(uint256 amount, uint256 deadline)
        internal
        view
        returns (PerihelionEscrow.Intent memory)
    {
        return PerihelionEscrow.Intent({
            user: user,
            destination: "GUSERSTELLAR",
            sourceChainId: block.chainid,
            sourceAsset: address(token),
            sourceAmount: amount,
            destAsset: "USDC:GA5Z",
            minDestAmount: amount,
            deadline: deadline,
            nonce: 1,
            preferredSolver: address(0)
        });
    }

    function _sign(uint256 pk, PerihelionEscrow.Intent memory intent)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, escrow.hashIntent(intent));
        return abi.encodePacked(r, s, v);
    }

    /// The escrow records and holds exactly the amount pulled, for any amount.
    function testFuzz_LockHoldsExactAmount(uint128 amount) public {
        amount = uint128(bound(amount, 1, type(uint128).max));
        PerihelionEscrow.Intent memory intent = _intent(amount, block.timestamp + 600);
        bytes memory sig = _sign(userPk, intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        assertEq(token.balanceOf(address(escrow)), amount);
        (,,, uint256 held,,,,) = escrow.locks(h);
        assertEq(held, amount);
    }

    /// A signature from any key other than the user's is always rejected.
    function testFuzz_WrongSignerRejected(uint256 wrongPk) public {
        wrongPk = bound(wrongPk, 1, type(uint128).max);
        vm.assume(wrongPk != userPk);

        PerihelionEscrow.Intent memory intent = _intent(100_000, block.timestamp + 600);
        bytes memory sig = _sign(wrongPk, intent);

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.InvalidSignature.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    /// Tampering with the amount after signing always invalidates the signature.
    function testFuzz_TamperedAmountRejected(uint128 signedAmount, uint128 sentAmount) public {
        signedAmount = uint128(bound(signedAmount, 1, type(uint128).max - 1));
        sentAmount = uint128(bound(sentAmount, 1, type(uint128).max));
        vm.assume(signedAmount != sentAmount);

        PerihelionEscrow.Intent memory intent = _intent(signedAmount, block.timestamp + 600);
        bytes memory sig = _sign(userPk, intent);
        intent.sourceAmount = sentAmount; // tamper post-signing

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.InvalidSignature.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    /// cancelExpired opens exactly at `deadline + confirmationGrace`, never before.
    function testFuzz_CancelExpiredBoundary(uint256 warpTo) public {
        uint256 deadline = block.timestamp + 600;
        PerihelionEscrow.Intent memory intent = _intent(100_000, deadline);
        bytes memory sig = _sign(userPk, intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        uint256 opensAt = deadline + escrow.confirmationGrace();
        warpTo = bound(warpTo, block.timestamp, opensAt + 30 days);
        vm.warp(warpTo);

        if (warpTo < opensAt) {
            vm.expectRevert(PerihelionEscrow.DeadlineNotPassed.selector);
            escrow.cancelExpired(h);
        } else {
            uint256 userBefore = token.balanceOf(user);
            escrow.cancelExpired(h);
            assertEq(token.balanceOf(user), userBefore + 100_000); // user made whole
            assertEq(token.balanceOf(address(escrow)), 0);
            (,,,,,,, bool refunded) = escrow.locks(h);
            assertTrue(refunded);
        }
    }

    /// A reserved intent can only be locked by its preferred solver.
    function testFuzz_PreferredSolverEnforced(address caller, address preferred) public {
        vm.assume(preferred != address(0));
        vm.assume(caller != preferred);
        vm.assume(caller != address(0));

        PerihelionEscrow.Intent memory intent = _intent(100_000, block.timestamp + 600);
        intent.preferredSolver = preferred;
        bytes memory sig = _sign(userPk, intent);

        vm.deal(caller, 1 ether);
        vm.prank(caller);
        vm.expectRevert(PerihelionEscrow.ReservedForSolver.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }
}
