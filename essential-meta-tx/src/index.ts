import {
  DefenderRelayProvider,
  DefenderRelaySigner,
} from 'defender-relay-client/lib/ethers';
import { RelayerParams } from 'defender-relay-client/lib/relayer';
import { BigNumber, Contract } from 'ethers';

import Forwarder from './abis/NFightGasStation.json';

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

async function relay(
  forwarder: Contract,
  request: ForwardRequest,
  signature: string,
) {
  // Validate request on the forwarder contract
  const valid = await forwarder.verify(
    { value: BigNumber.from(0), gas: 1e6, ...request },
    signature,
  );

  if (!valid) throw new Error(`Invalid request`);

  return await forwarder.execute(
    { value: BigNumber.from(0), gas: 1e6, ...request },
    signature,
    {
      gasLimit: 1e6,
      value: 0,
    },
  );
}

// Entrypoint for the Autotask
export async function handler(
  event: {
    request: { body: { request: ForwardRequest; signature: string } };
  } & RelayerParams,
) {
  // Parse webhook payload
  if (!event.request || !event.request.body) throw new Error(`Missing payload`);
  const { request, signature } = event.request.body;

  // Initialize Relayer provider and signer, and forwarder contract
  const credentials = { ...event };
  const provider = new DefenderRelayProvider(credentials);
  const signer = new DefenderRelaySigner(credentials, provider, {
    speed: 'fastest',
  });

  const forwarder = new Contract(Forwarder.address, Forwarder.abi, signer);

  // Relay transaction!
  const tx = await relay(forwarder, request, signature);
  console.log(`Sent meta-tx: ${tx.hash}`);
  return { txHash: tx.hash };
}
