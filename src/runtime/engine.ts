import { TransactionRequest } from '@ethersproject/providers';
import Logger from '../logger/logger';
import Batcher from './batcher';
import { Runtime } from './runtimes';
import { senderAccount, Signer } from './signer';

class EngineContext {
    accountIndexes: number[];
    numTxs: number;
    batchSize: number;

    mnemonic: string;
    url: string;

    dynamic: boolean;

    constructor(
        accountIndexes: number[],
        numTxs: number,
        batchSize: number,
        mnemonic: string,
        url: string,
        dynamic: boolean,
    ) {
        this.accountIndexes = accountIndexes;
        this.numTxs = numTxs;
        this.batchSize = batchSize;

        this.mnemonic = mnemonic;
        this.url = url;

        this.dynamic = dynamic;
    }
}

class Engine {
    static async Run(runtime: Runtime, ctx: EngineContext): Promise<string[]> {
        // Initialize transaction signer
        const signer: Signer = new Signer(ctx.mnemonic, ctx.url);

        // Get the account metadata
        const accounts: senderAccount[] = await signer.getSenderAccounts(
            ctx.accountIndexes,
            ctx.numTxs
        );

        // Construct the transactions
        const rawTransactions: TransactionRequest[] =
            await runtime.ConstructTransactions(accounts, ctx.numTxs, ctx.dynamic);

        // Sign the transactions
        const signedTransactions = await signer.signTransactions(
            accounts,
            rawTransactions
        );

        Logger.title(runtime.GetStartMessage());

        // if (ctx.batchSize === 1) {
            // Send the transactions one-by-one but in parallel by sender
            return Batcher.sendTransactionsInParallelBySender(
                signedTransactions,
                ctx.numTxs,
                ctx.url,
            );
       // } 

        // // Send the transactions in batches
        // return Batcher.batchTransactions(
        //     // Convert Map to array
        //     Array.from(signedTransactions.values()).flat(),
        //     ctx.batchSize,
        //     ctx.url,
        //     true
        // );
    }
}

export { Engine, EngineContext };
