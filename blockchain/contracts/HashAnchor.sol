// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HashAnchor
/// @notice Minimal append-only ledger for anchoring content hashes on the
/// eGovChain (Hyperledger Besu, zero gas price). Used by Meralco Go to seal
/// a SHA-256 hash of each billing-cycle snapshot so later verification can
/// detect tampering. Only a hash + a short reference string are stored —
/// never the underlying bill data — to keep writes small and credit-cheap.
contract HashAnchor {
    struct Record {
        bytes32 hash;
        string ref;
        uint256 recordedAt;
        address submitter;
    }

    Record[] private records;

    event Anchored(uint256 indexed id, bytes32 indexed hash, string ref, uint256 recordedAt, address submitter);

    /// @notice Anchor a new hash + reference. Anyone may call this; the
    /// backend's deploy/signing key is the only caller in practice.
    /// @param hash A content hash (e.g. sha256 of a canonical JSON snapshot).
    /// @param ref A short human-readable reference, e.g. "cycle-2026-10@...".
    /// @return id The index of the new record, usable with getRecord().
    function anchor(bytes32 hash, string calldata ref) external returns (uint256 id) {
        id = records.length;
        records.push(Record({ hash: hash, ref: ref, recordedAt: block.timestamp, submitter: msg.sender }));
        emit Anchored(id, hash, ref, block.timestamp, msg.sender);
    }

    /// @notice Read back a previously anchored record by its index.
    function getRecord(uint256 id) external view returns (bytes32 hash, string memory ref, uint256 recordedAt, address submitter) {
        require(id < records.length, "HashAnchor: no such record");
        Record storage r = records[id];
        return (r.hash, r.ref, r.recordedAt, r.submitter);
    }

    /// @notice Total number of records anchored so far.
    function count() external view returns (uint256) {
        return records.length;
    }
}
