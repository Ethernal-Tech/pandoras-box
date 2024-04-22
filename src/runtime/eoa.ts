import { BigNumber } from '@ethersproject/bignumber';
import {
    FeeData,
    JsonRpcProvider,
    Provider,
    TransactionRequest,
} from '@ethersproject/providers';
import { parseUnits } from '@ethersproject/units';
import { Wallet } from '@ethersproject/wallet';
import { SingleBar } from 'cli-progress';
import Logger from '../logger/logger';
import { senderAccount } from './signer';

class EOARuntime {
    mnemonic: string;
    url: string;
    provider: Provider;

    gasEstimation: BigNumber = BigNumber.from(0);
    gasPrice: BigNumber = BigNumber.from(0);

    // The default value for the E0A to E0A transfers
    // is 0.0001 native currency
    defaultValue: BigNumber = parseUnits('0.0001');

    feeData: FeeData | undefined;
    chainID: number = 100;

    constructor(mnemonic: string, url: string) {
        this.mnemonic = mnemonic;
        this.provider = new JsonRpcProvider(url);
        this.url = url;
    }

    async EstimateBaseTx(): Promise<BigNumber> {
        // EOA to EOA transfers are simple value transfers between accounts
        this.gasEstimation = await this.provider.estimateGas({
            from: Wallet.fromMnemonic(this.mnemonic, `m/44'/60'/0'/0/0`)
                .address,
            to: Wallet.fromMnemonic(this.mnemonic, `m/44'/60'/0'/0/1`).address,
            value: this.defaultValue,
        });

        const queryWallet = Wallet.fromMnemonic(
            this.mnemonic,
            `m/44'/60'/0'/0/0`
        ).connect(this.provider);

        this.chainID = await queryWallet.getChainId();
        this.feeData = await this.provider.getFeeData();

        return this.gasEstimation;
    }

    GetValue(): BigNumber {
        return this.defaultValue;
    }

    async GetGasPrice(): Promise<BigNumber> {
        this.gasPrice = await this.provider.getGasPrice();

        return this.gasPrice;
    }

    async ConstructTransactions(
        accounts: senderAccount[],
        numOfTxPerAccount: number,
        dynamic: boolean
    ): Promise<Map<string, string[]>> {

        const gasPrice = this.gasPrice;
        const totalNumOfTxs = accounts.length * numOfTxPerAccount;

        Logger.info(`Chain ID: ${this.chainID}`);

        if (dynamic) {
            Logger.info('Dynamic fee data:');
            Logger.info(`Current max fee per gas: ${this.feeData?.maxFeePerGas?.toHexString()}`);
            Logger.info(`Curent max priority fee per gas: ${this.feeData?.maxPriorityFeePerGas?.toHexString()}`);
        } else {
            Logger.info(`Avg. gas price: ${gasPrice.toHexString()}`);
        }

        const constructBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });

        Logger.info('\nConstructing value transfer transactions...')
        constructBar.start(totalNumOfTxs, 0, {
            speed: 'N/A',
        });

        const transactions: Map<string, string[]> = new Map();
        const numAccounts = accounts.length;

        for (let i = 0; i < numAccounts; i++) {
            const sender = accounts[i];

            const txs: string[] = [];
            for (let j = 0; j < numOfTxPerAccount; j++) {
                const receiverIndex = (i + j) % numAccounts;
                const receiver = accounts[receiverIndex];

                txs.push(
                    await sender.wallet.signTransaction(
                        await this.createTransferTransaction(sender, receiver, gasPrice, dynamic)
                    )
                );

                sender.incrNonce();
                constructBar.increment();
            }

            transactions.set(sender.getAddress(), txs);
        }

        constructBar.stop();
        Logger.success(`Successfully constructed ${totalNumOfTxs} transactions`);

        return transactions;
    }

    GetStartMessage(): string {
        return '\n⚡️ EOA to EOA transfers initialized ️⚡️\n';
    }

    createTransferTransaction(
        sender: senderAccount, 
        receiver: senderAccount, 
        gasPrice: BigNumber,
        dynamic: boolean = false
    ) : TransactionRequest {

        let transaction: TransactionRequest = {
            from: sender.getAddress(),
            chainId: this.chainID,
            to: receiver.getAddress(),
            gasLimit: this.gasEstimation,
            value: this.defaultValue,
            nonce: sender.getNonce(),
        };

        if (dynamic) {
            if (this.feeData?.maxFeePerGas === undefined || this.feeData?.maxPriorityFeePerGas === undefined) {
                throw new Error('Dynamic fee data not available');
            }

            const maxFeePerGas = BigNumber.from(this.feeData.maxFeePerGas).mul(2);
            const maxPriorityFeePerGas = BigNumber.from(this.feeData.maxPriorityFeePerGas).mul(2);

            transaction.maxFeePerGas = maxFeePerGas;
            transaction.maxPriorityFeePerGas = maxPriorityFeePerGas;
            transaction.type = 2; // dynamic fee type
        } else {
            transaction.gasPrice = gasPrice;
        }

        return transaction;
    }
}

export default EOARuntime;
