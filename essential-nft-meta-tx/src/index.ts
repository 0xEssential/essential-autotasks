import { InfuraProvider } from '@ethersproject/providers';
import {
  DefenderRelayProvider,
  DefenderRelaySigner,
} from 'defender-relay-client/lib/ethers';
import { RelayerParams } from 'defender-relay-client/lib/relayer';
import { Contract, utils } from 'ethers';

interface ForwardRequest {
  to: string;
  from: string;
  authorizer: string;
  nftContract: string;
  nonce: string;
  nftTokenId: string;
  nftChainId: string;
  targetChainId: string;
  data: string;
}

async function preflight(
  forwarder: Contract,
  request: ForwardRequest,
  signature: string,
) {
  // Validate request on the forwarder contract

  try {
    await forwarder.preflight(request, signature);

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

async function retrieveProof({ url, callData, forwarder }): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'durin_call',
      // use sender - can check later against signer of req
      params: { callData, to: forwarder.address, abi: forwarder.abi },
    }),
  });

  const body = await response.json();

  return body?.result;
}

// Entrypoint for the Autotask
export async function handler(
  event: {
    request: {
      body: {
        request: ForwardRequest;
        signature: string;
        forwarder: Record<string, any>;
      };
    };
    secrets: { infuraKey: string };
  } & RelayerParams,
) {
  // Parse webhook payload
  if (!event.request || !event.request.body) throw new Error(`Missing payload`);
  const { request, signature, forwarder } = event.request.body;

  // Initialize Relayer provider, signer and forwarder contract
  const credentials = { ...event };
  const provider = new DefenderRelayProvider(credentials);
  const signer = new DefenderRelaySigner(credentials, provider, {
    speed: 'fastest',
  });

  const { infuraKey } = event.secrets;

  const readProvider = new InfuraProvider(
    parseInt(request.targetChainId, 10),
    infuraKey,
  );
  const _forwarder = new Contract(
    forwarder.address,
    forwarder.abi,
    readProvider,
  );

  // Preflight transaction
  const { urls, callData, callbackFunction, extraData } = await preflight(
    _forwarder,
    request,
    signature,
  );

  // Fetch proof from error params
  const proof = await retrieveProof({ url: urls[0], callData, forwarder });

  if (!proof) throw Error('No proof');

  const abi = new utils.AbiCoder();

  const tx = await signer.sendTransaction({
    to: forwarder.address,
    data: utils.hexConcat([
      callbackFunction,
      abi.encode(['bytes', 'bytes'], [proof, extraData]),
    ]),
    // gasLimit: 150_000, we're around 160k now?
  });

  console.log(`Sent meta-tx: ${tx.hash}`);
  return { txHash: tx.hash };
}
