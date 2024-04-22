import { TransactionRequest } from '@ethersproject/providers';
import Logger from '../logger/logger';
import Batcher from './batcher';
import { Runtime } from './runtimes';
import { senderAccount, Signer } from './signer';
import { SingleBar } from 'cli-progress';

class EngineContext {
    accountIndexes: number[];
    numOfTxPerAccount: number;
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
        this.numOfTxPerAccount = numTxs;
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
        const totalNumOfTxs = ctx.accountIndexes.length*ctx.numOfTxPerAccount;

        // Get the account metadata
        const accounts: senderAccount[] = await signer.getSenderAccounts(ctx.accountIndexes, totalNumOfTxs);

        // Construct the transactions
        let rawTransactions: Map<string, string[]> =
            await runtime.ConstructTransactions(accounts, ctx.numOfTxPerAccount, ctx.dynamic);

        // Sign the transactions
        // const signedTransactions = await signer.signTransactions(
        //     accounts,
        //     rawTransactions
        // );

        Logger.title(runtime.GetStartMessage());

        // if (ctx.batchSize === 1) {
            // Send the transactions one-by-one but in parallel by sender
            return Batcher.sendTransactionsInParallel(
                rawTransactions,
                totalNumOfTxs,
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
