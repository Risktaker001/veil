import {
    Keypair,
    TransactionBuilder,
    Operation,
    Asset,
    Claimant,
    Horizon,
    Networks,
} from '@stellar/stellar-sdk';
import { inclusionFee } from './fees';
import { resolveSigner, signWith, type SignerInput, type TransactionSigner } from './signer';

export type EscrowConfig = {
    /** Stellar Horizon REST API base URL (e.g. "https://horizon-testnet.stellar.org").
     *  Must be a Horizon URL — NOT a Soroban RPC endpoint. */
    horizonUrl: string;
    networkPassphrase: string;
};

export type CreateEscrowOptions = {
    /** Signs the escrow-creating transaction; the secret stays with the caller. */
    sender?: TransactionSigner;
    /** @deprecated Use `sender`. A Keypair puts a secret in the calling process. */
    senderKeypair?: Keypair;
    recipientAddress: string;
    amount: string;
    asset: Asset;
    /** Duration in seconds from now before the sender can reclaim the balance. */
    claimDeadlineSeconds: number;
    /** Fee bid in stroops. Defaults to the network's inclusion-fee policy. */
    fee?: string;
    config: EscrowConfig;
};

export type EscrowResult = {
    balanceId: string;
    claimLink: string;
    expiresAt: number;
    txHash: string;
    feeCharged?: string;
};

export type ClaimOptions = {
    /** Signs the claim transaction; the secret stays with the caller. */
    claimant?: TransactionSigner;
    /** @deprecated Use `claimant`. A Keypair puts a secret in the calling process. */
    claimantKeypair?: Keypair;
    balanceId: string;
    fee?: string;
    config: EscrowConfig;
};

export type ReclaimOptions = {
    /** Signs the reclaim transaction; the secret stays with the caller. */
    sender?: TransactionSigner;
    /** @deprecated Use `sender`. A Keypair puts a secret in the calling process. */
    senderKeypair?: Keypair;
    balanceId: string;
    fee?: string;
    config: EscrowConfig;
};

function transactionFee(fee: string | undefined, config: EscrowConfig): string {
    return fee ?? inclusionFee(config.networkPassphrase === Networks.PUBLIC ? 'mainnet' : 'testnet');
}

function isAmbiguousSubmission(error: unknown): error is Error {
    if (!(error instanceof Error)) return false;
    const status = (error as Error & { response?: { status?: number } }).response?.status;
    return status === undefined || status >= 500;
}

function pickSigner(callback: TransactionSigner | undefined, legacy: Keypair | undefined, name: string): SignerInput {
    const chosen = callback ?? legacy;
    if (!chosen) throw new Error(`A ${name} signer is required.`);
    return chosen;
}

export function buildClaimLink(balanceId: string): string {
    return `https://app.veil.xyz/claim/${balanceId}`;
}

/**
 * Build the two Stellar Claimant entries for an escrow balance:
 *  - recipient: may claim unconditionally at any time.
 *  - sender: may reclaim ONLY after `deadlineUnix` (unix timestamp).
 *
 * A Stellar claimable balance is consumed by the first successful claim.
 * Once either party claims, the balance is gone — the other party's subsequent
 * claim will be rejected by the Stellar network. Design UIs accordingly.
 */
export function buildEscrowClaimants(
    recipientAddress: string,
    senderAddress: string,
    deadlineUnix: number
): Claimant[] {
    if (!Number.isSafeInteger(deadlineUnix) || deadlineUnix <= 0) {
        throw new Error('The claim deadline must be a positive Unix timestamp.');
    }
    const recipientClaimant = new Claimant(recipientAddress, Claimant.predicateUnconditional());
    const senderClaimant = new Claimant(
        senderAddress,
        Claimant.predicateNot(Claimant.predicateBeforeAbsoluteTime(deadlineUnix.toString()))
    );
    return [recipientClaimant, senderClaimant];
}

/** XLM reserved for the two claimants while a claimable balance exists. */
export function claimableBalanceReserveXlm(baseReserveXlm = 0.5): number {
    if (!Number.isFinite(baseReserveXlm) || baseReserveXlm < 0) {
        throw new Error('The base reserve must be a finite non-negative number.');
    }
    return 2 * baseReserveXlm;
}

/**
 * Create a Stellar claimable balance escrow.
 *
 * The recipient may claim immediately (unconditional predicate).
 * The sender may reclaim after `claimDeadlineSeconds` has elapsed.
 * Claim and reclaim are mutually exclusive — the first successful claim
 * consumes the balance.
 *
 * @throws If submission fails or Horizon returns a different transaction hash.
 */
export async function createEscrow(options: CreateEscrowOptions): Promise<EscrowResult> {
    const { recipientAddress, amount, asset, claimDeadlineSeconds, config } = options;
    if (!Number.isSafeInteger(claimDeadlineSeconds) || claimDeadlineSeconds <= 0) {
        throw new Error('claimDeadlineSeconds must be a positive integer.');
    }
    const signer = resolveSigner(pickSigner(options.sender, options.senderKeypair, 'sender'));
    const server = new Horizon.Server(config.horizonUrl);

    const account = await server.loadAccount(signer.publicKey);
    const expiresAt = Math.floor(Date.now() / 1000) + claimDeadlineSeconds;

    const claimants = buildEscrowClaimants(recipientAddress, signer.publicKey, expiresAt);

    const tx = new TransactionBuilder(account, {
        fee: transactionFee(options.fee, config),
        networkPassphrase: config.networkPassphrase,
    })
        .addOperation(
            Operation.createClaimableBalance({
                asset,
                amount,
                claimants,
            })
        )
        .setTimeout(180)
        .build();

    const balanceId = tx.getClaimableBalanceId(0);
    const signedTx = await signWith(tx, signer, config.networkPassphrase);
    const transactionHash = signedTx.hash().toString('hex');

    const result = await server.submitTransaction(signedTx).catch((error: unknown) => {
        if (isAmbiguousSubmission(error)) {
            Object.assign(error, { balanceId, txHash: transactionHash, expiresAt });
        }
        throw error;
    });
    if (result.hash !== transactionHash) {
        throw Object.assign(
            new Error('Horizon returned a different transaction hash for the claimable-balance creation.'),
            { balanceId, txHash: transactionHash, expiresAt },
        );
    }
    return {
        balanceId,
        claimLink: buildClaimLink(balanceId),
        expiresAt,
        txHash: result.hash,
        feeCharged: (result as unknown as { fee_charged?: string }).fee_charged,
    };
}

/**
 * Claim a claimable balance as the recipient.
 *
 * Once claimed the balance is consumed. A subsequent reclaimEscrow() call
 * by the sender will be rejected by the Stellar network.
 */
export async function claimEscrow(options: ClaimOptions): Promise<{ txHash: string; feeCharged?: string }> {
    const { balanceId, config } = options;
    const signer = resolveSigner(pickSigner(options.claimant, options.claimantKeypair, 'claimant'));
    const server = new Horizon.Server(config.horizonUrl);

    const account = await server.loadAccount(signer.publicKey);

    const tx = new TransactionBuilder(account, {
        fee: transactionFee(options.fee, config),
        networkPassphrase: config.networkPassphrase,
    })
        .addOperation(Operation.claimClaimableBalance({ balanceId }))
        .setTimeout(180)
        .build();

    const signedTx = await signWith(tx, signer, config.networkPassphrase);
    const transactionHash = signedTx.hash().toString('hex');

    const result = await server.submitTransaction(signedTx).catch((error: unknown) => {
        if (isAmbiguousSubmission(error)) {
            Object.assign(error, { balanceId, txHash: transactionHash });
        }
        throw error;
    });
    if (result.hash !== transactionHash) {
        throw Object.assign(
            new Error('Horizon returned a different transaction hash for the claimable-balance claim.'),
            { balanceId, txHash: transactionHash },
        );
    }
    return { txHash: result.hash, feeCharged: (result as unknown as { fee_charged?: string }).fee_charged };
}

/**
 * Reclaim a claimable balance as the sender after the deadline has passed.
 *
 * Will be rejected by the Stellar network if called before `expiresAt` or
 * if the recipient has already claimed the balance.
 */
export async function reclaimEscrow(options: ReclaimOptions): Promise<{ txHash: string; feeCharged?: string }> {
    const { balanceId, config } = options;
    const signer = resolveSigner(pickSigner(options.sender, options.senderKeypair, 'sender'));
    const server = new Horizon.Server(config.horizonUrl);

    const account = await server.loadAccount(signer.publicKey);

    const tx = new TransactionBuilder(account, {
        fee: transactionFee(options.fee, config),
        networkPassphrase: config.networkPassphrase,
    })
        .addOperation(Operation.claimClaimableBalance({ balanceId }))
        .setTimeout(180)
        .build();

    const signedTx = await signWith(tx, signer, config.networkPassphrase);
    const transactionHash = signedTx.hash().toString('hex');

    const result = await server.submitTransaction(signedTx).catch((error: unknown) => {
        if (isAmbiguousSubmission(error)) {
            Object.assign(error, { balanceId, txHash: transactionHash });
        }
        throw error;
    });
    if (result.hash !== transactionHash) {
        throw Object.assign(
            new Error('Horizon returned a different transaction hash for the claimable-balance reclaim.'),
            { balanceId, txHash: transactionHash },
        );
    }
    return { txHash: result.hash, feeCharged: (result as unknown as { fee_charged?: string }).fee_charged };
}
