import axios from 'axios';
import { SingleBar } from 'cli-progress';
import Logger from '../logger/logger';

class Batcher {
    // Generates batches of items based on the passed in
    // input set
    static generateBatches<ItemType>(
        items: ItemType[],
        batchSize: number
    ): ItemType[][] {
        const batches: ItemType[][] = [];

        // Find the required number of batches
        let numBatches: number = Math.ceil(items.length / batchSize);
        if (numBatches == 0) {
            numBatches = 1;
        }

        // Initialize empty batches
        for (let i = 0; i < numBatches; i++) {
            batches[i] = [];
        }

        let currentBatch = 0;
        for (const item of items) {
            batches[currentBatch].push(item);

            if (batches[currentBatch].length % batchSize == 0) {
                currentBatch++;
            }
        }

        return batches;
    }

    static async sendTransactionsInParallelBySender(
        signedTxs: Map<string, string[]>,
        batchSize: number,
        url: string,
    ): Promise<string[]> {
        const batchBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });

        Logger.info('Sending transactions in parallel by sender...');

        batchBar.start(batchSize, 0, {
            speed: 'N/A',
        });

        const txHashes: string[] = [];
        const batchErrors: string[] = [];

        const startTime = performance.now();

        await Promise.all(Array.from(signedTxs.entries()).map(async ([address, txs]) => {
            for (const tx of txs) {
                const singleRequests = JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'eth_sendRawTransaction',
                    params: [tx],
                    id: 0,
                });

                await Batcher.sendTransactionWithRetry(url, singleRequests, batchErrors, txHashes, 3);

                batchBar.increment();
            }
        }));

        const endTime = performance.now();

        if (batchErrors.length > 0) {
            Logger.warn('Errors encountered during batch sending:');

            for (const err of batchErrors) {
                Logger.error(err);
            }
        }

        batchBar.stop();

        Logger.success(
            `All transactions have been sent in ` + (endTime - startTime) / 1000 + 's'
        );

        return txHashes;
    }

    static async batchTransactions(
        signedTxs: string[],
        batchSize: number,
        url: string,
        progressBar: boolean,
    ): Promise<string[]> {
        // Generate the transaction hash batches
        const batches: string[][] = Batcher.generateBatches<string>(
            signedTxs,
            batchSize
        );

        const batchBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });

        if (progressBar) {
            Logger.info('Sending transactions in batches...');

            batchBar.start(batches.length, 0, {
                speed: 'N/A',
            });
        }

        const txHashes: string[] = [];
        const batchErrors: string[] = [];

        try {
            let nextIndx = 0;

            for (const batch of batches) {
                let singleRequests = '';
                for (let i = 0; i < batch.length; i++) {
                    singleRequests += JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'eth_sendRawTransaction',
                        params: [batch[i]],
                        id: nextIndx++,
                    });

                    if (i != batch.length - 1) {
                        singleRequests += ',\n';
                    }
                }

                await Batcher.sendTransaction(url, singleRequests, batchErrors, txHashes);

                if (progressBar) {
                    batchBar.increment();
                }
            }
        } catch (e: any) {
            Logger.error(e.message);
        }

        if (batchErrors.length > 0) {
            Logger.warn('Errors encountered during batch sending:');

            for (const err of batchErrors) {
                Logger.error(err);
            }
        }

        if (progressBar) {
            batchBar.stop();

            Logger.success(
                `${batches.length} ${batches.length > 1 ? 'batches' : 'batch'} sent`
            );
        }

        return txHashes;
    }

    static async sendTransaction(url: string, singleRequests: string, batchErrors: string[], txHashes: string[]) {
        try {
            const response = await axios({
                url: url,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Connection': 'keep-alive', // Add this line to indicate keeping the TCP connection alive
                },
                data: '[' + singleRequests + ']',
            });

            const content = response.data;

            for (const cnt of content) {
                if (cnt.hasOwnProperty('error')) {
                    // Error occurred during batch sends
                    batchErrors.push(cnt.error.message);
                    continue;
                }

                txHashes.push(cnt.result);
            }

            //await new Promise(resolve => setTimeout(resolve, 10));
        } catch (e: any) {
            Logger.error(e.message);
            Batcher.sendTransaction(url, singleRequests, batchErrors, txHashes);
        }
    }

    static async sendTransactionWithRetry(url: string, singleRequests: string, batchErrors: string[], txHashes: string[], maxRetries: number = 3) {
        let retries = 0;
        while (retries < maxRetries) {
            try {
                const response = await axios({
                    url: url,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Connection': 'keep-alive',
                    },
                    data: '[' + singleRequests + ']',
                });

                const content = response.data;
                for (const cnt of content) {
                    if (cnt.hasOwnProperty('error')) {
                        // Error occurred during batch sends
                        batchErrors.push(cnt.error.message);
                        continue;
                    }
                    txHashes.push(cnt.result);
                }

                return; // Exit the function if successful
            } catch (e: any) {
                Logger.error(e.message);
                retries++;
            }
        }

        // If max retries reached, log an error
        Logger.error('Max retries reached. Failed to send transaction.');
    }
}

export default Batcher;
