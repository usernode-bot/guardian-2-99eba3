const ethers = require('ethers');

const CONTRACT_ABI = [
  {
    type: 'function',
    name: 'recordTokenTransfer',
    inputs: [
      { name: 'txHash', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'getTransfer',
    inputs: [{ name: 'txHash', type: 'bytes32' }],
    outputs: [
      {
        components: [
          { name: 'sender', type: 'address' },
          { name: 'recipient', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'timestamp', type: 'uint256' },
          { name: 'confirmed', type: 'bool' }
        ],
        type: 'tuple'
      }
    ],
    stateMutability: 'view'
  },
  {
    type: 'event',
    name: 'TokenTransferred',
    inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'txHash', type: 'bytes32', indexed: false }
    ]
  }
];

class ContractClient {
  constructor(contractAddress, privateKey, rpcUrl) {
    this.contractAddress = contractAddress;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.contract = new ethers.Contract(contractAddress, CONTRACT_ABI, this.wallet);
    this.txStatusCache = new Map();
  }

  async recordTokenTransfer(txHash, recipient, amount) {
    try {
      const tx = await this.contract.recordTokenTransfer(txHash, recipient, BigInt(amount));
      const receipt = await tx.wait();
      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber
      };
    } catch (err) {
      console.error('Error recording token transfer:', err.message);
      return {
        success: false,
        error: err.message
      };
    }
  }

  async pollTransactionStatus(txHash) {
    try {
      const cached = this.txStatusCache.get(txHash);
      if (cached && Date.now() - cached.timestamp < 30000) {
        return cached.data;
      }

      const receipt = await this.provider.getTransactionReceipt(txHash);

      if (!receipt) {
        return {
          status: 'pending',
          blockNumber: null,
          timestamp: null,
          explorerUrl: null
        };
      }

      const block = await this.provider.getBlock(receipt.blockNumber);
      const baseUrl = process.env.BLOCK_EXPLORER_URL || 'https://etherscan.io';
      const explorerUrl = `${baseUrl}/tx/${txHash}`;

      const data = {
        status: receipt.status === 1 ? 'confirmed' : 'failed',
        blockNumber: receipt.blockNumber,
        timestamp: block.timestamp,
        explorerUrl
      };

      this.txStatusCache.set(txHash, { data, timestamp: Date.now() });
      return data;
    } catch (err) {
      console.error('Error polling transaction status:', err.message);
      return {
        status: 'pending',
        blockNumber: null,
        timestamp: null,
        explorerUrl: null
      };
    }
  }

  async getTransferStatus(txHash) {
    try {
      return await this.contract.getTransfer(txHash);
    } catch (err) {
      console.error('Error getting transfer status:', err.message);
      return null;
    }
  }

  isInitialized() {
    return !!this.contractAddress && this.contractAddress !== '0x';
  }
}

let clientInstance = null;

function initializeContractClient() {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const privateKey = process.env.CONTRACT_PRIVATE_KEY;
  const rpcUrl = process.env.NODE_RPC_URL || 'http://host.docker.internal:3001';

  if (!contractAddress || !privateKey) {
    console.warn('Contract client not initialized: missing CONTRACT_ADDRESS or CONTRACT_PRIVATE_KEY');
    return null;
  }

  try {
    clientInstance = new ContractClient(contractAddress, privateKey, rpcUrl);
    console.log('Contract client initialized:', contractAddress);
    return clientInstance;
  } catch (err) {
    console.error('Failed to initialize contract client:', err.message);
    return null;
  }
}

function getContractClient() {
  if (!clientInstance) {
    clientInstance = initializeContractClient();
  }
  return clientInstance;
}

module.exports = {
  ContractClient,
  initializeContractClient,
  getContractClient
};
