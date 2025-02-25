import { Contract, ContractTransaction, Wallet, getDefaultProvider, utils } from 'ethers';
import { verifyMessage } from 'ethers/utils';
import { readFileSync } from 'fs';
import { join } from 'path';
import pino from 'pino';
import {
  getEvent,
  getEvents,
  getPoapSettingByName,
  saveTransaction,
  getSigner,
  getAvailableHelperSigners,
  getTransaction
} from './db';
import getEnv from './envs';
import { Poap } from './poap-eth/Poap';
import {
  Address,
  Claim,
  TokenInfo,
  Signer,
  TransactionStatus,
  OperationType,
} from './types';

const Logger = pino();
const ABI_DIR = join(__dirname, '../abi');

export function getABI(name: string) {
  return JSON.parse(readFileSync(join(ABI_DIR, `${name}.json`)).toString());
}

const ABI = getABI('Poap');

export function getContract(wallet: Wallet): Poap {
  const env = getEnv();
  return new Contract(env.poapAddress, ABI, wallet) as Poap;
}

/**
 * Get an available helper signer in order to sign a new requested transaction
 */
export async function getHelperSigner(): Promise<null | Wallet> {
  const env = getEnv();
  let signers: null | Signer[] = await getAvailableHelperSigners();

  let wallet: null | Wallet = null;

  if (signers) {
    signers = await Promise.all(signers.map(signer => getAddressBalance(signer)));
    for (let signer of signers) {
      if (!wallet) {
        console.log('signerWithBalance: ', signer);
        if (signer.balance !== '0') {
          wallet = env.poapHelpers[signer.signer.toLowerCase()];
        }
      }
    }
  }
  return wallet;
}

/**
 * Get an available helper signer in order to sign a new requested transaction
 */
export async function getSignerWallet(address: Address): Promise<Wallet> {
  const env = getEnv();
  const signer: null | Signer = await getSigner(address);
  if (signer) {
    const wallet = env.poapHelpers[signer.signer.toLowerCase()];
    return wallet;
  }
  throw new Error('Signer was not found');
}

/**
 * Estimate gas cost for mintTokenBatch() call.
 * We don't rely on estimateGas() since it fails.
 *
 * The estimated is based on empirical tests and it's
 * also +50% of the actual empirical estimate
 * @param n number of addresses
 */
export function estimateMintingGas(n: number) {
  const delta = 1369070;
  const baseCost = 35708;
  return (baseCost + n * delta) * 1.5;
}

/**
 * Get current gas price from Poap Settings singleton
 */
export async function getCurrentGasPrice(address: string) {
  // Default gas price (to be used only when no gas-price configuration detected)
  let gasPrice = 5e9;

  // Get defined gasPrice for selected signer
  let signer: Signer | null = await getSigner(address);
  if (signer) {
    if (signer.gas_price) {
      return parseInt(signer.gas_price);
    }
  }

  // If signer was not defined, then get gas-price value from db Poap Setting variable
  let gasPriceSetting = await getPoapSettingByName('gas-price');
  if (gasPriceSetting) {
    gasPrice = parseInt(gasPriceSetting.value);
  }

  return gasPrice;
}

export async function getTxObj(onlyAdminSigner: boolean, extraParams?: any) {
  const env = getEnv();
  let estimate_mint_gas = 1;
  let signerWallet: Wallet;

  // Use extraParams signer if it's specified in extraParams 
  if (extraParams && extraParams.signer) {
    signerWallet = await getSignerWallet(extraParams.signer.toLowerCase());
  } else if (onlyAdminSigner) {
    signerWallet = env.poapAdmin;
  } else {
    const helperWallet = await getHelperSigner();
    console.log('----------------------------')
    console.log('helperWallet: ', helperWallet)
    console.log('----------------------------')
    signerWallet = helperWallet ? helperWallet : env.poapAdmin;
  }

  const contract = getContract(signerWallet);

  let gasPrice;
  if (extraParams && extraParams.gas_price) {
    gasPrice = extraParams.gas_price
  } else {
    gasPrice = await getCurrentGasPrice(signerWallet.address);
  }

  if (extraParams && extraParams.estimate_mint_gas) {
    estimate_mint_gas = extraParams.estimate_mint_gas
  }

  const transactionParams: any = {
    gasLimit: estimateMintingGas(estimate_mint_gas),
    gasPrice: Number(gasPrice),
  };

  if (extraParams && extraParams.nonce) {
    transactionParams.nonce = extraParams.nonce;
  }

  return {
    signerWallet: signerWallet,
    contract: contract,
    transactionParams: transactionParams,
  };
  
}

export async function mintToken(eventId: number, toAddr: Address, awaitTx: boolean = true, extraParams?: any): Promise<ContractTransaction> {
  const txObj = await getTxObj(false, extraParams);

  const tx = await txObj.contract.functions.mintToken(eventId, toAddr, txObj.transactionParams);

  if (tx.hash) {
    await saveTransaction(
      tx.hash,
      tx.nonce,
      OperationType.mintToken,
      JSON.stringify([eventId, toAddr]),
      txObj.signerWallet.address,
      TransactionStatus.pending,
      txObj.transactionParams.gasPrice.toString()
    );
  }

  console.log(`mintToken: Transaction: ${tx.hash}`);

  // The operation is NOT complete yet; we must wait until it is mined
  if(awaitTx){
    await tx.wait();
  }

  console.log(`mintToken: Finished: ${tx.hash}`);

  return tx
}

export async function bumpTransaction(hash: string, gasPrice: string) {
  const transaction = await getTransaction(hash);
  if (!transaction) {
    throw new Error('Transaction was not found');
  }
  // Parse available arguments saved in the database
  const txJSON = JSON.parse(transaction.arguments)

  switch (transaction.operation) {
    case OperationType.burnToken: {
      const [tokenId] = txJSON
      await burnToken(tokenId, {
        signer: transaction.signer,
        gas_price: gasPrice,
        nonce: transaction.nonce
      })
    }
    case OperationType.mintEventToManyUsers: {
      const [eventId, toAddresses] = txJSON
      await mintEventToManyUsers(eventId, toAddresses, {
        signer: transaction.signer,
        gas_price: gasPrice,
        nonce: transaction.nonce
      })
      break;
    }
    case OperationType.mintToken: {
      const [eventId, toAddr] = txJSON
      await mintToken(eventId, toAddr, true, {
        signer: transaction.signer,
        gas_price: gasPrice,
        nonce: transaction.nonce
      })
      break;
    }
    case OperationType.mintUserToManyEvents: {
      const [eventIds, toAddr] = txJSON
      await mintUserToManyEvents(eventIds, toAddr, {
        signer: transaction.signer,
        gas_price: gasPrice,
        nonce: transaction.nonce
      })
      break;
    }
    default: {
      throw new Error('Operation not supported');
    }
  }
}

export async function mintEventToManyUsers(eventId: number, toAddr: Address[], extraParams?: any) {
  const txObj = await getTxObj(true, extraParams);

  const tx = await txObj.contract.functions.mintEventToManyUsers(eventId, toAddr, txObj.transactionParams);

  if (tx.hash) {
    await saveTransaction(
      tx.hash,
      tx.nonce,
      OperationType.mintEventToManyUsers,
      JSON.stringify([eventId, toAddr]),
      txObj.signerWallet.address,
      TransactionStatus.pending,
      txObj.transactionParams.gasPrice.toString()
    );
  }

  console.log(`mintTokenBatch: Transaction: ${tx.hash}`);

  // The operation is NOT complete yet; we must wait until it is mined
  // await tx.wait();
  // console.log(`mintTokenBatch: Finished ${tx.hash}`);
}

export async function mintUserToManyEvents(eventIds: number[], toAddr: Address, extraParams?: any) {
  const txObj = await getTxObj(true, extraParams);
  const tx = await txObj.contract.functions.mintUserToManyEvents(eventIds, toAddr, txObj.transactionParams);

  if (tx.hash) {
    await saveTransaction(
      tx.hash,
      tx.nonce,
      OperationType.mintUserToManyEvents,
      JSON.stringify({ eventIds, toAddr }),
      txObj.signerWallet.address,
      TransactionStatus.pending,
      txObj.transactionParams.gasPrice.toString()
    );
  }

  console.log(`mintTokenBatch: Transaction: ${tx.hash}`);

  // The operation is NOT complete yet; we must wait until it is mined
  // await tx.wait();
  // console.log(`mintTokenBatch: Finished ${tx.hash}`);
}

export async function burnToken(tokenId: string | number, extraParams?: any): Promise<boolean> {
  const txObj = await getTxObj(true, extraParams);

  // Set a new Value, which returns the transaction
  const tx = await txObj.contract.functions.burn(tokenId, txObj.transactionParams);

  if (tx.hash) {
    await saveTransaction(
      tx.hash,
      tx.nonce,
      OperationType.burnToken,
      tokenId.toString(),
      txObj.signerWallet.address,
      TransactionStatus.pending,
      txObj.transactionParams.gasPrice.toString()
    );
  }

  console.log(`burn: Transaction: ${tx.hash}`);

  // The operation is NOT complete yet; we must wait until it is mined
  await tx.wait();
  console.log(`burn: Finished ${tx.hash}`);
  return true;
}

export async function getAllTokens(address: Address): Promise<TokenInfo[]> {
  const events = await getEvents();

  const getEvent = (id: number) => {
    const ev = events.find(e => e.id === id);
    if (!ev) {
      throw new Error(`Invalid EventId: ${id}`);
    }
    return ev;
  };

  const env = getEnv();
  const contract = getContract(env.poapAdmin);
  const tokensAmount = (await contract.functions.balanceOf(address)).toNumber();

  const tokens: TokenInfo[] = [];
  for (let i = 0; i < tokensAmount; i++) {
    const { tokenId, eventId } = await contract.functions.tokenDetailsOfOwnerByIndex(address, i);
    tokens.push({
      event: getEvent(eventId.toNumber()),
      tokenId: tokenId.toString(),
      owner: address,
    });
  }
  return tokens;
}

export async function getTokenInfo(tokenId: string | number): Promise<TokenInfo> {
  const env = getEnv();
  const contract = getContract(env.poapAdmin);
  const eventId = await contract.functions.tokenEvent(tokenId);
  const owner = await contract.functions.ownerOf(tokenId);
  const event = await getEvent(eventId.toNumber());
  if (!event) {
    throw new Error('Invalid Event Id');
  }
  return {
    event,
    tokenId: tokenId.toString(),
    owner,
  };
}

export async function verifyClaim(claim: Claim): Promise<string | boolean> {
  const event = await getEvent(claim.eventId);

  if (!event) {
    throw new Error('Invalid Event Id');
  }

  Logger.info({ claim }, 'Claim for event: %d from: %s', claim.eventId, claim.claimer);

  const claimerMessage = JSON.stringify([claim.claimId, claim.eventId, claim.claimer, claim.proof]);

  Logger.info({ claimerMessage }, 'claimerMessage');

  const supposedClaimedAddress = verifyMessage(claimerMessage, claim.claimerSignature);

  if (supposedClaimedAddress !== claim.claimer) {
    console.log('invalid claimer signature');
    return false;
  }

  const proofMessage = JSON.stringify([claim.claimId, claim.eventId, claim.claimer]);
  Logger.info({ proofMessage }, 'proofMessage');
  const signerAddress = verifyMessage(proofMessage, claim.proof);

  if (signerAddress !== event.signer) {
    console.log('invalid signer signature');
    return false;
  }

  return true;
}

export async function getAddressBalance(signer: Signer): Promise<Signer> {
  let provider = getDefaultProvider();
  let balance = await provider.getBalance(signer.signer);

  signer.balance = balance.toString();

  return signer;
}

export async function resolveName(name: string): Promise<string> {
  const mainnetProvider = getDefaultProvider('homestead');
  const resolvedAddress = await mainnetProvider.resolveName(name);
  return resolvedAddress
}

export async function lookupAddress(address: string): Promise<string> {
  const mainnetProvider = getDefaultProvider('homestead');
  const resolved = await mainnetProvider.lookupAddress(address);
  return resolved
}

export async function checkAddress(address: string): Promise<string | null> {
  let response:string | null = null;
  try {
    response = await utils.getAddress(address);
  }
  catch(error) {
    try {
      response = await resolveName(address)
    }
    catch(error) {
      return response;
    }
  }
  return response;
}

export async function checkHasToken(event_id:number, address: string): Promise<boolean> {
  const all_tokens = await getAllTokens(address);
  let token = all_tokens.find(token => token.event.id === event_id);
  return !!token;
}
