import { InfuraProvider } from '@ethersproject/providers';
import {
  DefenderRelayProvider,
  DefenderRelaySigner,
} from 'defender-relay-client/lib/ethers';
import { RelayerParams } from 'defender-relay-client/lib/relayer';
import { BigNumber, Contract, utils } from 'ethers';

import Forwarder from './abis/EssentialForwarder.json';

interface ForwardRequest {
  to: string;
  from: string;
  authorizer: string;
  nftContract: string;
  nonce: string;
  nftTokenId: BigNumber;
  nftChainId: BigNumber;
  targetChainId: BigNumber;
  data: string;
}

async function preflight(
  forwarder: Contract,
  request: ForwardRequest,
  signature: string,
) {
  // Validate request on the forwarder contract

  try {
    await forwarder.preflight(request, signature, {
      gasLimit: 10_000_000,
    });

    console.warn(`Preflight did not revert`);
  } catch (e) {
    if (e.code === utils.Logger.errors.CALL_EXCEPTION) {
      if (e.errorName === 'OffchainLookup') {
        const { sender, urls, callData, callbackFunction, extraData } =
          e.errorArgs;

        return { sender, urls, callData, callbackFunction, extraData };
      }
    }

    throw Error(e);
  }
}

async function retrieveProof({ url, callData }): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'durin_call',
      // use sender - can check later against signer of req
      params: { callData, to: Forwarder.address, abi: Forwarder.abi },
    }),
  });

  const body = await response.json();
  console.warn(body);
  return body?.result;
}

// Entrypoint for the Autotask
export async function handler(
  event: {
    request: { body: { request: ForwardRequest; signature: string } };
    secrets: { infuraKey: string };
  } & RelayerParams,
) {
  // Parse webhook payload
  if (!event.request || !event.request.body) throw new Error(`Missing payload`);
  const { request, signature } = event.request.body;

  // Initialize Relayer provider, signer and forwarder contract
  const credentials = { ...event };
  const provider = new DefenderRelayProvider(credentials);
  const signer = new DefenderRelaySigner(credentials, provider, {
    speed: 'fastest',
  });

  const { infuraKey } = event.secrets;

  const readProvider = new InfuraProvider(infuraKey, request.targetChainId);

  const _forwarder = new Contract(
    Forwarder.address,
    Forwarder.abi,
    readProvider,
  );

  const forwarder = Object.assign(_forwarder, {
    name: '0xEssential PlaySession',
  });

  // Preflight transaction
  const { urls, callData, callbackFunction, extraData } = await preflight(
    forwarder,
    request,
    signature,
  );

  // Fetch proof from error params
  const proof = await retrieveProof({ url: urls[0], callData });

  if (!proof) throw Error('No proof');

  const abi = new utils.AbiCoder();

  const tx = await signer.sendTransaction({
    to: forwarder.address,
    data: utils.hexConcat([
      callbackFunction,
      abi.encode(['bytes', 'bytes'], [proof, extraData]),
    ]),
    gasLimit: 150_000,
  });

  console.log(`Sent meta-tx: ${tx.hash}`);
  return { txHash: tx.hash };
}
