// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract GuardianMessaging {
    struct Message {
        address sender;
        address recipient;
        string contentHash;
        uint256 timestamp;
    }

    struct TokenTransfer {
        address sender;
        address recipient;
        uint256 amount;
        uint256 timestamp;
        bool confirmed;
    }

    mapping(address => Message[]) public userMessages;
    mapping(bytes32 => TokenTransfer) public transfers;

    event MessageRecorded(address indexed sender, address indexed recipient, string contentHash, uint256 timestamp);
    event TokenTransferred(address indexed sender, address indexed recipient, uint256 amount, bytes32 txHash);

    function recordMessage(address recipient, string memory contentHash) public {
        require(recipient != address(0), "Invalid recipient");

        Message memory msg = Message({
            sender: msg.sender,
            recipient: recipient,
            contentHash: contentHash,
            timestamp: block.timestamp
        });

        userMessages[msg.sender].push(msg);
        userMessages[recipient].push(msg);

        emit MessageRecorded(msg.sender, recipient, contentHash, block.timestamp);
    }

    function recordTokenTransfer(bytes32 txHash, address recipient, uint256 amount) public {
        require(recipient != address(0), "Invalid recipient");
        require(amount > 0, "Amount must be greater than 0");
        require(transfers[txHash].timestamp == 0, "Transfer already recorded");

        TokenTransfer memory transfer = TokenTransfer({
            sender: msg.sender,
            recipient: recipient,
            amount: amount,
            timestamp: block.timestamp,
            confirmed: true
        });

        transfers[txHash] = transfer;
        emit TokenTransferred(msg.sender, recipient, amount, txHash);
    }

    function getMessages(address user) public view returns (Message[] memory) {
        return userMessages[user];
    }

    function getTransferStatus(bytes32 txHash) public view returns (bool confirmed) {
        return transfers[txHash].timestamp != 0;
    }

    function getTransfer(bytes32 txHash) public view returns (TokenTransfer memory) {
        return transfers[txHash];
    }
}
