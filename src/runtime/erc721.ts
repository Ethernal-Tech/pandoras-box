import { BigNumber } from '@ethersproject/bignumber';
import { Contract, ContractFactory } from '@ethersproject/contracts';
import {
    FeeData,
    JsonRpcProvider,
    Provider,
    TransactionRequest,
} from '@ethersproject/providers';
import { Wallet } from '@ethersproject/wallet';
import { SingleBar } from 'cli-progress';
import ZexNFTs from '../contracts/ZexNFTs.json';
import Logger from '../logger/logger';
import RuntimeErrors from './errors';
import { senderAccount } from './signer';

class ERC721Runtime {
    mnemonic: string;
    url: string;
    provider: Provider;

    gasEstimation: BigNumber = BigNumber.from(0);
    gasPrice: BigNumber = BigNumber.from(0);

    defaultValue: BigNumber = BigNumber.from(0);

    nftName = 'ZEXTokens';
    nftSymbol = 'ZEXes';
    nftURL = 'https://really-valuable-nft-page.io';

    contract: Contract | undefined;

    baseDeployer: Wallet;

    constructor(mnemonic: string, url: string) {
        this.mnemonic = mnemonic;
        this.provider = new JsonRpcProvider(url);
        this.url = url;

        this.baseDeployer = Wallet.fromMnemonic(
            this.mnemonic,
            `m/44'/60'/0'/0/0`
        ).connect(this.provider);
    }

    async Initialize() {
        this.contract = await this.deployERC721();
    }

    async deployERC721(): Promise<Contract> {
        const contractFactory = new ContractFactory(
            ZexNFTs.abi,
            ZexNFTs.bytecode,
            this.baseDeployer
        );

        const contract = await contractFactory.deploy(
            this.nftName,
            this.nftSymbol
        );

        await contract.deployTransaction.wait();

        return contract;
    }

    async EstimateBaseTx(): Promise<BigNumber> {
        if (!this.contract) {
            throw RuntimeErrors.errRuntimeNotInitialized;
        }

        // Estimate a simple transfer transaction
        this.gasEstimation = await this.contract.estimateGas.createNFT(
            this.nftURL
        );

        return this.gasEstimation;
    }

    GetNFTSymbol(): string {
        return this.nftSymbol;
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
        numTx: number,
        dynamic: boolean
    ): Promise<TransactionRequest[]> {
        if (!this.contract) {
            throw RuntimeErrors.errRuntimeNotInitialized;
        }

        const chainID = await this.baseDeployer.getChainId();
        const feeData = await this.provider.getFeeData();
        const gasPrice = this.gasPrice;

        Logger.info(`Chain ID: ${chainID}`);
        if (dynamic) {
            Logger.info('Dynamic fee data:');
            Logger.info(`Current max fee per gas: ${feeData.maxFeePerGas?.toHexString()}`);
            Logger.info(`Curent max priority fee per gas: ${feeData.maxPriorityFeePerGas?.toHexString()}`);
        } else {
            Logger.info(`Avg. gas price: ${gasPrice.toHexString()}`);
        }

        const constructBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });

        Logger.info(`\nConstructing ${this.nftName} mint transactions...`);
        constructBar.start(numTx, 0, {
            speed: 'N/A',
        });

        const transactions: TransactionRequest[] = [];
        const numAccounts = accounts.length;
        const txsPerAccount = Math.floor(numTx / numAccounts);
        const remainingTxs = numTx % numAccounts;

        for (let i = 0; i < numAccounts; i++) {
            const sender = accounts[i];
            const wallet = Wallet.fromMnemonic(
                this.mnemonic,
                `m/44'/60'/0'/0/${i}`
            ).connect(this.provider);

            for (let j = 0; j < txsPerAccount; j++) {
                const transaction = await this.createTransaction(wallet, sender, chainID, gasPrice, feeData, dynamic);
                transactions.push(transaction);

                sender.incrNonce();
                constructBar.increment();
            }
        }

        const sender = accounts[accounts.length - 1];
        const wallet = Wallet.fromMnemonic(
            this.mnemonic,
            `m/44'/60'/0'/0/${accounts.length - 1}`
        ).connect(this.provider);

        for (let i = 0; i < remainingTxs; i++) {
            const transaction = await this.createTransaction(wallet, sender, chainID, gasPrice, feeData, dynamic);
            transactions.push(transaction);

            sender.incrNonce();
            constructBar.increment();
        }

        constructBar.stop();
        Logger.success(`Successfully constructed ${numTx} transactions`);

        return transactions;
    }

    async createTransaction(
        wallet: Wallet, 
        sender: senderAccount, 
        chainID: number, 
        gasPrice: BigNumber,
        feeData: FeeData,
        dynamic: boolean = false
    ) : Promise<TransactionRequest> {
        const contract = new Contract(
            this.contract?.address as string,
            ZexNFTs.abi,
            wallet
        );

        const transaction = await contract.populateTransaction.createNFT(
            this.nftURL
        );

        // Override the defaults
        transaction.from = sender.getAddress();
        transaction.chainId = chainID;
        transaction.gasLimit = BigNumber.from(this.gasEstimation).mul(150).div(100);
        transaction.nonce = sender.getNonce();

        if (dynamic) {
            if (feeData.maxFeePerGas === undefined || feeData.maxPriorityFeePerGas === undefined) {
                throw new Error('Dynamic fee data not available');
            }

            const maxFeePerGas = BigNumber.from(feeData.maxFeePerGas).mul(2);
            const maxPriorityFeePerGas = BigNumber.from(feeData.maxPriorityFeePerGas).mul(2);

            transaction.maxFeePerGas = maxFeePerGas;
            transaction.maxPriorityFeePerGas = maxPriorityFeePerGas;
            transaction.type = 2; // dynamic fee type
        } else {
            transaction.gasPrice = BigNumber.from(gasPrice).mul(150).div(150);
        }

        return transaction;
    }

    GetStartMessage(): string {
        return '\n⚡️ ERC721 NFT mints initialized ️⚡️\n';
    }
}

export default ERC721Runtime;
