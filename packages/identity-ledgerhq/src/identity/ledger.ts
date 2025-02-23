import {
  CallRequest,
  Cbor,
  HttpAgentRequest,
  PublicKey,
  ReadRequest,
  Signature,
  SignIdentity,
} from '@dfinity/agent';
import { Principal } from '@dfinity/principal';
import DfinityApp, { ResponseSign } from '@zondax/ledger-dfinity';
import { Buffer } from 'buffer/';
import { Secp256k1PublicKey } from './secp256k1';

/**
 * Convert the HttpAgentRequest body into cbor which can be signed by the Ledger Hardware Wallet.
 * @param request - body of the HttpAgentRequest
 */
function _prepareCborForLedger(request: ReadRequest | CallRequest): ArrayBuffer {
  return Cbor.encode({ content: request });
}

/**
 * A Hardware Ledger Internet Computer Agent identity.
 */
export class LedgerIdentity extends SignIdentity {
  /**
   * Create a LedgerIdentity using the Web USB transport.
   * @param derivePath The derivation path.
   */
  public static async create(derivePath = `m/44'/223'/0'/0/0`): Promise<LedgerIdentity> {
    const TransportClass = (await import('@ledgerhq/hw-transport-webhid')).default;
    const transport = await TransportClass.create();
    const app = new DfinityApp(transport);

    const resp = await app.getAddressAndPubKey(derivePath);
    // This type doesn't have the right fields in it, so we have to manually type it.
    const principal = (resp as unknown as { principalText: string }).principalText;
    const publicKey = Secp256k1PublicKey.fromRaw(resp.publicKey);
    const address = resp.address;

    if (principal !== Principal.selfAuthenticating(new Uint8Array(publicKey.toDer())).toText()) {
      throw new Error('Principal returned by device does not match public key.');
    }

    return new this(app, derivePath, publicKey, address.buffer);
  }

  private constructor(
    private readonly _app: DfinityApp,
    public readonly derivePath: string,
    private readonly _publicKey: Secp256k1PublicKey,
    private readonly _address: ArrayBuffer,
  ) {
    super();
  }

  /**
   * Required by Ledger.com that the user should be able to press a Button in UI
   * and verify the address/pubkey are the same as on the device screen.
   */
  public async showAddressAndPubKeyOnDevice(): Promise<void> {
    await this._app.showAddressAndPubKey(this.derivePath);
  }

  public getPublicKey(): PublicKey {
    return this._publicKey;
  }

  public async sign(blob: ArrayBuffer): Promise<Signature> {
    // Force an `as any` because the types are compatible but TypeScript cannot figure it out.
    const resp: ResponseSign = await this._app.sign(this.derivePath, Buffer.from(blob) as any);
    const signatureRS = resp.signatureRS;
    if (!signatureRS) {
      throw new Error(
        `A ledger error happened during signature:\n` +
          `Code: ${resp.returnCode}\n` +
          `Message: ${JSON.stringify(resp.errorMessage)}\n`,
      );
    }

    if (signatureRS?.byteLength !== 64) {
      throw new Error(`Signature must be 64 bytes long (is ${signatureRS.length})`);
    }

    return signatureRS.buffer as Signature;
  }

  public async transformRequest(request: HttpAgentRequest): Promise<unknown> {
    const { body, ...fields } = request;
    const signature = await this.sign(_prepareCborForLedger(body));
    return {
      ...fields,
      body: {
        content: body,
        sender_pubkey: this._publicKey.toDer(),
        sender_sig: signature,
      },
    };
  }
}
