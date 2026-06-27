import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || '';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = __dirname;

// Demo mode - add mock data for testing without real API
const DEMO_MODE = process.env.DEMO_MODE === 'true' || !ETHERSCAN_API_KEY;

function getDemoTransaction(hash) {
  return {
    hash: hash,
    from: '0x742d35Cc6634C0532925a3b844Bc9e7595f1234567890',
    to: '0x8a2d35Cc6634C0532925a3b844Bc9e7595fABCDEF12',
    value: '0x1bc16d74e8d7000',
    valueEth: 1.234,
    gas: '0x5208',
    gasPrice: '0x4a817c800',
    timeStamp: Math.floor(Date.now() / 1000).toString(),
    blockNumber: '0x112f0b9',
    isError: '0',
    explorerUrl: `https://etherscan.io/tx/${hash}`
  };
}

function getDemoAddressTransactions(address) {
  const now = Date.now();
  return [
    { hash: '0x' + Math.random().toString(16).substr(2, 64), from: address, to: '0x1111111111111111111111111111111111111111', value: '0x38d7ea4c68000', valueEth: 0.99, blockNumber: '0x112f0a0', timeStamp: Math.floor((now - 3600000) / 1000).toString(), isError: '0' },
    { hash: '0x' + Math.random().toString(16).substr(2, 64), from: '0x2222222222222222222222222222222222222222', to: address, value: '0x4563918244f4000', valueEth: 4.99, blockNumber: '0x112f0a1', timeStamp: Math.floor((now - 7200000) / 1000).toString(), isError: '0' },
    { hash: '0x' + Math.random().toString(16).substr(2, 64), from: address, to: '0x3333333333333333333333333333333333333333', value: '0x8ac7230489e8000', valueEth: 10.0, blockNumber: '0x112f0a2', timeStamp: Math.floor((now - 86400000) / 1000).toString(), isError: '0' }
  ];
}

const CHAINS = {
  ethereum: {
    aliases: ['eth'],
    apiMode: 'etherscan-v2',
    chainId: 1,
    apiKeyEnv: 'ETHERSCAN_API_KEY',
    symbol: 'ETH',
    explorer: 'https://etherscan.io'
  },
  binance: {
    aliases: ['bsc', 'bnb'],
    apiMode: 'rpc',
    rpcUrls: [
      'https://bsc-dataseed.binance.org',
      'https://bsc-dataseed1.bnbchain.org',
      'https://bsc-dataseed2.bnbchain.org'
    ],
    chainId: 56,
    symbol: 'BNB',
    explorer: 'https://bscscan.com'
  },
  polygon: {
    aliases: ['matic', 'pol'],
    apiMode: 'etherscan-v2',
    chainId: 137,
    apiKeyEnv: 'ETHERSCAN_API_KEY',
    symbol: 'MATIC',
    explorer: 'https://polygonscan.com'
  }
};

const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const KNOWN_TOKENS = {
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 }
};

app.use(cors());
app.use(express.json());
app.use(express.static(PROJECT_ROOT));

function getChain(network = 'ethereum') {
  const normalized = String(network).toLowerCase();
  const key = Object.keys(CHAINS).find((name) => {
    return name === normalized || CHAINS[name].aliases.includes(normalized);
  });

  return key ? { id: key, ...CHAINS[key] } : null;
}

function getApiKey(chain) {
  if (chain.apiMode === 'rpc') {
    return '';
  }

  if (chain.apiKeyEnv === 'BSCSCAN_API_KEY') {
    return BSCSCAN_API_KEY;
  }

  return ETHERSCAN_API_KEY;
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value || '');
}

function isTxHash(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(value || '');
}

function weiToNative(wei) {
  try {
    const value = BigInt(wei || '0');
    const whole = value / 10n ** 18n;
    const fraction = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
    return Number(`${whole}.${fraction}`);
  } catch {
    return 0;
  }
}

function hexWeiToNative(hexValue) {
  try {
    return weiToNative(BigInt(hexValue || '0x0').toString());
  } catch {
    return 0;
  }
}

function normalizeTx(tx, chain) {
  const valueNative = tx.value?.startsWith?.('0x') ? hexWeiToNative(tx.value) : weiToNative(tx.value);
  const timestamp = tx.timeStamp ? Number(tx.timeStamp) * 1000 : null;

  return {
    hash: tx.hash,
    from: tx.from,
    to: tx.to,
    valueWei: tx.value,
    valueNative,
    symbol: chain.symbol,
    blockNumber: Number.parseInt(tx.blockNumber || tx.blockNumber === 0 ? tx.blockNumber : '0', tx.blockNumber?.startsWith?.('0x') ? 16 : 10),
    timestamp,
    isError: tx.isError === '1',
    explorerUrl: tx.hash ? `${chain.explorer}/tx/${tx.hash}` : null,
    raw: tx
  };
}

async function rpcRequest(chain, method, params = []) {
  const urls = chain.rpcUrls || [];
  let lastError = null;

  for (const url of urls) {
    try {
      const response = await axios.post(url, {
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params
      }, {
        timeout: 12000
      });

      if (response.data?.error) {
        throw new Error(response.data.error.message || 'RPC request failed');
      }

      return response.data?.result ?? null;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`BNB RPC unavailable: ${lastError?.message || 'all public RPC endpoints failed'}`);
}

async function scannerRequest(chain, params) {
  if (chain.apiMode === 'rpc') {
    throw new Error('Explorer scanner endpoint is unavailable in RPC mode.');
  }

  const apiKey = getApiKey(chain);
  if (!apiKey) {
    throw new Error(`Missing ${chain.apiKeyEnv}. Create a free key and add it to backend/.env.`);
  }

  const url = chain.apiMode === 'explorer-v1' ? chain.apiHost : 'https://api.etherscan.io/v2/api';
  const requestParams = {
    ...params,
    apikey: apiKey
  };

  if (chain.apiMode === 'etherscan-v2') {
    requestParams.chainid = chain.chainId;
  }

  const response = await axios.get(url, {
    params: {
      ...requestParams
    },
    timeout: 12000
  });

  const payload = response.data;
  if (payload?.status === '0' && payload?.message !== 'No transactions found') {
    const details = typeof payload.result === 'string'
      ? payload.result
      : payload.message || JSON.stringify(payload.result || {});
    const keyHint = chain.apiKeyEnv === 'BSCSCAN_API_KEY'
      ? 'Create a free BscScan key and set BSCSCAN_API_KEY in backend/.env.'
      : 'Check your Etherscan API key and plan.';
    throw new Error(`${details || 'Explorer API request failed'} ${keyHint}`);
  }

  return payload;
}

async function getTransactionByHash(hash, chain) {
  // Demo mode - return mock data
  if (DEMO_MODE) {
    return normalizeTx(getDemoTransaction(hash), chain);
  }

  if (chain.apiMode === 'rpc') {
    const tx = await rpcRequest(chain, 'eth_getTransactionByHash', [hash]);
    return tx ? normalizeTx(tx, chain) : null;
  }

  const payload = await scannerRequest(chain, {
    module: 'proxy',
    action: 'eth_getTransactionByHash',
    txhash: hash
  });

  if (!payload.result) return null;
  return normalizeTx(payload.result, chain);
}

async function getTransactionReceipt(hash, chain) {
  if (chain.apiMode === 'rpc') {
    return await rpcRequest(chain, 'eth_getTransactionReceipt', [hash]);
  }

  const payload = await scannerRequest(chain, {
    module: 'proxy',
    action: 'eth_getTransactionReceipt',
    txhash: hash
  });

  return payload.result || null;
}

async function getAddressInfo(address, chain) {
// Demo mode - return mock data
  if (DEMO_MODE) {
    return {
      address,
      balanceWei: '0x' + Math.floor(Math.random() * 1000).toString(16) + '000000000000000',
      balanceNative: Math.random() * 50,
      symbol: chain.symbol,
      isContract: false,
      transactionCount: 3,
      transactions: getDemoAddressTransactions(address).map(tx => normalizeTx(tx, chain)),
      explorerUrl: `${chain.explorer}/address/${address}`,
      dataSource: 'demo-mode',
      historyAvailable: true,
      historyNote: 'Demo data (no API key needed)'
    };
  }

  if (chain.apiMode === 'rpc') {
    const [balanceWei, code] = await Promise.all([
      rpcRequest(chain, 'eth_getBalance', [address, 'latest']),
      rpcRequest(chain, 'eth_getCode', [address, 'latest'])
    ]);

    return {
      address,
      balanceWei: BigInt(balanceWei || '0x0').toString(),
      balanceNative: hexWeiToNative(balanceWei || '0x0'),
      symbol: chain.symbol,
      isContract: code !== '0x' && code !== '0x0',
      transactionCount: null,
      transactions: [],
      explorerUrl: `${chain.explorer}/address/${address}`,
      dataSource: 'public-rpc',
      historyAvailable: false,
      historyNote: 'Public RPC does not provide indexed wallet transaction history.'
    };
  }

  const [balancePayload, codePayload, txPayload] = await Promise.all([
    scannerRequest(chain, {
      module: 'account',
      action: 'balance',
      address,
      tag: 'latest'
    }),
    scannerRequest(chain, {
      module: 'proxy',
      action: 'eth_getCode',
      address,
      tag: 'latest'
    }),
    scannerRequest(chain, {
      module: 'account',
      action: 'txlist',
      address,
      startblock: 0,
      endblock: 99999999,
      page: 1,
      offset: 25,
      sort: 'desc'
    }).catch((err) => ({ result: [], historyError: err.message }))
  ]);

  const balanceWei = balancePayload.result || '0';
  const code = typeof codePayload.result === 'string' ? codePayload.result : '0x';
  const historyAvailable = !txPayload.historyError && Array.isArray(txPayload.result);
  const transactions = Array.isArray(txPayload.result)
    ? txPayload.result.map((tx) => normalizeTx(tx, chain))
    : [];

  return {
    address,
    balanceWei,
    balanceNative: weiToNative(balanceWei),
    symbol: chain.symbol,
    isContract: code !== '0x' && code !== '0x0',
    transactionCount: historyAvailable ? transactions.length : null,
    transactions,
    explorerUrl: `${chain.explorer}/address/${address}`,
    dataSource: 'explorer-api',
    historyAvailable,
    historyNote: historyAvailable ? null : 'Explorer did not return indexed wallet transaction history.'
  };
}

async function getAddressTransactions(address, chain, sort = 'desc', offset = 25) {
  if (chain.apiMode === 'rpc') {
    return [];
  }

  const payload = await scannerRequest(chain, {
    module: 'account',
    action: 'txlist',
    address,
    startblock: 0,
    endblock: 99999999,
    page: 1,
    offset,
    sort
  });

  return Array.isArray(payload.result) ? payload.result.map((tx) => normalizeTx(tx, chain)) : [];
}

function amountLabel(value, symbol) {
  if (!value) return `0 ${symbol}`;
  if (value < 0.000001) return `<0.000001 ${symbol}`;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}`;
}

function topicToAddress(topic) {
  if (!topic || topic.length < 42) return null;
  return `0x${topic.slice(-40)}`;
}

function formatTokenAmount(hexValue, tokenAddress) {
  const token = KNOWN_TOKENS[tokenAddress?.toLowerCase()] || { symbol: 'tokens', decimals: 18 };
  try {
    const raw = BigInt(hexValue || '0x0');
    const divisor = 10n ** BigInt(token.decimals);
    const whole = raw / divisor;
    const fraction = (raw % divisor).toString().padStart(token.decimals, '0').slice(0, 6);
    const value = Number(`${whole}.${fraction}`);
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${token.symbol}`;
  } catch {
    return `0 ${token.symbol}`;
  }
}

function extractTokenTransfers(receipt) {
  const logs = Array.isArray(receipt?.logs) ? receipt.logs : [];
  return logs
    .filter((log) => log.topics?.[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC && log.topics.length >= 3)
    .map((log) => ({
      token: log.address,
      from: topicToAddress(log.topics[1]),
      to: topicToAddress(log.topics[2]),
      amount: formatTokenAmount(log.data, log.address),
      rawAmount: log.data
    }));
}

function choosePrimaryTokenTransfer(transfers, txFrom) {
  if (!transfers.length) return null;
  const sender = txFrom?.toLowerCase();
  return transfers.find((transfer) => transfer.from?.toLowerCase() === sender) || transfers[transfers.length - 1];
}

function uniqueCount(values) {
  return new Set(values.filter(Boolean).map((value) => value.toLowerCase())).size;
}

function summarizeActivity(transactions = [], address = '') {
  const normalized = address.toLowerCase();
  const incoming = transactions.filter((tx) => tx.to?.toLowerCase() === normalized);
  const outgoing = transactions.filter((tx) => tx.from?.toLowerCase() === normalized);
  const timestamps = transactions.map((tx) => tx.timestamp).filter(Boolean);
  const firstSeen = timestamps.length ? Math.min(...timestamps) : null;
  const lastSeen = timestamps.length ? Math.max(...timestamps) : null;
  const totalVolumeNative = transactions.reduce((sum, tx) => sum + (Number(tx.valueNative) || 0), 0);
  const counterparties = uniqueCount(transactions.map((tx) => {
    if (tx.from?.toLowerCase() === normalized) return tx.to;
    if (tx.to?.toLowerCase() === normalized) return tx.from;
    return tx.from || tx.to;
  }));

  return {
    incomingCount: incoming.length,
    outgoingCount: outgoing.length,
    counterpartyCount: counterparties,
    totalVolumeNative,
    firstSeen,
    lastSeen,
    ageDays: firstSeen ? Math.max(1, Math.round((Date.now() - firstSeen) / 86400000)) : null,
    latestActivity: lastSeen ? new Date(lastSeen).toISOString() : null
  };
}

function findLikelyNextHop(seedTx, receiverTransactions) {
  if (!seedTx?.to || !receiverTransactions?.length) return null;
  const receiver = seedTx.to.toLowerCase();

  return receiverTransactions
    .filter((tx) => {
      if (!tx.from || tx.from.toLowerCase() !== receiver) return false;
      if (!tx.to || tx.to.toLowerCase() === receiver) return false;
      if (seedTx.blockNumber && tx.blockNumber && tx.blockNumber < seedTx.blockNumber) return false;
      return tx.hash !== seedTx.hash;
    })
    .sort((a, b) => (a.blockNumber || 0) - (b.blockNumber || 0))[0] || null;
}

function buildPatterns({ tx, endInfo, nextHop, activity, tokenTransfers = [] }) {
  const details = {
    timeDelay: {
      active: false,
      label: 'Time Delay',
      evidence: 'No delayed follow-up transfer found in recent activity.',
      score: 0
    },
    amountSplitting: {
      active: false,
      label: 'Amount Splitting',
      evidence: 'No smaller forwarded amount detected after the seed transfer.',
      score: 0
    },
    crossChain: {
      active: false,
      label: 'Bridge-like Activity',
      evidence: 'No zero-value contract call after a value transfer was detected.',
      score: 0
    },
    mixerUsage: {
      active: false,
      label: 'High Churn',
      evidence: 'Recent activity does not show high counterparty churn.',
      score: 0
    }
  };

  if (nextHop && tx?.timestamp && nextHop.timestamp) {
    const minutes = Math.abs(nextHop.timestamp - tx.timestamp) / 60000;
    details.timeDelay.active = minutes > 10 && minutes < 1440;
    details.timeDelay.score = details.timeDelay.active ? 16 : 4;
    details.timeDelay.evidence = details.timeDelay.active
      ? `Forwarded after about ${Math.round(minutes)} minutes.`
      : `Follow-up transfer happened after ${Math.round(minutes)} minutes.`;
  }

  if (nextHop && tx?.valueNative && nextHop.valueNative !== undefined) {
    const retained = tx.valueNative > 0 ? nextHop.valueNative / tx.valueNative : 0;
    details.amountSplitting.active = nextHop.valueNative > 0 && retained < 0.95;
    details.amountSplitting.score = details.amountSplitting.active ? 18 : 3;
    details.amountSplitting.evidence = details.amountSplitting.active
      ? `Forwarded ${Math.round(retained * 100)}% of the original native value.`
      : 'Follow-up amount is close to the original value.';
  }

  details.crossChain.active = Boolean(nextHop && nextHop.valueNative === 0 && tx?.valueNative > 0);
  details.crossChain.score = details.crossChain.active ? 12 : 0;
  if (details.crossChain.active) {
    details.crossChain.evidence = 'Receiver made a zero-value contract call after receiving native value.';
  }

  const churnActive = Boolean(endInfo?.transactionCount >= 20 || activity?.counterpartyCount >= 10 || (tx?.valueNative >= 10 && nextHop));
  details.mixerUsage.active = churnActive;
  details.mixerUsage.score = churnActive ? 20 : 2;
  details.mixerUsage.evidence = churnActive
    ? `${activity?.counterpartyCount || 0} counterparties across ${endInfo?.transactionCount || 0} recent transactions.`
    : `${activity?.counterpartyCount || 0} counterparties in recent history.`;

  if (tokenTransfers.length > 1) {
    details.amountSplitting.active = true;
    details.amountSplitting.score = Math.max(details.amountSplitting.score, 18);
    details.amountSplitting.evidence = `${tokenTransfers.length} token transfer events occurred inside the transaction.`;
  }

  const flags = Object.fromEntries(Object.entries(details).map(([key, value]) => [key, value.active]));

  return { flags, details };
}

function assessRisk({ tx, endInfo, receipt, nextHop, patternDetails, activity, tokenTransfers = [] }) {
  let score = 20;
  const factors = [];

  if (tx?.valueNative >= 10) {
    score += 25;
    factors.push({ label: 'Large transfer value', weight: 25, detail: amountLabel(tx.valueNative, tx.symbol || endInfo?.symbol || '') });
  } else if (tx?.valueNative >= 1) {
    score += 12;
    factors.push({ label: 'Medium transfer value', weight: 12, detail: amountLabel(tx.valueNative, tx.symbol || endInfo?.symbol || '') });
  }

  if (receipt?.status === '0x0' || tx?.isError) {
    score += 20;
    factors.push({ label: 'Failed transaction signal', weight: 20, detail: 'Explorer reports a failed status.' });
  }

  if (tokenTransfers.length) {
    const weight = tokenTransfers.length > 1 ? 10 : 5;
    score += weight;
    factors.push({
      label: 'Token transfer detected',
      weight,
      detail: `${tokenTransfers.length} ERC-20 transfer event${tokenTransfers.length === 1 ? '' : 's'} parsed from the receipt.`
    });
  }

  if (endInfo?.isContract) {
    score += 15;
    factors.push({ label: 'Receiver is a contract', weight: 15, detail: 'Contract wallets can route funds through additional logic.' });
  }

  if (nextHop) {
    score += 18;
    factors.push({ label: 'Receiver forwarded funds', weight: 18, detail: `Next hop ${nextHop.to}` });
  }

  Object.values(patternDetails || {}).forEach((pattern) => {
    if (pattern.active) {
      score += pattern.score;
      factors.push({ label: pattern.label, weight: pattern.score, detail: pattern.evidence });
    }
  });

  if (activity?.outgoingCount > activity?.incomingCount && activity.outgoingCount >= 5) {
    score += 8;
    factors.push({ label: 'Outbound-heavy wallet', weight: 8, detail: `${activity.outgoingCount} outgoing vs ${activity.incomingCount} incoming recent transactions.` });
  }

  const confidence = Math.min(96, Math.max(45, 54 + factors.length * 7 + (nextHop ? 10 : 0)));
  const level = score >= 65 ? 'high' : score >= 38 ? 'medium' : 'low';

  return {
    level,
    score: Math.min(100, score),
    confidence,
    reasons: factors.map((factor) => factor.label.toLowerCase()),
    factors
  };
}

function buildEndReceiver({ inputType, tx, wallet, nextHop, flow, chain, directReceiver, sourceHint }) {
  const candidate = nextHop?.to || directReceiver || (inputType === 'transaction' ? tx?.to : wallet?.address);
  const source = nextHop ? 'follow-up transfer' : sourceHint || (inputType === 'transaction' ? 'direct transaction receiver' : 'analyzed wallet');
  const node = [...flow].reverse().find((item) => item.address?.toLowerCase() === candidate?.toLowerCase());

  return {
    address: candidate || null,
    label: nextHop ? 'Likely End Receiver' : 'Current End Receiver',
    source,
    confidence: nextHop ? 82 : 64,
    amount: node?.amount || amountLabel(wallet?.balanceNative || tx?.valueNative || 0, chain.symbol),
    explorerUrl: candidate ? `${chain.explorer}/address/${candidate}` : null
  };
}

async function analyzeInput(input, chain) {
  if (isTxHash(input)) {
    const tx = await getTransactionByHash(input, chain);
    if (!tx) {
      const error = new Error('Transaction not found');
      error.status = 404;
      throw error;
    }

    const receipt = await getTransactionReceipt(input, chain).catch(() => null);
    const tokenTransfers = extractTokenTransfers(receipt);
    const primaryTokenTransfer = choosePrimaryTokenTransfer(tokenTransfers, tx.from);
    const directReceiver = primaryTokenTransfer?.to || tx.to;
    const [fromInfo, endInfo] = await Promise.all([
      tx.from ? getAddressInfo(tx.from, chain).catch(() => null) : null,
      directReceiver ? getAddressInfo(directReceiver, chain).catch(() => null) : null
    ]);

    const traceTx = { ...tx, to: directReceiver };
    const receiverTransactions = endInfo?.transactions?.length
      ? endInfo.transactions
      : directReceiver ? await getAddressTransactions(directReceiver, chain).catch(() => []) : [];
    const nextHop = findLikelyNextHop(traceTx, receiverTransactions);
    const activity = summarizeActivity(receiverTransactions, directReceiver);
    const { flags: patterns, details: patternDetails } = buildPatterns({ tx: traceTx, endInfo, nextHop, activity, tokenTransfers });
    const flow = [
      {
        label: 'Origin Wallet',
        role: 'origin',
        address: primaryTokenTransfer?.from || tx.from,
        amount: primaryTokenTransfer?.amount || amountLabel(tx.valueNative, chain.symbol),
        explorerUrl: tx.from ? `${chain.explorer}/address/${tx.from}` : null
      }
    ];

    if (primaryTokenTransfer?.token && primaryTokenTransfer.token.toLowerCase() !== directReceiver?.toLowerCase()) {
      flow.push({
        label: `${KNOWN_TOKENS[primaryTokenTransfer.token.toLowerCase()]?.symbol || 'Token'} Contract`,
        role: 'intermediate',
        address: primaryTokenTransfer.token,
        amount: primaryTokenTransfer.amount,
        explorerUrl: `${chain.explorer}/address/${primaryTokenTransfer.token}`
      });
    }

    flow.push({
      label: endInfo?.isContract ? 'Receiving Contract' : 'Receiver Wallet',
      role: nextHop ? 'intermediate' : 'end-receiver',
      address: directReceiver,
      amount: primaryTokenTransfer?.amount || amountLabel(tx.valueNative, chain.symbol),
      explorerUrl: directReceiver ? `${chain.explorer}/address/${directReceiver}` : null
    });

    if (nextHop) {
      flow.push({
        label: 'Likely End Receiver',
        role: 'end-receiver',
        address: nextHop.to,
        amount: amountLabel(nextHop.valueNative, chain.symbol),
        explorerUrl: `${chain.explorer}/address/${nextHop.to}`
      });
    }
    const risk = assessRisk({ tx, endInfo, receipt, nextHop, patternDetails, activity, tokenTransfers });
    const endReceiver = buildEndReceiver({
      inputType: 'transaction',
      tx,
      wallet: endInfo,
      nextHop,
      flow,
      chain,
      directReceiver,
      sourceHint: primaryTokenTransfer ? 'ERC-20 Transfer event' : undefined
    });

    return {
      inputType: 'transaction',
      chain: { id: chain.id, symbol: chain.symbol, explorer: chain.explorer },
      transaction: tx,
      flow,
      risk,
      patterns,
      patternDetails,
      activity,
      endReceiver,
      tokenTransfers,
      wallet: endInfo,
      stats: {
        hops: flow.length - 1,
        chains: patterns.crossChain ? 2 : 1,
        confidence: risk.confidence,
        transactionCount: endInfo?.transactionCount ?? null,
        associatedWallets: endInfo?.historyAvailable
          ? new Set(receiverTransactions.map((item) => item.to || item.from).filter(Boolean).map((item) => item.toLowerCase())).size
          : null
      }
    };
  }

  if (isAddress(input)) {
    const wallet = await getAddressInfo(input, chain);
    const latestTx = wallet.transactions[0] || null;
    const incoming = wallet.transactions.find((tx) => tx.to?.toLowerCase() === input.toLowerCase());
    const outgoing = wallet.transactions.find((tx) => tx.from?.toLowerCase() === input.toLowerCase());
    const seedTx = incoming || latestTx;
    const nextHop = outgoing && incoming && outgoing.blockNumber >= incoming.blockNumber ? outgoing : null;
    const activity = summarizeActivity(wallet.transactions, wallet.address);
    const { flags: patterns, details: patternDetails } = buildPatterns({ tx: seedTx, endInfo: wallet, nextHop, activity });
    const flow = [];

    if (incoming?.from) {
      flow.push({
        label: 'Recent Sender',
        role: 'origin',
        address: incoming.from,
        amount: amountLabel(incoming.valueNative, chain.symbol),
        explorerUrl: `${chain.explorer}/address/${incoming.from}`
      });
    }

    flow.push({
      label: wallet.isContract ? 'Analyzed Contract' : 'Analyzed Wallet',
      role: nextHop ? 'intermediate' : 'end-receiver',
      address: wallet.address,
      amount: amountLabel(wallet.balanceNative, chain.symbol),
      explorerUrl: wallet.explorerUrl
    });

    if (nextHop?.to) {
      flow.push({
        label: 'Likely End Receiver',
        role: 'end-receiver',
        address: nextHop.to,
        amount: amountLabel(nextHop.valueNative, chain.symbol),
        explorerUrl: `${chain.explorer}/address/${nextHop.to}`
      });
    }
    const risk = assessRisk({ tx: seedTx, endInfo: wallet, receipt: null, nextHop, patternDetails, activity });
    const endReceiver = buildEndReceiver({ inputType: 'address', tx: seedTx, wallet, nextHop, flow, chain });

    return {
      inputType: 'address',
      chain: { id: chain.id, symbol: chain.symbol, explorer: chain.explorer },
      transaction: latestTx,
      flow,
      risk,
      patterns,
      patternDetails,
      activity,
      endReceiver,
      wallet,
      stats: {
        hops: Math.max(0, flow.length - 1),
        chains: patterns.crossChain ? 2 : 1,
        confidence: risk.confidence,
        transactionCount: wallet.transactionCount,
        associatedWallets: wallet.historyAvailable
          ? new Set(wallet.transactions.map((item) => item.to || item.from).filter(Boolean).map((item) => item.toLowerCase())).size
          : null
      }
    };
  }

  const error = new Error('Enter a valid EVM transaction hash or wallet address');
  error.status = 400;
  throw error;
}

function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      res.status(err.status || 500).json({
        success: false,
        error: err?.message || String(err) || 'Unexpected server error'
      });
    }
  };
}

function requireChain(req, res) {
  const chain = getChain(req.query.network || req.query.chain || 'ethereum');
  if (!chain) {
    res.status(400).json({
      success: false,
      error: 'Unsupported chain. This prototype currently supports Ethereum, BNB Chain, and Polygon.'
    });
    return null;
  }
  return chain;
}

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    service: 'ChainTrace backend',
    supportedChains: Object.keys(CHAINS),
    apiKeys: {
      etherscan: Boolean(ETHERSCAN_API_KEY),
      bscscan: Boolean(BSCSCAN_API_KEY)
    },
    bnbDataSource: 'public-rpc'
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PROJECT_ROOT, 'hackathon_prototype.html'));
});

app.get('/api/analyze/:input', asyncRoute(async (req, res) => {
  const chain = requireChain(req, res);
  if (!chain) return;

  const analysis = await analyzeInput(req.params.input, chain);
  res.json({ success: true, data: analysis });
}));

app.get('/api/bnb/analyze/:input', asyncRoute(async (req, res) => {
  const analysis = await analyzeInput(req.params.input, getChain('binance'));
  res.json({ success: true, data: analysis });
}));

app.get('/api/tx/:hash', asyncRoute(async (req, res) => {
  const chain = requireChain(req, res);
  if (!chain) return;

  if (!isTxHash(req.params.hash)) {
    res.status(400).json({ success: false, error: 'Invalid transaction hash' });
    return;
  }

  const tx = await getTransactionByHash(req.params.hash, chain);
  if (!tx) {
    res.status(404).json({ success: false, error: 'Transaction not found' });
    return;
  }

  res.json({ success: true, data: tx });
}));

app.get('/api/bnb/tx/:hash', asyncRoute(async (req, res) => {
  const chain = getChain('binance');

  if (!isTxHash(req.params.hash)) {
    res.status(400).json({ success: false, error: 'Invalid transaction hash' });
    return;
  }

  const tx = await getTransactionByHash(req.params.hash, chain);
  if (!tx) {
    res.status(404).json({ success: false, error: 'Transaction not found' });
    return;
  }

  res.json({ success: true, data: tx });
}));

app.get('/api/wallet/:address', asyncRoute(async (req, res) => {
  const chain = requireChain(req, res);
  if (!chain) return;

  if (!isAddress(req.params.address)) {
    res.status(400).json({ success: false, error: 'Invalid wallet address' });
    return;
  }

  const wallet = await getAddressInfo(req.params.address, chain);
  res.json({
    success: true,
    balanceWei: wallet.balanceWei,
    balanceEth: wallet.balanceNative,
    balanceNative: wallet.balanceNative,
    symbol: wallet.symbol
  });
}));

app.get('/api/address/:address', asyncRoute(async (req, res) => {
  const chain = requireChain(req, res);
  if (!chain) return;

  if (!isAddress(req.params.address)) {
    res.status(400).json({ success: false, error: 'Invalid wallet address' });
    return;
  }

  const wallet = await getAddressInfo(req.params.address, chain);
  res.json({ success: true, ...wallet });
}));

app.get('/api/bnb/address/:address', asyncRoute(async (req, res) => {
  const chain = getChain('binance');

  if (!isAddress(req.params.address)) {
    res.status(400).json({ success: false, error: 'Invalid wallet address' });
    return;
  }

  const wallet = await getAddressInfo(req.params.address, chain);
  res.json({ success: true, ...wallet });
}));

app.listen(PORT, () => {
  console.log(`ChainTrace backend running on http://localhost:${PORT}`);
});
