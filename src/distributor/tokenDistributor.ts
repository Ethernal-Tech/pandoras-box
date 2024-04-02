import { BigNumber } from '@ethersproject/bignumber';
import { Wallet } from '@ethersproject/wallet';
import { SingleBar } from 'cli-progress';
import Table from 'cli-table3';
import Heap from 'heap';
import Logger from '../logger/logger';
import { TokenRuntime } from '../runtime/runtimes';
import { distributeAccount } from './distributor';
import DistributorErrors from './errors';
import Batcher from '../runtime/batcher';
import { JsonRpcProvider } from '@ethersproject/providers';

class tokenRuntimeCosts {
    totalCost: number;
    subAccount: number;

    constructor(totalCost: number, subAccount: number) {
        this.totalCost = totalCost;
        this.subAccount = subAccount;
    }
}

class TokenDistributor {
    mnemonic: string;
    url: string;

    tokenRuntime: TokenRuntime;

    totalTx: number;
    readyMnemonicIndexes: number[];

    batchSize: number;

    constructor(
        mnemonic: string,
        url: string,
        readyMnemonicIndexes: number[],
        totalTx: number,
        tokenRuntime: TokenRuntime,
        batchSize: number,
    ) {
        this.url = url;
        this.totalTx = totalTx;
        this.mnemonic = mnemonic;
        this.batchSize = batchSize;
        this.tokenRuntime = tokenRuntime;
        this.readyMnemonicIndexes = readyMnemonicIndexes;
    }

    async distributeTokens(): Promise<number[]> {
        Logger.title('\n🪙 Token distribution initialized 🪙');

        const baseCosts = await this.calculateRuntimeCosts();
        this.printCostTable(baseCosts);

        // Check if there are any addresses that need funding
        const shortAddresses = await this.findAccountsForDistribution(
            baseCosts.subAccount
        );

        const initialAccCount = shortAddresses.size();

        if (initialAccCount == 0) {
            // Nothing to distribute
            Logger.success(
                'Accounts are fully funded with tokens for the cycle'
            );

            return this.readyMnemonicIndexes;
        }

        // Get a list of accounts that can be funded
        const fundableAccounts = await this.getFundableAccounts(
            baseCosts,
            shortAddresses
        );

        if (fundableAccounts.length != initialAccCount) {
            Logger.warn(
                `Unable to fund all sub-accounts. Funding ${fundableAccounts.length}`
            );
        }

        // Fund the accounts
        await this.fundAccounts(baseCosts, fundableAccounts);

        Logger.success('Fund distribution finished!');

        return this.readyMnemonicIndexes;
    }

    async calculateRuntimeCosts(): Promise<tokenRuntimeCosts> {
        const transferValue = this.tokenRuntime.GetTransferValue();

        const totalCost = transferValue * this.totalTx;
        const subAccountCost = Math.ceil(
            totalCost / this.readyMnemonicIndexes.length
        );

        return new tokenRuntimeCosts(totalCost, subAccountCost);
    }

    async findAccountsForDistribution(
        singleRunCost: number
    ): Promise<Heap<distributeAccount>> {
        const balanceBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });

        Logger.info('\nFetching sub-account token balances...');

        const shortAddresses = new Heap<distributeAccount>();

        balanceBar.start(this.readyMnemonicIndexes.length, 0, {
            speed: 'N/A',
        });

        for (const index of this.readyMnemonicIndexes) {
            const addrWallet = Wallet.fromMnemonic(
                this.mnemonic,
                `m/44'/60'/0'/0/${index}`
            );

            const balance: number = await this.tokenRuntime.GetTokenBalance(
                addrWallet.address
            );
            balanceBar.increment();

            if (balance < singleRunCost) {
                // Address doesn't have enough funds, make sure it's
                // on the list to get topped off
                shortAddresses.push(
                    new distributeAccount(
                        BigNumber.from(singleRunCost - balance),
                        addrWallet.address,
                        index
                    )
                );
            }
        }

        balanceBar.stop();
        Logger.success('Fetched initial token balances');

        return shortAddresses;
    }

    printCostTable(costs: tokenRuntimeCosts) {
        Logger.info('\nCycle Token Cost Table:');
        const costTable = new Table({
            head: ['Name', `Cost [${this.tokenRuntime.GetTokenSymbol()}]`],
        });

        costTable.push(
            ['Required acc. token balance', costs.subAccount],
            ['Total token distribution cost', costs.totalCost]
        );

        Logger.info(costTable.toString());
    }

    async fundAccounts(
        costs: tokenRuntimeCosts,
        accounts: distributeAccount[]
    ) {
        Logger.info('\nFunding accounts with tokens...');

        // Clear the list of ready indexes
        this.readyMnemonicIndexes = [];

        const provider = new JsonRpcProvider(this.url);

        // Estimate a simple transfer transaction
        const gasEstimation = await this.tokenRuntime.EstimateBaseTx();  
        const senderWallet = Wallet.fromMnemonic(
            this.mnemonic,
            `m/44'/60'/0'/0/0`
        ).connect(provider);;

        const gasPrice = await senderWallet.getGasPrice();
        const chainID = await senderWallet.getChainId();
        let nonce = await senderWallet.getTransactionCount();
        const signedTxs: string[] = [];

        for (const acc of accounts) {
            let fundTx = await this.tokenRuntime.CreateFundTransaction(
                acc.address,
                acc.missingFunds.toNumber()
            );

            fundTx.gasLimit = BigNumber.from(gasEstimation).mul(150).div(100);
            fundTx.gasPrice = BigNumber.from(gasPrice).mul(150).div(100);;
            fundTx.nonce = nonce;
            fundTx.chainId = chainID;

            signedTxs.push(await senderWallet.signTransaction(fundTx));
            nonce++;
        }

        const txHashes = await Batcher.batchTransactions(signedTxs, this.batchSize, this.url, false);

        const fundBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });

        fundBar.start(accounts.length, 0, {
            speed: 'N/A',
        }); 

        const waitErrors: string[] = [];
        for (let i = 0; i < txHashes.length; i++) {
            const txHash = txHashes[i];
            try {
                const txReceipt = await provider.waitForTransaction(
                    txHash,
                    1,
                    60*1000, // 1min
                );
                fundBar.increment();

                if (txReceipt == null) {
                    throw new Error(
                    `transaction ${txHash} failed to be fetched in time`
                    );
                } else if (txReceipt.status != undefined && txReceipt.status == 0) {
                    throw new Error(
                    `transaction ${txHash} failed during execution`
                    );
                }

                this.readyMnemonicIndexes.push(accounts[i].mnemonicIndex);
            } catch (e: any) {
                waitErrors.push(e);
            }
        }

        fundBar.stop();

        if (waitErrors.length > 0) {
            Logger.warn('Errors encountered during funding of ERC20 tokens of sub accounts:');

            for (const err of waitErrors) {
                Logger.error(err);
            }
        }
    }

    async getFundableAccounts(
        costs: tokenRuntimeCosts,
        initialSet: Heap<distributeAccount>
    ): Promise<distributeAccount[]> {
        // Check if the root wallet has enough token funds to distribute
        const accountsToFund: distributeAccount[] = [];
        let distributorBalance = await this.tokenRuntime.GetSupplierBalance();
        Logger.info(`ERC20 Distributor balance: ${distributorBalance}`);

        while (distributorBalance > costs.subAccount && initialSet.size() > 0) {
            const acc = initialSet.pop() as distributeAccount;
            distributorBalance -= acc.missingFunds.toNumber();

            accountsToFund.push(acc);
        }

        // Check if the distributor has funds at all
        if (accountsToFund.length == 0) {
            throw DistributorErrors.errNotEnoughFunds;
        }

        return accountsToFund;
    }
}

export default TokenDistributor;
