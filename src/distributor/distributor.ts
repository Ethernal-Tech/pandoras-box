import { BigNumber } from '@ethersproject/bignumber';
import { JsonRpcProvider, Provider, TransactionRequest } from '@ethersproject/providers';
import { formatEther } from '@ethersproject/units';
import { Wallet } from '@ethersproject/wallet';
import { SingleBar } from 'cli-progress';
import Table from 'cli-table3';
import Heap from 'heap';
import Logger from '../logger/logger';
import { Runtime } from '../runtime/runtimes';
import DistributorErrors from './errors';
import Batcher from '../runtime/batcher';

class distributeAccount {
    missingFunds: BigNumber;
    address: string;
    mnemonicIndex: number;

    constructor(missingFunds: BigNumber, address: string, index: number) {
        this.missingFunds = missingFunds;
        this.address = address;
        this.mnemonicIndex = index;
    }
}

class runtimeCosts {
    accDistributionCost: BigNumber;
    subAccount: BigNumber;

    constructor(accDistributionCost: BigNumber, subAccount: BigNumber) {
        this.accDistributionCost = accDistributionCost;
        this.subAccount = subAccount;
    }
}

// Manages the fund distribution before each run-cycle
class Distributor {
    ethWallet: Wallet;
    mnemonic: string;
    provider: Provider;

    runtimeEstimator: Runtime;

    totalTx: number;
    requestedSubAccounts: number;
    readyMnemonicIndexes: number[];
    batchSize: number;

    constructor(
        mnemonic: string,
        subAccounts: number,
        totalTx: number,
        batchSize: number,
        runtimeEstimator: Runtime,
        url: string
    ) {
        this.requestedSubAccounts = subAccounts;
        this.totalTx = totalTx;
        this.mnemonic = mnemonic;
        this.batchSize = batchSize;
        this.runtimeEstimator = runtimeEstimator;
        this.readyMnemonicIndexes = [];

        this.provider = new JsonRpcProvider(url);
        this.ethWallet = Wallet.fromMnemonic(
            mnemonic,
            `m/44'/60'/0'/0/0`
        ).connect(this.provider);
    }

    async distribute(): Promise<number[]> {
        Logger.title('💸 Fund distribution initialized 💸');

        const baseCosts = await this.calculateRuntimeCosts();
        this.printCostTable(baseCosts);

        // Check if there are any addresses that need funding
        const shortAddresses = await this.findAccountsForDistribution(
            baseCosts.subAccount
        );

        const initialAccCount = shortAddresses.size();

        if (initialAccCount == 0) {
            // Nothing to distribute
            Logger.success('Accounts are fully funded for the cycle');

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

    async calculateRuntimeCosts(): Promise<runtimeCosts> {
        const inherentValue = this.runtimeEstimator.GetValue();
        const baseTxEstimate = await this.runtimeEstimator.EstimateBaseTx();
        const baseGasPrice = await this.runtimeEstimator.GetGasPrice();

        // add some more tokens to base tx cost if london fork is enabled,
        // since base fee dynamically expands
        const baseTxCost = baseGasPrice.mul(baseTxEstimate).add(inherentValue).mul(10);

        // Calculate how much each sub-account needs
        // to execute their part of the run cycle.
        // Each account needs at least numTx * (gasPrice * gasLimit + value)
        const subAccountCost = BigNumber.from(this.totalTx).mul(baseTxCost);

        // Calculate the cost of the single distribution transaction
        const singleDistributionCost = await this.provider.estimateGas({
            from: Wallet.fromMnemonic(this.mnemonic, `m/44'/60'/0'/0/0`)
                .address,
            to: Wallet.fromMnemonic(this.mnemonic, `m/44'/60'/0'/0/1`).address,
            value: subAccountCost,
        });

        return new runtimeCosts(singleDistributionCost, subAccountCost);
    }

    async findAccountsForDistribution(
        singleRunCost: BigNumber
    ): Promise<Heap<distributeAccount>> {
        const balanceBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });

        Logger.info('\nFetching sub-account balances...');

        const shortAddresses = new Heap<distributeAccount>();

        balanceBar.start(this.requestedSubAccounts, 0, {
            speed: 'N/A',
        });

        for (let i = 1; i <= this.requestedSubAccounts; i++) {
            const addrWallet = Wallet.fromMnemonic(
                this.mnemonic,
                `m/44'/60'/0'/0/${i}`
            ).connect(this.provider);

            const balance = await addrWallet.getBalance();
            balanceBar.increment();

            if (balance.lt(singleRunCost)) {
                // Address doesn't have enough funds, make sure it's
                // on the list to get topped off
                shortAddresses.push(
                    new distributeAccount(
                        singleRunCost.sub(balance),
                        addrWallet.address,
                        i
                    )
                );

                continue;
            }

            // Address has enough funds already, mark it as ready
            this.readyMnemonicIndexes.push(i);
        }

        balanceBar.stop();

        return shortAddresses;
    }

    printCostTable(costs: runtimeCosts) {
        Logger.info('\nCycle Cost Table:');
        const costTable = new Table({
            head: ['Name', 'Cost [eth]'],
        });

        costTable.push(
            ['Required acc. balance', formatEther(costs.subAccount)],
            ['Single distribution cost', formatEther(costs.accDistributionCost)]
        );

        Logger.info(costTable.toString());
    }

    async getFundableAccounts(
        costs: runtimeCosts,
        initialSet: Heap<distributeAccount>
    ): Promise<distributeAccount[]> {
        // Check if the root wallet has enough funds to distribute
        const accountsToFund: distributeAccount[] = [];
        let distributorBalance = BigNumber.from(
            await this.ethWallet.getBalance()
        );

        while (
            distributorBalance.gt(costs.accDistributionCost) &&
            initialSet.size() > 0
        ) {
            const acc = initialSet.pop() as distributeAccount;
            distributorBalance = distributorBalance.sub(acc.missingFunds);

            accountsToFund.push(acc);
        }

        // Check if there are accounts to fund
        if (accountsToFund.length == 0) {
            throw DistributorErrors.errNotEnoughFunds;
        }

        return accountsToFund;
    }

    async fundAccounts(costs: runtimeCosts, accounts: distributeAccount[]) {
        Logger.info('\nFunding accounts...');

        const gasPrice = await this.ethWallet.getGasPrice();
        const chainID = await this.ethWallet.getChainId();
        let nonce = await this.ethWallet.getTransactionCount();

        const signedTxs: string[] = [];
        for (const acc of accounts) {
            const tx: TransactionRequest = {
                from: this.ethWallet.address,
                chainId: chainID,
                to: acc.address,
                gasPrice: BigNumber.from(gasPrice).mul(150).div(100),
                gasLimit: 21000,
                value: acc.missingFunds,
                nonce: nonce,
            };

            signedTxs.push(await this.ethWallet.signTransaction(tx));
            nonce++;
        }

        const txHashes = await Batcher.batchTransactions(signedTxs, this.batchSize, 
            (this.provider as JsonRpcProvider).connection.url, false);

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
                const txReceipt = await this.provider.waitForTransaction(
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
            Logger.warn('Errors encountered during funding of sub accounts:');

            for (const err of waitErrors) {
                Logger.error(err);
            }
        }
    }
}

export { Distributor, Runtime, distributeAccount };
